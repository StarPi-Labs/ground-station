"""SQLite persistence for telemetry packets and outbound commands."""

from __future__ import annotations

import json
import os
import time
from typing import Any, Iterable, Sequence

import aiosqlite

from protocol import (
    MessagePayloadType,
    MessageType,
    SourceSubsystem,
    LogMessage,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS packets (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp_us   INTEGER NOT NULL,
    received_at_us INTEGER NOT NULL,
    link           TEXT    NOT NULL,
    payload_type   INTEGER NOT NULL,
    src            INTEGER NOT NULL,
    type           INTEGER NOT NULL,
    payload        TEXT,
    raw            BLOB
);

CREATE INDEX IF NOT EXISTS idx_packets_timestamp ON packets (timestamp_us DESC);
CREATE INDEX IF NOT EXISTS idx_packets_type      ON packets (type, timestamp_us DESC);
CREATE INDEX IF NOT EXISTS idx_packets_src       ON packets (src, timestamp_us DESC);

CREATE TABLE IF NOT EXISTS commands (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at_us INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    args        TEXT,
    link        TEXT,
    status      TEXT    NOT NULL,
    error       TEXT,
    raw         BLOB
);

CREATE INDEX IF NOT EXISTS idx_commands_created ON commands (created_at_us DESC);
"""


def now_us() -> int:
    return time.time_ns() // 1_000


class Database:
    """Async wrapper around the packet/command store.

    A single connection is used throughout: SQLite serializes writes anyway and
    the ingest rate of one rocket is nowhere near contention territory.
    """

    def __init__(self, path: str) -> None:
        self.path = path
        self._conn: aiosqlite.Connection | None = None

    # --- lifecycle ---------------------------------------------------------

    async def connect(self) -> None:
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)

        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA synchronous=NORMAL")
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("database is not connected")
        return self._conn

    # --- packets -----------------------------------------------------------

    async def insert_packet(
        self, message: LogMessage, link: str, raw: bytes | None = None
    ) -> dict[str, Any]:
        """Store a packet and return its API representation (with ``id``)."""
        received_at_us = now_us()
        cursor = await self.conn.execute(
            """
            INSERT INTO packets
                (timestamp_us, received_at_us, link, payload_type, src, type, payload, raw)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                message.timestamp_us,
                received_at_us,
                link,
                int(message.payload_type),
                int(message.src),
                int(message.type),
                json.dumps(message.payload),
                raw,
            ),
        )
        await self.conn.commit()

        record = message.to_dict()
        record["id"] = cursor.lastrowid
        record["link"] = link
        record["received_at_us"] = received_at_us
        return record

    async def query_packets(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        src_mask: int | None = None,
        type_mask: int | None = None,
        payload_mask: int | None = None,
        since_us: int | None = None,
        until_us: int | None = None,
        order: str = "desc",
    ) -> list[dict[str, Any]]:
        where, params = _packet_filters(
            src_mask, type_mask, payload_mask, since_us, until_us
        )
        direction = "ASC" if order.lower() == "asc" else "DESC"

        sql = (
            "SELECT id, timestamp_us, received_at_us, link, payload_type, src, type, payload"
            f" FROM packets {where}"
            f" ORDER BY timestamp_us {direction}, id {direction}"
            " LIMIT ? OFFSET ?"
        )
        async with self.conn.execute(sql, (*params, limit, offset)) as cursor:
            rows = await cursor.fetchall()
        return [_row_to_packet(row) for row in rows]

    async def count_packets(
        self,
        *,
        src_mask: int | None = None,
        type_mask: int | None = None,
        payload_mask: int | None = None,
        since_us: int | None = None,
        until_us: int | None = None,
    ) -> int:
        where, params = _packet_filters(
            src_mask, type_mask, payload_mask, since_us, until_us
        )
        async with self.conn.execute(
            f"SELECT COUNT(*) AS n FROM packets {where}", params
        ) as cursor:
            row = await cursor.fetchone()
        return int(row["n"]) if row else 0

    async def get_packet(self, packet_id: int) -> dict[str, Any] | None:
        async with self.conn.execute(
            "SELECT id, timestamp_us, received_at_us, link, payload_type, src, type, payload"
            " FROM packets WHERE id = ?",
            (packet_id,),
        ) as cursor:
            row = await cursor.fetchone()
        return _row_to_packet(row) if row else None

    async def latest_per_type(self) -> list[dict[str, Any]]:
        """Most recent packet for each message type — the dashboard's "now" view."""
        async with self.conn.execute(
            """
            SELECT p.id, p.timestamp_us, p.received_at_us, p.link,
                   p.payload_type, p.src, p.type, p.payload
            FROM packets p
            JOIN (
                SELECT type, MAX(timestamp_us) AS ts FROM packets GROUP BY type
            ) newest ON newest.type = p.type AND newest.ts = p.timestamp_us
            GROUP BY p.type
            ORDER BY p.type
            """
        ) as cursor:
            rows = await cursor.fetchall()
        return [_row_to_packet(row) for row in rows]

    async def stats(self) -> dict[str, Any]:
        async with self.conn.execute(
            "SELECT COUNT(*) AS n, MIN(timestamp_us) AS first, MAX(timestamp_us) AS last"
            " FROM packets"
        ) as cursor:
            totals = await cursor.fetchone()

        async with self.conn.execute(
            "SELECT type, COUNT(*) AS n FROM packets GROUP BY type"
        ) as cursor:
            by_type = await cursor.fetchall()

        async with self.conn.execute(
            "SELECT src, COUNT(*) AS n FROM packets GROUP BY src"
        ) as cursor:
            by_src = await cursor.fetchall()

        return {
            "packets": int(totals["n"]) if totals else 0,
            "first_timestamp_us": totals["first"] if totals else None,
            "last_timestamp_us": totals["last"] if totals else None,
            "by_type": {_name(MessageType, row["type"]): row["n"] for row in by_type},
            "by_source": {_name(SourceSubsystem, row["src"]): row["n"] for row in by_src},
        }

    async def purge_packets(self) -> int:
        cursor = await self.conn.execute("DELETE FROM packets")
        await self.conn.commit()
        return cursor.rowcount or 0

    # --- commands ----------------------------------------------------------

    async def insert_command(
        self, name: str, args: dict[str, Any] | None, link: str | None, raw: bytes | None
    ) -> int:
        cursor = await self.conn.execute(
            """
            INSERT INTO commands (created_at_us, name, args, link, status, raw)
            VALUES (?, ?, ?, ?, 'pending', ?)
            """,
            (now_us(), name, json.dumps(args or {}), link, raw),
        )
        await self.conn.commit()
        return int(cursor.lastrowid)

    async def finish_command(
        self, command_id: int, status: str, error: str | None = None
    ) -> None:
        await self.conn.execute(
            "UPDATE commands SET status = ?, error = ? WHERE id = ?",
            (status, error, command_id),
        )
        await self.conn.commit()

    async def query_commands(self, limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
        async with self.conn.execute(
            "SELECT id, created_at_us, name, args, link, status, error FROM commands"
            " ORDER BY created_at_us DESC, id DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ) as cursor:
            rows = await cursor.fetchall()
        return [
            {
                "id": row["id"],
                "created_at_us": row["created_at_us"],
                "name": row["name"],
                "args": json.loads(row["args"]) if row["args"] else {},
                "link": row["link"],
                "status": row["status"],
                "error": row["error"],
            }
            for row in rows
        ]

    async def get_command(self, command_id: int) -> dict[str, Any] | None:
        async with self.conn.execute(
            "SELECT id, created_at_us, name, args, link, status, error FROM commands"
            " WHERE id = ?",
            (command_id,),
        ) as cursor:
            row = await cursor.fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "created_at_us": row["created_at_us"],
            "name": row["name"],
            "args": json.loads(row["args"]) if row["args"] else {},
            "link": row["link"],
            "status": row["status"],
            "error": row["error"],
        }


# --- helpers -------------------------------------------------------------------


def _packet_filters(
    src_mask: int | None,
    type_mask: int | None,
    payload_mask: int | None,
    since_us: int | None,
    until_us: int | None,
) -> tuple[str, list[Any]]:
    """Build the shared WHERE clause.

    Enum columns hold bit flags, so a mask match (``col & mask``) lets a caller
    select several sources or types in one request.
    """
    clauses: list[str] = []
    params: list[Any] = []

    for column, mask in (("src", src_mask), ("type", type_mask), ("payload_type", payload_mask)):
        if mask:
            clauses.append(f"({column} & ?) != 0")
            params.append(mask)

    if since_us is not None:
        clauses.append("timestamp_us >= ?")
        params.append(since_us)
    if until_us is not None:
        clauses.append("timestamp_us <= ?")
        params.append(until_us)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return where, params


def _name(enum_cls: type, value: int) -> str:
    try:
        return enum_cls(value).name
    except ValueError:
        return f"UNKNOWN({value})"


def _row_to_packet(row: Sequence[Any]) -> dict[str, Any]:
    timestamp_us = row["timestamp_us"]
    return {
        "id": row["id"],
        "timestamp_us": timestamp_us,
        "timestamp": timestamp_us / 1_000_000,
        "received_at_us": row["received_at_us"],
        "link": row["link"],
        "payload_type": _name(MessagePayloadType, row["payload_type"]),
        "src": _name(SourceSubsystem, row["src"]),
        "type": _name(MessageType, row["type"]),
        "payload": json.loads(row["payload"]) if row["payload"] is not None else None,
    }


def mask_of(values: Iterable[int]) -> int:
    mask = 0
    for value in values:
        mask |= int(value)
    return mask
