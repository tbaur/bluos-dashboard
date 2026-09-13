"""Status poller unit tests."""

from __future__ import annotations

import asyncio
import time

import pytest

from app.bluos.client import BluOSClient
from app.bluos.status import PlayerSnapshot
from app.config import Settings
from app.discovery.service import DiscoveryService
from app.models import PlayerStatus
from app.services.events import EventBus
from app.services.poller import StatusPoller


@pytest.fixture
def settings() -> Settings:
    return Settings(
        allow_non_private_ips=True,
        poll_interval=1,
        empty_fleet_rediscovery_seconds=5,
        circuit_failure_threshold=2,
        circuit_slow_poll_seconds=30,
        control_rate_limit_seconds=0,
        long_poll_gap_seconds=0,
        status_long_poll_seconds=10,
    )


@pytest.mark.asyncio
async def test_poller_start_stop(settings: Settings) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)
    poller.start()
    assert poller.running is True
    poller.start()  # idempotent
    await poller.stop()
    assert poller.running is False
    await client.aclose()


@pytest.mark.asyncio
async def test_poll_once_updates_online_devices(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    discovery._snapshot.devices = [player]
    discovery._snapshot.ips_by_id = {"p1": "192.168.1.20"}
    discovery._snapshot.discovered_at = time.time()
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)
    published: list[tuple[str, object]] = []

    async def capture(event: str, payload: object) -> None:
        published.append((event, payload))

    monkeypatch.setattr(events, "publish", capture)

    async def fake_load(target: str, **_kwargs: object) -> PlayerSnapshot:
        ip = str(target).split(":")[0]
        return PlayerSnapshot(
            player=PlayerStatus(id="p1", ip=ip, name="K", status="online", volume=9),
            status_etag="e1",
            sync_stat="s1",
        )

    monkeypatch.setattr(client, "load_player", fake_load)
    await poller._poll_once()
    assert discovery.snapshot.devices[0].volume == 9
    assert poller._failures.get("p1") == 0
    # Volume-only change leaves the sync graph and health untouched, so the
    # poller sends a single-device delta rather than the whole fleet.
    assert [event for event, _ in published] == ["device"]
    await client.aclose()


@pytest.mark.asyncio
async def test_poll_once_publishes_fleet_when_sync_graph_changes(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    discovery._snapshot.devices = [player]
    discovery._snapshot.ips_by_id = {"p1": "192.168.1.20"}
    discovery._snapshot.discovered_at = time.time()
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)
    published: list[tuple[str, object]] = []

    async def capture(event: str, payload: object) -> None:
        published.append((event, payload))

    monkeypatch.setattr(events, "publish", capture)

    async def fake_load(target: str, **_kwargs: object) -> PlayerSnapshot:
        ip = str(target).split(":")[0]
        return PlayerSnapshot(
            player=PlayerStatus(
                id="p1",
                ip=ip,
                name="K",
                status="online",
                slaves=["192.168.1.21:11000"],
            ),
            status_etag="e1",
            sync_stat="s2",
        )

    monkeypatch.setattr(client, "load_player", fake_load)
    await poller._poll_once()
    assert [event for event, _ in published] == ["fleet"]
    await client.aclose()


@pytest.mark.asyncio
async def test_poll_once_publishes_fleet_when_device_drops(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    discovery._snapshot.devices = [player]
    discovery._snapshot.ips_by_id = {"p1": "192.168.1.20"}
    discovery._snapshot.discovered_at = time.time()
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)
    published: list[tuple[str, object]] = []

    async def capture(event: str, payload: object) -> None:
        published.append((event, payload))

    monkeypatch.setattr(events, "publish", capture)

    async def boom(target: str, **_kwargs: object) -> PlayerSnapshot:
        raise RuntimeError("unreachable")

    monkeypatch.setattr(client, "load_player", boom)
    await poller._poll_once()
    # online -> offline changes both status and the health log.
    assert [event for event, _ in published] == ["fleet"]
    await client.aclose()


@pytest.mark.asyncio
async def test_poll_once_marks_exception_offline(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    discovery._snapshot.devices = [player]
    discovery._snapshot.ips_by_id = {"p1": "192.168.1.20"}
    discovery._snapshot.discovered_at = time.time()
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)

    async def boom(*_args, **_kwargs):
        raise RuntimeError("device down")

    monkeypatch.setattr(client, "load_player", boom)
    await poller._poll_once()
    updated = discovery.snapshot.devices[0]
    assert updated.status == "offline"
    assert updated.consecutive_failures == 1
    drops = poller.health.snapshot().drops
    assert len(drops) == 1
    assert drops[0].device_id == "p1"
    assert drops[0].ended_at is None
    await client.aclose()


@pytest.mark.asyncio
async def test_circuit_breaker_slows_poll(settings: Settings) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)
    offline = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="offline")
    poller._record_result(offline)
    poller._record_result(offline)
    assert poller._failures["p1"] == 2
    due = poller._next_due["p1"]
    # Second failure trips circuit — next due uses circuit_slow_poll_seconds.
    assert due >= time.monotonic() + settings.circuit_slow_poll_seconds - 1
    await client.aclose()


