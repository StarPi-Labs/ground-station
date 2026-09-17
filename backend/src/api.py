"""JSON REST + websocket API for the ground station."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from config import config
from hub import Subscriber
from links import LinkError, UnknownCommand
from protocol import (
    ProtocolError,
    describe_enums,
    resolve_message_type,
    resolve_payload_type,
    resolve_source,
)
from station import Station

log = logging.getLogger(__name__)

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


# --- request/response models ---------------------------------------------------


class CommandRequest(BaseModel):
    name: str = Field(..., description="Command name, e.g. 'sensor_calibration'")
    args: dict[str, Any] = Field(default_factory=dict, description="Command arguments")
    link: str | None = Field(
        None, description="Link to send over ('ble', 'lora', ...); auto-selected when omitted"
    )


class PacketPage(BaseModel):
    total: int
    count: int
    limit: int
    offset: int
    packets: list[dict[str, Any]]


# --- app -----------------------------------------------------------------------


def create_app(station: Station | None = None) -> FastAPI:
    station = station or Station()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        await station.start()
        try:
            yield
        finally:
            await station.stop()

    app = FastAPI(
        title="StarPi Ground Station",
        description="Telemetry ingest, storage and command uplink for the StarPi rocket.",
        version="1.0.0",
        lifespan=lifespan,
    )
    app.state.station = station

    # The web page may be served from anywhere (dev server, another host).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def get_station() -> Station:
        return app.state.station

    # --- meta --------------------------------------------------------------

    @app.get("/api/health", tags=["meta"])
    async def health(st: Station = Depends(get_station)) -> dict[str, Any]:
        return {
            "status": "ok",
            "links": st.link_status(),
            "websocket_clients": st.hub.subscriber_count,
            "decode_errors": st.decode_errors,
        }

    @app.get("/api/enums", tags=["meta"])
    async def enums() -> dict[str, Any]:
        """Protocol enum names, bit flags and wire indices."""
        return describe_enums()

    @app.get("/api/links", tags=["meta"])
    async def links(st: Station = Depends(get_station)) -> dict[str, Any]:
        return {"links": st.link_status()}

    @app.get("/api/stats", tags=["meta"])
    async def stats(st: Station = Depends(get_station)) -> dict[str, Any]:
        return await st.db.stats()

    # --- packets -----------------------------------------------------------

    @app.get("/api/packets", response_model=PacketPage, tags=["packets"])
    async def list_packets(
        st: Station = Depends(get_station),
        limit: int = Query(100, ge=1, le=config.max_page_size),
        offset: int = Query(0, ge=0),
        src: list[str] = Query(default=[], description="Filter by source, repeatable"),
        type: list[str] = Query(default=[], description="Filter by message type, repeatable"),
        payload_type: list[str] = Query(default=[], description="Filter by payload type"),
        since_us: int | None = Query(None, description="Only packets at/after this µs timestamp"),
        until_us: int | None = Query(None, description="Only packets at/before this µs timestamp"),
        order: Literal["asc", "desc"] = Query("desc"),
    ) -> PacketPage:
        src_mask = _mask(src, resolve_source)
        type_mask = _mask(type, resolve_message_type)
        payload_mask = _mask(payload_type, resolve_payload_type)

        filters = {
            "src_mask": src_mask,
            "type_mask": type_mask,
            "payload_mask": payload_mask,
            "since_us": since_us,
            "until_us": until_us,
        }
        packets = await st.db.query_packets(limit=limit, offset=offset, order=order, **filters)
        total = await st.db.count_packets(**filters)
        return PacketPage(
            total=total, count=len(packets), limit=limit, offset=offset, packets=packets
        )

    @app.get("/api/packets/latest", tags=["packets"])
    async def latest_packets(st: Station = Depends(get_station)) -> dict[str, Any]:
        """The most recent packet of each message type."""
        packets = await st.db.latest_per_type()
        return {"packets": packets, "by_type": {p["type"]: p for p in packets}}

    @app.get("/api/packets/{packet_id}", tags=["packets"])
    async def get_packet(packet_id: int, st: Station = Depends(get_station)) -> dict[str, Any]:
        packet = await st.db.get_packet(packet_id)
        if packet is None:
            raise HTTPException(status_code=404, detail=f"no packet with id {packet_id}")
        return packet

    @app.delete("/api/packets", tags=["packets"])
    async def purge_packets(st: Station = Depends(get_station)) -> dict[str, Any]:
        deleted = await st.db.purge_packets()
        return {"deleted": deleted}

    # --- commands ----------------------------------------------------------

    @app.get("/api/commands/available", tags=["commands"])
    async def available_commands(st: Station = Depends(get_station)) -> dict[str, Any]:
        return {"commands": st.available_commands()}

    @app.get("/api/commands", tags=["commands"])
    async def list_commands(
        st: Station = Depends(get_station),
        limit: int = Query(100, ge=1, le=config.max_page_size),
        offset: int = Query(0, ge=0),
    ) -> dict[str, Any]:
        commands = await st.db.query_commands(limit=limit, offset=offset)
        return {"count": len(commands), "commands": commands}

    @app.post("/api/commands", status_code=202, tags=["commands"])
    async def send_command(
        request: CommandRequest, st: Station = Depends(get_station)
    ) -> dict[str, Any]:
        try:
            return await st.send_command(request.name, request.args, request.link)
        except UnknownCommand as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except LinkError as exc:
            # The link exists but could not deliver — the rocket is unreachable.
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.get("/api/commands/{command_id}", tags=["commands"])
    async def get_command(command_id: int, st: Station = Depends(get_station)) -> dict[str, Any]:
        command = await st.db.get_command(command_id)
        if command is None:
            raise HTTPException(status_code=404, detail=f"no command with id {command_id}")
        return command

    # --- live stream -------------------------------------------------------

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        """Pushes every decoded packet as ``{"event": "packet", "data": {...}}``.

        Query parameter ``backfill=N`` replays the last N packets on connect.
        """
        st: Station = websocket.app.state.station
        await websocket.accept()

        try:
            backfill = int(websocket.query_params.get("backfill", 20))
        except ValueError:
            backfill = 20

        subscriber = st.hub.subscribe()
        try:
            await websocket.send_json(
                {
                    "event": "hello",
                    "data": {
                        "links": st.link_status(),
                        "enums": describe_enums(),
                        "commands": st.available_commands(),
                    },
                }
            )
            for event in st.hub.recent(max(0, backfill)):
                await websocket.send_json(event)

            sender = asyncio.create_task(_pump(websocket, subscriber))
            receiver = asyncio.create_task(_drain(websocket))
            done, pending = await asyncio.wait(
                {sender, receiver}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc and not isinstance(exc, WebSocketDisconnect):
                    raise exc
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001 - one bad client must not take down the app
            log.exception("websocket client failed")
        finally:
            st.hub.unsubscribe(subscriber)

    # --- static web page ---------------------------------------------------

    if config.serve_web and os.path.isdir(WEB_DIR):
        app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")

    return app


# --- helpers -------------------------------------------------------------------


async def _pump(websocket: WebSocket, subscriber: Subscriber) -> None:
    while True:
        event = await subscriber.get()
        await websocket.send_json(event)


async def _drain(websocket: WebSocket) -> None:
    """Consume client messages so disconnects surface promptly; replies to pings."""
    while True:
        message = await websocket.receive_text()
        if message.strip().lower() in ("ping", '"ping"'):
            await websocket.send_json({"event": "pong"})


def _mask(values: list[str], resolver: Any) -> int | None:
    """OR together the bit flags named in a repeated query parameter."""
    mask = 0
    for value in values:
        for part in value.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                mask |= int(resolver(part))
            except ProtocolError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
    return mask or None
