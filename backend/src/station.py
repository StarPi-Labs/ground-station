"""The ground station: wires links, storage and the live stream together.

Ingest path for every frame, regardless of transport::

    Link -> Station.on_frame -> protocol.decode -> SQLite -> Hub -> websockets
"""

from __future__ import annotations

import logging
from typing import Any

from config import Config, config as default_config
from db import Database
from hub import Hub
from links import Link, LinkError, UnknownCommand, UnknownLink, create_link
from protocol import LogMessage, ProtocolError

log = logging.getLogger(__name__)


class Station:
    def __init__(self, cfg: Config | None = None) -> None:
        self.config = cfg or default_config
        self.db = Database(self.config.db_path)
        self.hub = Hub(self.config.live_buffer_size)
        self.links: dict[str, Link] = {}
        #: Frames that arrived but could not be decoded.
        self.decode_errors = 0
        #: Decoded packets that could not be written to SQLite. Counted apart
        #: from decode errors: a storage outage is a different fault to a bad
        #: frame, and /api/health reports them separately.
        self.store_errors = 0

    # --- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        await self.db.connect()
        log.info("storage ready at %s", self.config.db_path)

        for name in self.config.links:
            try:
                link = create_link(name, self.on_frame)
            except LinkError as exc:
                log.error("skipping link %r: %s", name, exc)
                continue

            self.links[link.name] = link
            try:
                await link.start()
                log.info("link %r started", link.name)
            except Exception as exc:  # noqa: BLE001 - a bad link must not kill the API
                log.exception("link %r failed to start", link.name)
                link.note_error(str(exc))

    async def stop(self) -> None:
        for link in self.links.values():
            try:
                await link.stop()
            except Exception:  # noqa: BLE001
                log.exception("link %r failed to stop cleanly", link.name)
        self.links.clear()
        await self.db.close()

    # --- ingest ------------------------------------------------------------

    async def on_frame(self, link_name: str, frame: bytes) -> None:
        """Decode, persist and broadcast one raw frame."""
        try:
            message = LogMessage.from_bytes(frame)
        except ProtocolError as exc:
            self.decode_errors += 1
            log.warning("dropping malformed frame from %s: %s (%s)", link_name, exc, frame.hex())
            self.hub.publish(
                {"event": "error", "link": link_name, "message": str(exc), "raw": frame.hex()}
            )
            return

        try:
            record = await self.db.insert_packet(message, link_name, frame)
        except Exception:  # noqa: BLE001 - never lose the live stream over a write error
            self.store_errors += 1
            log.exception("failed to persist packet from %s", link_name)
            record = message.to_dict()
            record.update({"id": None, "link": link_name, "received_at_us": None})

        self.hub.publish({"event": "packet", "data": record})

    # --- commands ----------------------------------------------------------

    async def send_command(
        self, name: str, args: dict[str, Any] | None, link_name: str | None = None
    ) -> dict[str, Any]:
        """Dispatch a command to a link and record the attempt.

        Returns the stored command record. Raises :class:`UnknownCommand`,
        :class:`UnknownLink` or :class:`BadCommand` when the request itself is
        wrong, and :class:`LinkError` when a valid command cannot be delivered.
        """
        args = args or {}
        link = self._resolve_link(name, link_name)

        command_id = await self.db.insert_command(name, args, link.name, None)
        try:
            payload = await link.send_command(name, args)
        except LinkError as exc:  # covers UnknownCommand and BadCommand
            await self.db.finish_command(command_id, "failed", str(exc))
            self.hub.publish(
                {"event": "command", "data": {"id": command_id, "name": name, "status": "failed"}}
            )
            raise
        except Exception as exc:  # noqa: BLE001
            await self.db.finish_command(command_id, "failed", str(exc))
            log.exception("command %r failed", name)
            raise LinkError(str(exc)) from exc

        await self.db.finish_command(command_id, "sent")
        record = await self.db.get_command(command_id) or {}
        record["bytes"] = payload.hex()
        self.hub.publish({"event": "command", "data": record})
        log.info("command %r sent over %s (%s)", name, link.name, payload.hex())
        return record

    def _resolve_link(self, command: str, link_name: str | None) -> Link:
        if link_name is not None:
            link = self.links.get(link_name)
            if link is None:
                known = ", ".join(sorted(self.links)) or "(none)"
                raise UnknownLink(f"no link named {link_name!r}; active links: {known}")
            return link

        # No link requested: prefer a connected link that knows the command.
        candidates = [
            link
            for link in self.links.values()
            if any(spec.name == command for spec in link.supported_commands())
        ]
        if not candidates:
            raise UnknownCommand(f"no link supports command {command!r}")
        for link in candidates:
            if link.connected:
                return link
        return candidates[0]

    # --- introspection -----------------------------------------------------

    def link_status(self) -> list[dict[str, Any]]:
        return [link.status() for link in self.links.values()]

    def available_commands(self) -> list[dict[str, Any]]:
        commands: list[dict[str, Any]] = []
        for link in self.links.values():
            for spec in link.supported_commands():
                entry = spec.to_dict()
                entry["link"] = link.name
                commands.append(entry)
        return commands
