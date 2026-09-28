"""The ground station: wires links, storage and the live stream together.

Ingest path for every frame, regardless of transport::

    Link -> Station.on_frame -> protocol.decode -> SQLite -> Hub -> websockets

Frames are decoded and broadcast as they arrive, then stored in batches: a
single writer task saves everything that queued up since its previous batch,
at most every WRITE_INTERVAL_S. The live stream never waits for the disk: on
the Pi's SD card a commit or WAL checkpoint can take half a second. Packet ids
are handed out here, continuing the table's own sequence, so a packet has its
id before it is stored.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from config import Config, config as default_config
from db import Database, now_us
from hub import Hub
from links import Link, LinkError, UnknownCommand, UnknownLink, create_link
from protocol import LogMessage, ProtocolError

log = logging.getLogger(__name__)

#: Minimum time between two packet batches, in seconds. Every commit rewrites
#: whole pages of the table and its indexes, so committing as packets came
#: in (~50 times a second) wrote ~3 MB/s to the SD card for ~45 kB/s of data.
#: Only storage waits for it, not the live stream.
WRITE_INTERVAL_S = 0.5


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
        #: Findings of the startup integrity check: None while it runs, []
        #: when the database file is sound.
        self.storage_problems: list[str] | None = None
        self._storage_check: asyncio.Task[None] | None = None
        # Published packets waiting for the writer, and their raw frames.
        self._pending: list[dict[str, Any]] = []
        self._pending_raw: list[bytes] = []
        self._next_id = 1
        self._pending_ready = asyncio.Event()
        self._writer: asyncio.Task[None] | None = None
        self._stopping = False

    # --- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        await self.db.connect()
        log.info("storage ready at %s", self.config.db_path)
        self._next_id = await self.db.next_packet_id()
        self._stopping = False
        self._writer = asyncio.create_task(self._write_loop(), name="packet-writer")
        self.storage_problems = None
        self._storage_check = asyncio.create_task(self._check_storage(), name="storage-check")

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
        if self._storage_check is not None:
            self._storage_check.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._storage_check
            self._storage_check = None
        if self._writer is not None:
            # Not cancelled: a batch cut off mid-write would be lost. The
            # writer drains the queue and returns once it sees the flag.
            self._stopping = True
            self._pending_ready.set()
            await self._writer
            self._writer = None
        await self.db.close()

    async def _check_storage(self) -> None:
        """Check the database file once, in the background.

        A corrupt file still takes inserts but fails the history queries that
        reach its bad pages, which the frontend only sees as HTTP 500s; this
        says why, in the log and in /api/health. Not awaited in start(): the
        check reads the whole file, and ingest must not wait for it.
        """
        try:
            problems = await self.db.quick_check()
        except Exception as exc:  # noqa: BLE001 - a file too damaged to check
            problems = [f"check failed: {exc}"]
        self.storage_problems = problems
        if problems:
            log.error(
                "database %s is corrupt, history queries may fail: %s",
                self.config.db_path, "; ".join(problems[:5]),
            )
        else:
            log.info("database %s passed its integrity check", self.config.db_path)

    def storage_status(self) -> dict[str, Any]:
        problems = self.storage_problems
        state = "checking" if problems is None else "corrupt" if problems else "ok"
        return {"state": state, "problems": problems or []}

    # --- ingest ------------------------------------------------------------

    async def on_frame(self, link_name: str, frame: bytes) -> None:
        """Decode and broadcast one raw frame, and queue it for storage."""
        try:
            message = LogMessage.from_bytes(frame)
        except ProtocolError as exc:
            self.decode_errors += 1
            log.warning("dropping malformed frame from %s: %s (%s)", link_name, exc, frame.hex())
            self.hub.publish(
                {"event": "error", "link": link_name, "message": str(exc), "raw": frame.hex()}
            )
            return

        record = message.to_dict()
        record.update({"id": self._next_id, "link": link_name, "received_at_us": now_us()})
        self._next_id += 1
        self.hub.publish({"event": "packet", "data": record})
        self._pending.append(record)
        self._pending_raw.append(frame)
        self._pending_ready.set()

    async def _write_loop(self) -> None:
        loop = asyncio.get_running_loop()
        while not self._stopping:
            await self._pending_ready.wait()
            started = loop.time()
            self._pending_ready.clear()
            await self._flush()
            # Let the next batch collect for the rest of the interval. Not
            # after stop(): the final flush below takes whatever is left.
            if not self._stopping:
                await asyncio.sleep(max(0.0, started + WRITE_INTERVAL_S - loop.time()))
        await self._flush()  # anything that queued during the last batch

    async def _flush(self) -> None:
        """Store every queued packet, in arrival order."""
        batch, self._pending = self._pending, []
        raws, self._pending_raw = self._pending_raw, []
        if not batch:
            return
        try:
            await self.db.insert_packets(batch, raws)
        except Exception:  # noqa: BLE001 - the live stream already has them
            self.store_errors += len(batch)
            log.exception("failed to persist %d packets", len(batch))
            # If something else wrote to the table, our ids now collide with
            # its rows: move past them, or every later batch fails too.
            try:
                self._next_id = max(self._next_id, await self.db.next_packet_id())
            except Exception:  # noqa: BLE001 - the next failure retries
                pass

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
