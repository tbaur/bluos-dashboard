"""In-process event bus for SSE fan-out with backpressure."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

# A ``None`` item means the bus has closed and the subscriber should stop.
EventQueue = asyncio.Queue[str | None]


class EventBus:
    def __init__(self, max_queue_size: int = 32) -> None:
        self._subscribers: set[EventQueue] = set()
        self._lock = asyncio.Lock()
        self._max_queue_size = max_queue_size
        self._closed = False
        self.dropped_events = 0

    async def subscribe(self) -> EventQueue:
        queue: EventQueue = asyncio.Queue(maxsize=self._max_queue_size)
        async with self._lock:
            self._subscribers.add(queue)
            if self._closed:
                queue.put_nowait(None)
        return queue

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    @property
    def closed(self) -> bool:
        return self._closed

    async def unsubscribe(self, queue: EventQueue) -> None:
        async with self._lock:
            self._subscribers.discard(queue)

    def close(self) -> None:
        """End every subscriber stream so the server can stop. Safe to call twice."""
        self._closed = True
        for queue in list(self._subscribers):
            _put_dropping_oldest(queue, None)

    async def publish(self, event_type: str, data: Any) -> None:
        # Hold the lock across encode and enqueue so a subscriber cannot copy a
        # newer snapshot and then apply this older payload.
        async with self._lock:
            # After close, a drop-oldest could evict the stop marker.
            if self._closed:
                return
            payload = json.dumps({"type": event_type, "data": data}, default=str)
            subscribers = list(self._subscribers)
            self._fanout(subscribers, payload)

    def _fanout(self, subscribers: list[EventQueue], payload: str) -> None:
        for queue in subscribers:
            # Drop oldest then push — never block the poller
            if _put_dropping_oldest(queue, payload):
                continue
            self.dropped_events += 1
            logger.warning(
                "sse_drop_subscriber subscribers=%s dropped_total=%s",
                len(subscribers),
                self.dropped_events,
            )


def _put_dropping_oldest(queue: EventQueue, item: str | None) -> bool:
    """Enqueue without blocking. Returns False when something had to be dropped."""
    try:
        queue.put_nowait(item)
        return True
    except asyncio.QueueFull:
        pass
    try:
        queue.get_nowait()
        queue.put_nowait(item)
    except (asyncio.QueueEmpty, asyncio.QueueFull):
        pass
    return False
