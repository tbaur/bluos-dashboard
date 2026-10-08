"""Server-sent events for the live fleet."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.api.common import StateDep

router = APIRouter()

@router.get("/events")
async def events(request: Request, state: StateDep) -> StreamingResponse:
    keepalive = state.settings.sse_keepalive_seconds

    async def event_generator() -> AsyncIterator[str]:
        # Subscribe first so a change during connect is queued, then copy the
        # snapshot only once the queue is quiet. Replaying those queued events
        # after the snapshot would paint an older volume on top of a newer one.
        queue = await state.events.subscribe()
        try:
            async with state.events._lock:
                while True:
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                initial = json.dumps(
                    {
                        "type": "fleet",
                        "data": state.poller.fleet_payload(),
                    },
                    default=str,
                )
            yield f"data: {initial}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=keepalive)
                    yield f"data: {payload}\n\n"
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        break
                    yield ": keepalive\n\n"
        finally:
            await state.events.unsubscribe(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
