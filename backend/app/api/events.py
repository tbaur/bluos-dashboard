"""Server-sent events for the live fleet."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.api.common import StateDep

router = APIRouter()

@router.get("/events")
async def events(request: Request, state: StateDep) -> StreamingResponse:
    keepalive = state.settings.sse_keepalive_seconds

    async def event_generator() -> AsyncIterator[str]:
        queue, initial = await state.events.subscribe_with_snapshot(
            "fleet", state.poller.fleet_payload
        )
        try:
            if initial is None:
                return
            yield f"data: {initial}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=keepalive)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        break
                    yield ": keepalive\n\n"
                    continue
                if payload is None:
                    # The server is stopping. Ending the response lets it exit.
                    break
                yield f"data: {payload}\n\n"
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
