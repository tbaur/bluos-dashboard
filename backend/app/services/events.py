"""In-process event bus for SSE fan-out with backpressure."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


class EventBus:
    def __init__(self, max_queue_size: int = 32) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._lock = asyncio.Lock()
        self._max_queue_size = max_queue_size
        self.dropped_events = 0

    async def subscribe(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=self._max_queue_size)
        async with self._lock:
            self._subscribers.add(queue)
        return queue

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    async def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        async with self._lock:
            self._subscribers.discard(queue)

    async def publish(self, event_type: str, data: Any) -> None:
        payload = json.dumps({"type": event_type, "data": data}, default=str)
        async with self._lock:
            subscribers = list(self._subscribers)
        for queue in subscribers:
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                # Drop oldest then push — never block the poller
                try:
                    _ = queue.get_nowait()
                    queue.put_nowait(payload)
                    self.dropped_events += 1
                    logger.warning(
                        "sse_drop_subscriber subscribers=%s dropped_total=%s",
                        len(subscribers),
                        self.dropped_events,
                    )
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    self.dropped_events += 1
                    logger.warning(
                        "sse_drop_subscriber subscribers=%s dropped_total=%s",
                        len(subscribers),
                        self.dropped_events,
                    )

