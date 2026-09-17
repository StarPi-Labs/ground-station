"""Fan-out of live events to connected websocket clients."""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import Any

log = logging.getLogger(__name__)

#: Per-client queue depth. A client that falls this far behind starts losing
#: the oldest events rather than back-pressuring the ingest path.
CLIENT_QUEUE_SIZE = 256


class Subscriber:
    """One websocket client's view of the live stream."""

    def __init__(self) -> None:
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(CLIENT_QUEUE_SIZE)
        self.dropped = 0

    def offer(self, event: dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:
            # Drop the oldest so the client keeps receiving fresh telemetry.
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self.dropped += 1
            try:
                self.queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    async def get(self) -> dict[str, Any]:
        return await self.queue.get()


class Hub:
    """Broadcasts events to subscribers and keeps a short replay buffer."""

    def __init__(self, buffer_size: int = 200) -> None:
        self._subscribers: set[Subscriber] = set()
        self._recent: deque[dict[str, Any]] = deque(maxlen=max(0, buffer_size))

    # --- subscription ------------------------------------------------------

    def subscribe(self) -> Subscriber:
        subscriber = Subscriber()
        self._subscribers.add(subscriber)
        return subscriber

    def unsubscribe(self, subscriber: Subscriber) -> None:
        self._subscribers.discard(subscriber)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    # --- publishing --------------------------------------------------------

    def publish(self, event: dict[str, Any]) -> None:
        """Non-blocking: safe to call from the ingest path."""
        if event.get("event") == "packet":
            self._recent.append(event)
        for subscriber in self._subscribers:
            subscriber.offer(event)

    def recent(self, limit: int | None = None) -> list[dict[str, Any]]:
        events = list(self._recent)
        return events[-limit:] if limit else events