@pytest.mark.asyncio
async def test_empty_fleet_triggers_refresh(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)
    called = {"n": 0}

    async def refresh(self: DiscoveryService):
        called["n"] += 1
        return self._snapshot

    monkeypatch.setattr(DiscoveryService, "refresh", refresh)
    await poller._maybe_rediscover()
    assert called["n"] == 1
    await client.aclose()


@pytest.mark.asyncio
async def test_refresh_one_unknown_returns_none(settings: Settings) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)
    assert await poller.refresh_one("missing") is None
    await client.aclose()


@pytest.mark.asyncio
async def test_run_loop_records_cycle_error(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)

    async def boom() -> None:
        raise RuntimeError("cycle failed")

    monkeypatch.setattr(poller, "_reconcile", boom)
    poller.settings = settings.model_copy(update={"long_poll_gap_seconds": 0.5})
    poller.start()
    for _ in range(40):
        if poller.last_error:
            break
        await asyncio.sleep(0.05)
    await poller.stop()
    assert poller.last_error == "cycle failed"
    assert poller.last_error_kind == "RuntimeError"
    await client.aclose()


@pytest.mark.asyncio
async def test_stop_cancels_watchers_stuck_in_a_long_poll(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A watcher parked in a 100s long-poll must not delay shutdown.

    Long-poll reads can outlast the whole shutdown budget, so stop() has to
    cancel them rather than wait. This pins that: the wait is bounded by
    cancellation, not by the read timeout.
    """
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    discovery._snapshot.devices = [player]
    discovery._snapshot.ips_by_id = {"p1": "192.168.1.20"}
    discovery._snapshot.discovered_at = time.time()
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)

    entered = asyncio.Event()

    async def never_returns(target: str, **_kwargs: object) -> PlayerSnapshot:
        entered.set()
        await asyncio.sleep(3600)
        raise AssertionError("unreachable")

    monkeypatch.setattr(client, "load_player", never_returns)

    async def seeded(*_args: object, **_kwargs: object) -> object:
        return discovery._snapshot

    monkeypatch.setattr(discovery, "refresh", seeded)
    monkeypatch.setattr(discovery, "get_devices", seeded)

    poller.start()
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        await asyncio.wait_for(poller.stop(), timeout=5)
        assert poller.running is False
        assert not poller._watchers
    finally:
        if poller.running:
            await poller.stop()
        await client.aclose()


@pytest.mark.asyncio
async def test_interrupt_cancels_long_poll_without_marking_offline(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    discovery._snapshot.devices = [player]
    discovery._snapshot.ips_by_id = {"p1": "192.168.1.20"}
    discovery._snapshot.discovered_at = time.time()
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)
    entered = asyncio.Event()

    async def held(_target: str, **_kwargs: object) -> PlayerSnapshot:
        entered.set()
        await asyncio.sleep(3600)
        raise AssertionError("long-poll should have been cancelled")

    monkeypatch.setattr(client, "load_player", held)
    poller.start()
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        await poller.interrupt(["p1"])
        # Watcher restarts a new long-poll; the room must not flip offline.
        assert discovery.snapshot.devices[0].status == "online"
    finally:
        await poller.stop()
        await client.aclose()


@pytest.mark.asyncio
async def test_interrupt_holds_off_the_next_long_poll(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = settings.model_copy(
        update={"long_poll_gap_seconds": 0.35, "control_interrupt_wait_seconds": 0.05}
    )
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    discovery._snapshot.devices = [player]
    discovery._snapshot.ips_by_id = {"p1": "192.168.1.20"}
    discovery._snapshot.discovered_at = time.time()
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)
    calls = {"n": 0}
    entered = asyncio.Event()

    async def held(_target: str, **_kwargs: object) -> PlayerSnapshot:
        calls["n"] += 1
        entered.set()
        await asyncio.sleep(3600)
        raise AssertionError("long-poll should have been cancelled")

    monkeypatch.setattr(client, "load_player", held)
    poller.start()
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        assert calls["n"] == 1
        await poller.interrupt(["p1"])
        await asyncio.sleep(0.12)
        assert calls["n"] == 1
        await asyncio.sleep(0.35)
        assert calls["n"] == 2
    finally:
        await poller.stop()
        await client.aclose()


@pytest.mark.asyncio
async def test_interrupt_without_inflight_is_a_noop(settings: Settings) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)
    await poller.interrupt(["missing"])
    await client.aclose()


@pytest.mark.asyncio
async def test_stale_fleet_rediscovers_on_poller_not_on_request(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    discovery._snapshot.devices = [player]
    discovery._snapshot.discovered_at = 1.0
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)
    called = {"n": 0}

    async def refresh(self: DiscoveryService) -> object:
        called["n"] += 1
        self._snapshot.discovered_at = time.time()
        return self._snapshot

    monkeypatch.setattr(DiscoveryService, "refresh", refresh)
    await poller._maybe_rediscover()
    assert called["n"] == 1
    await poller._maybe_rediscover()
    assert called["n"] == 1
    await client.aclose()
