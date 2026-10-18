"""SQLite persistence for telemetry packets and outbound commands."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import time
from typing import Any, AsyncIterator, Sequence

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
CREATE INDEX IF NOT EXISTS idx_packets_link      ON packets (link, timestamp_us DESC);

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


#: Read-only connections serving queries, each on its own thread.
READERS = 3


def now_us() -> int:
    return time.time_ns() // 1_000


def run_path(series: str) -> str:
    """A new database file for this run, next to ``series`` and named after it.

    ``data/starpi.db`` gives ``data/starpi-0003-20261003-142501.db``. Every run
    starts on an empty file: packets carry the rocket's own timestamps, and its
    clock restarts with the rocket unless GPS has set it, so two runs in one
    file could overlap in time. The run number orders the files even when the
    Pi's clock is wrong (it has no RTC); the date is for people.
    """
    directory, name = os.path.split(series)
    stem, ext = os.path.splitext(name)
    ext = ext or ".db"
    pattern = re.compile(rf"{re.escape(stem)}-(\d+)-.*{re.escape(ext)}$")
    try:
        names = os.listdir(directory or ".")
    except FileNotFoundError:
        names = []
    run = max((int(m.group(1)) for n in names if (m := pattern.match(n))), default=0) + 1
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    return os.path.join(directory, f"{stem}-{run:04d}-{stamp}{ext}")


class Database:
    """Async wrapper around the packet/command store.

    One connection writes: SQLite serializes writes anyway, and packets are
    written in batches (see :meth:`insert_packets`). Queries run on a pool of
    READERS other connections, which WAL lets read alongside the writer: on
    the Pi, history pages and inserts queued behind each other on a single
    connection, and behind the WAL checkpoints' fsyncs to the SD card.
    """

    def __init__(self, path: str) -> None:
        self.path = path
        self._conn: aiosqlite.Connection | None = None
        self._readers: asyncio.Queue[aiosqlite.Connection] | None = None
        self._reader_conns: list[aiosqlite.Connection] = []

    # --- lifecycle ---------------------------------------------------------

    async def connect(self) -> None:
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)

        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await _pragma(self._conn, "PRAGMA journal_mode=WAL")
        await _pragma(self._conn, "PRAGMA synchronous=NORMAL")
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()

        self._readers = asyncio.Queue()
        for _ in range(READERS):
            reader = await aiosqlite.connect(self.path)
            reader.row_factory = aiosqlite.Row
            await _pragma(reader, "PRAGMA query_only=1")
            self._reader_conns.append(reader)
            self._readers.put_nowait(reader)

    async def close(self) -> None:
        for reader in self._reader_conns:
            await reader.close()
        self._reader_conns = []
        self._readers = None
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    @property
    def conn(self) -> aiosqlite.Connection:
        """The writing connection."""
        if self._conn is None:
            raise RuntimeError("database is not connected")
        return self._conn

    @contextlib.asynccontextmanager
    async def _reader(self) -> AsyncIterator[aiosqlite.Connection]:
        """A reading connection from the pool, for the duration of one query."""
        if self._readers is None:
            raise RuntimeError("database is not connected")
        reader = await self._readers.get()
        try:
            yield reader
        finally:
            self._readers.put_nowait(reader)

    async def quick_check(self, max_problems: int = 20) -> list[str]:
        """SQLite's structural check of the whole file: ``[]`` when it is sound.

        Otherwise SQLite's findings, at most ``max_problems`` of them. It reads
        every page (~2 s for 400 MB on the Pi), so it runs on a reader and the
        writer carries on meanwhile.
        """
        async with self._reader() as conn:
            async with conn.execute(f"PRAGMA quick_check({int(max_problems)})") as cursor:
                rows = await cursor.fetchall()
        problems = [row[0] for row in rows]
        return [] if problems == ["ok"] else problems

    # --- packets -----------------------------------------------------------

    async def next_packet_id(self) -> int:
        """The id the next stored packet gets: ids are handed out before storage."""
        async with self.conn.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'packets'"
        ) as cursor:
            row = await cursor.fetchone()
        return (int(row[0]) if row else 0) + 1

    async def insert_packets(self, packets: Sequence[dict[str, Any]], raws: Sequence[bytes]) -> None:
        """Store packet records (as published, with ``id``) in one transaction.

        One statement and one commit per batch rather than per packet: every
        commit rewrites whole pages of the table and its indexes, which on the
        Pi's SD card cost far more than the rows themselves.
        """
        if not packets:
            return
        async with self.conn.executemany(
            """
            INSERT INTO packets
                (id, timestamp_us, received_at_us, link, payload_type, src, type, payload, raw)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    record["id"],
                    record["timestamp_us"],
                    record["received_at_us"],
                    record["link"],
                    int(MessagePayloadType[record["payload_type"]]),
                    int(SourceSubsystem[record["src"]]),
                    int(MessageType[record["type"]]),
                    json.dumps(record["payload"]),
                    raw,
                )
                for record, raw in zip(packets, raws)
            ],
        ):
            pass
        await self.conn.commit()

    async def query_packets_json(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        src_mask: int | None = None,
        type_mask: int | None = None,
        payload_mask: int | None = None,
        links: Sequence[str] | None = None,
        since_us: int | None = None,
        until_us: int | None = None,
        after_id: int | None = None,
        order: str = "desc",
    ) -> list[str]:
        """Matching packets, each already serialized as a JSON object.

        SQLite renders the JSON (:data:`_PACKET_JSON`) so history pages skip
        building and re-encoding a dict per row in Python, which cost several
        times the query itself once a flight's worth of IMU samples is paged
        out. ``after_id`` continues a page (see :func:`_packet_filters`).
        """
        async with self._reader() as conn:
            ascending = order.lower() == "asc"
            where, params = _packet_filters(
                src_mask, type_mask, payload_mask, links, since_us, until_us,
                after_id=after_id, ascending=ascending,
            )
            direction = "ASC" if ascending else "DESC"

            sql = (
                f"SELECT {_PACKET_JSON} FROM packets {where}"
                f" ORDER BY timestamp_us {direction}, id {direction}"
                " LIMIT ? OFFSET ?"
            )
            async with conn.execute(sql, (*params, limit, offset)) as cursor:
                rows = await cursor.fetchall()
            return [row[0] for row in rows]

    async def query_packets_minmax(
        self,
        *,
        type_mask: int,
        field: str | None,
        since_us: int,
        until_us: int,
        buckets: int,
    ) -> list[str]:
        """A plot's worth of packets: per time bucket, the lowest and highest ``field``.

        Open MCT's "minmax" strategy: ``since_us..until_us`` is cut into
        ``buckets`` equal slices and each slice contributes the packet with the
        minimum and the one with the maximum of the payload field (``None``
        for a scalar payload), so at most ``2 * buckets`` packets, oldest
        first, in which every peak survives. JSON as in :meth:`query_packets_json`.
        """
        where, params = _packet_filters(None, type_mask, None, None, since_us, until_us)
        width = max(1, -(-(until_us - since_us + 1) // buckets))
        path = "$" if field is None else f"$.{field}"
        # Materialized: the window is scanned and its JSON parsed once, for
        # both the minima and the maxima.
        sql = f"""
            WITH s AS MATERIALIZED (
                SELECT id, json_extract(payload, ?) AS v, (timestamp_us - ?) / ? AS b
                FROM packets {where}
            )
            SELECT {_PACKET_JSON} FROM packets WHERE id IN (
                SELECT id FROM (SELECT id, MIN(v) FROM s GROUP BY b)
                UNION
                SELECT id FROM (SELECT id, MAX(v) FROM s GROUP BY b)
            )
            ORDER BY timestamp_us, id
        """
        async with self._reader() as conn:
            async with conn.execute(sql, (path, since_us, width, *params)) as cursor:
                rows = await cursor.fetchall()
        return [row[0] for row in rows]

    async def count_packets(
        self,
        *,
        src_mask: int | None = None,
        type_mask: int | None = None,
        payload_mask: int | None = None,
        links: Sequence[str] | None = None,
        since_us: int | None = None,
        until_us: int | None = None,
        after_id: int | None = None,
        ascending: bool = False,
    ) -> int:
        async with self._reader() as conn:
            where, params = _packet_filters(
                src_mask, type_mask, payload_mask, links, since_us, until_us,
                after_id=after_id, ascending=ascending,
            )
            async with conn.execute(
                f"SELECT COUNT(*) AS n FROM packets {where}", params
            ) as cursor:
                row = await cursor.fetchone()
            return int(row["n"]) if row else 0

    async def get_packet(self, packet_id: int) -> dict[str, Any] | None:
        async with self._reader() as conn:
            async with conn.execute(
                "SELECT id, timestamp_us, received_at_us, link, payload_type, src, type, payload"
                " FROM packets WHERE id = ?",
                (packet_id,),
            ) as cursor:
                row = await cursor.fetchone()
            return _row_to_packet(row) if row else None

    async def latest_per_type(self) -> list[dict[str, Any]]:
        """Most recent packet for each message type — the dashboard's "now" view."""
        async with self._reader() as conn:
            async with conn.execute(
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
        async with self._reader() as conn:
            async with conn.execute(
                "SELECT COUNT(*) AS n, MIN(timestamp_us) AS first, MAX(timestamp_us) AS last"
                " FROM packets"
            ) as cursor:
                totals = await cursor.fetchone()

            async with conn.execute(
                "SELECT type, COUNT(*) AS n FROM packets GROUP BY type"
            ) as cursor:
                by_type = await cursor.fetchall()

            async with conn.execute(
                "SELECT src, COUNT(*) AS n FROM packets GROUP BY src"
            ) as cursor:
                by_src = await cursor.fetchall()

            async with conn.execute(
                "SELECT link, COUNT(*) AS n FROM packets GROUP BY link"
            ) as cursor:
                by_link = await cursor.fetchall()

            return {
                "packets": int(totals["n"]) if totals else 0,
                "first_timestamp_us": totals["first"] if totals else None,
                "last_timestamp_us": totals["last"] if totals else None,
                "by_type": {_name(MessageType, row["type"]): row["n"] for row in by_type},
                "by_source": {_name(SourceSubsystem, row["src"]): row["n"] for row in by_src},
                "by_link": {row["link"]: row["n"] for row in by_link},
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
        async with self._reader() as conn:
            async with conn.execute(
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
        async with self._reader() as conn:
            async with conn.execute(
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


async def _pragma(conn: aiosqlite.Connection, statement: str) -> None:
    """Run a PRAGMA to completion.

    Left unread, a PRAGMA's result keeps its statement open, and an open
    statement pins a read snapshot: on the writing connection that stopped
    SQLite from ever rewinding the WAL, which then grew without bound.
    """
    async with conn.execute(statement) as cursor:
        await cursor.fetchall()


def _packet_filters(
    src_mask: int | None,
    type_mask: int | None,
    payload_mask: int | None,
    links: Sequence[str] | None,
    since_us: int | None,
    until_us: int | None,
    *,
    after_id: int | None = None,
    ascending: bool = False,
) -> tuple[str, list[Any]]:
    """Build the shared WHERE clause.

    Enum columns hold bit flags, so a mask lets a caller select several
    sources or types in one request. Each stored value is a single flag, so the
    mask is expanded into an ``IN`` set of its bits: unlike ``col & mask`` that
    can use the per-column indexes, which matters once history grows past a
    few thousand rows. ``link`` is a plain name, matched with an ``IN`` set too.

    ``after_id`` is a keyset cursor: the last packet of the previous page, which
    sits at ``since_us`` (ascending) or ``until_us`` (descending). Only packets
    past it in ``(timestamp_us, id)`` order match. Unlike ``OFFSET``, whose
    cost grows with every page, each page is then a plain index seek.
    """
    clauses: list[str] = []
    params: list[Any] = []

    for column, mask in (("src", src_mask), ("type", type_mask), ("payload_type", payload_mask)):
        if mask:
            flags = _flags(mask)
            clauses.append(f"{column} IN ({', '.join('?' * len(flags))})")
            params.extend(flags)

    if links:
        clauses.append(f"link IN ({', '.join('?' * len(links))})")
        params.extend(links)

    if since_us is not None:
        clauses.append("timestamp_us >= ?")
        params.append(since_us)
    if until_us is not None:
        clauses.append("timestamp_us <= ?")
        params.append(until_us)

    boundary = since_us if ascending else until_us
    if after_id is not None and boundary is not None:
        past = ">" if ascending else "<"
        clauses.append(f"(timestamp_us {past} ? OR id {past} ?)")
        params.extend([boundary, after_id])

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return where, params


def _flags(mask: int) -> list[int]:
    """The single-bit flags set in ``mask``."""
    return [1 << bit for bit in range(mask.bit_length()) if mask >> bit & 1]


def _name(enum_cls: type, value: int) -> str:
    try:
        return enum_cls(value).name
    except ValueError:
        return f"UNKNOWN({value})"


def _enum_name_sql(column: str, enum_cls: type) -> str:
    """SQL mapping an enum column to its member name, like :func:`_name`."""
    cases = " ".join(f"WHEN {member.value} THEN '{member.name}'" for member in enum_cls)
    return f"CASE {column} {cases} ELSE 'UNKNOWN(' || {column} || ')' END"


# One packet as a JSON object, identical to _row_to_packet() once parsed.
# "timestamp" is printed from the integer: a SQLite REAL keeps only 15
# significant digits, which drops the microseconds.
_PACKET_JSON = f"""json_object(
    'id', id,
    'timestamp_us', timestamp_us,
    'timestamp', json(printf('%d.%06d', timestamp_us / 1000000, timestamp_us % 1000000)),
    'received_at_us', received_at_us,
    'link', link,
    'payload_type', {_enum_name_sql('payload_type', MessagePayloadType)},
    'src', {_enum_name_sql('src', SourceSubsystem)},
    'type', {_enum_name_sql('type', MessageType)},
    'payload', json(payload)
)"""


def _row_to_packet(row: aiosqlite.Row) -> dict[str, Any]:
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
