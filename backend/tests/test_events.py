from __future__ import annotations

import asyncio

import pytest

from app.services.events import EventBus


@pytest.mark.asyncio
async def test_event_bus_publish_and_subscribe() -> None:
    bus = EventBus(max_queue_size=2)
    queue = await bus.subscribe()
    await bus.publish("fleet", {"ok": True})
    payload = await asyncio.wait_for(queue.get(), timeout=1)
    assert '"fleet"' in payload
    await bus.unsubscribe(queue)


@pytest.mark.asyncio
async def test_event_bus_backpressure_drops_oldest() -> None:
    bus = EventBus(max_queue_size=1)
    queue = await bus.subscribe()
    await bus.publish("a", 1)
    await bus.publish("b", 2)
    payload = await asyncio.wait_for(queue.get(), timeout=1)
    assert '"b"' in payload
    assert bus.dropped_events >= 1
    await bus.unsubscribe(queue)


@pytest.mark.asyncio
async def test_subscribe_with_snapshot_sees_only_newer_events() -> None:
    bus = EventBus()
    await bus.publish("before", 1)
    queue, initial = await bus.subscribe_with_snapshot("fleet", lambda: {"n": 1})
    assert initial is not None and '"fleet"' in initial and '"n": 1' in initial
    assert queue.empty()
    await bus.publish("after", 2)
    assert '"after"' in (queue.get_nowait() or "")
    await bus.unsubscribe(queue)


@pytest.mark.asyncio
async def test_failed_snapshot_leaves_no_subscriber_behind() -> None:
    bus = EventBus()

    def broken() -> dict[str, int]:
        raise RuntimeError("snapshot failed")

    with pytest.raises(RuntimeError):
        await bus.subscribe_with_snapshot("fleet", broken)
    assert bus.subscriber_count == 0


@pytest.mark.asyncio
async def test_subscribe_with_snapshot_after_close_has_no_snapshot() -> None:
    bus = EventBus()
    bus.close()
    queue, initial = await bus.subscribe_with_snapshot("fleet", lambda: {})
    assert initial is None
    await bus.unsubscribe(queue)
    assert bus.subscriber_count == 0


@pytest.mark.asyncio
async def test_close_ends_every_subscriber_even_when_full() -> None:
    bus = EventBus(max_queue_size=1)
    idle = await bus.subscribe()
    full = await bus.subscribe()
    await bus.publish("a", 1)
    await idle.get()

    bus.close()

    assert bus.closed
    assert await asyncio.wait_for(idle.get(), timeout=1) is None
    assert await asyncio.wait_for(full.get(), timeout=1) is None


@pytest.mark.asyncio
async def test_publish_after_close_cannot_evict_the_stop_marker() -> None:
    bus = EventBus(max_queue_size=1)
    queue = await bus.subscribe()
    bus.close()
    await bus.publish("late", 1)
    assert queue.get_nowait() is None
    assert queue.empty()


@pytest.mark.asyncio
async def test_subscribe_after_close_gets_the_stop_marker() -> None:
    bus = EventBus()
    bus.close()
    bus.close()
    queue = await bus.subscribe()
    assert queue.get_nowait() is None


def test_event_bus_subscriber_count() -> None:
    from app.services.events import EventBus

    bus = EventBus()
    assert bus.subscriber_count == 0


@pytest.mark.asyncio
async def test_event_bus_subscriber_count_live() -> None:
    from app.services.events import EventBus

    bus = EventBus()
    q = await bus.subscribe()
    assert bus.subscriber_count == 1
    await bus.unsubscribe(q)
    assert bus.subscriber_count == 0
