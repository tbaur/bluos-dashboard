"""Status poller unit tests."""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest
import respx

from app.bluos.client import BluOSClient
from app.bluos.status import PlayerSnapshot
from app.config import Settings
from app.discovery.service import DiscoveryService
from app.models import PlayerStatus, SyncRole
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
    # One miss keeps the room up. The circuit threshold (2 in this fixture) flips it offline.
    assert updated.status == "online"
    assert updated.stale is True
    assert updated.name == "K"
    assert updated.consecutive_failures == 1
    drops = poller.health.snapshot().drops
    assert len(drops) == 1
    assert drops[0].device_id == "p1"
    assert drops[0].ended_at is None
    await poller._poll_once()
    offline = discovery.snapshot.devices[0]
    assert offline.status == "offline"
    assert offline.stale is False
    assert offline.name == "K"
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
async def test_refresh_one_demotes_stale_follower_and_publishes_fleet(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    primary = PlayerStatus(
        id="p1",
        ip="192.168.1.10",
        name="Lead",
        status="online",
        slaves=[],
        sync_role=SyncRole.STANDALONE,
    )
    follower = PlayerStatus(
        id="p2",
        ip="192.168.1.11",
        name="Follow",
        status="online",
        master="192.168.1.10:11000",
        sync_role=SyncRole.SYNCED,
    )
    discovery._snapshot.devices = [primary, follower]
    discovery._snapshot.ips_by_id = {
        "p1": "192.168.1.10:11000",
        "p2": "192.168.1.11:11000",
    }
    events = EventBus()
    poller = StatusPoller(settings, discovery, client, events)
    published: list[tuple[str, object]] = []

    async def capture(event: str, payload: object) -> None:
        published.append((event, payload))

    monkeypatch.setattr(events, "publish", capture)

    async def fake_load(target: str, **_kwargs: object) -> PlayerSnapshot:
        return PlayerSnapshot(
            player=PlayerStatus(
                id="p1",
                ip="192.168.1.10",
                name="Lead",
                status="online",
                slaves=[],
                sync_role=SyncRole.STANDALONE,
            ),
            status_etag="e1",
            sync_stat="s1",
        )

    monkeypatch.setattr(client, "load_player", fake_load)
    updated = await poller.refresh_one("p1")
    assert updated is not None
    assert updated.sync_role == SyncRole.STANDALONE
    stored_follow = discovery.get_device("p2")
    assert stored_follow is not None
    assert stored_follow.sync_role == SyncRole.STANDALONE
    assert stored_follow.master == ""
    assert [event for event, _ in published] == ["fleet"]
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
async def test_refresh_one_keeps_the_room_when_status_is_missing(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(
        id="p1", ip="192.168.1.20", name="Kitchen", status="online", volume=22, track="Song"
    )
    discovery._snapshot.devices = [player]
    discovery._snapshot.endpoints_by_id[player.id] = player.endpoint
    poller = StatusPoller(settings, discovery, client, EventBus())

    async def missed(target: str, **_kwargs: object) -> PlayerSnapshot:
        return PlayerSnapshot(
            player=PlayerStatus(id="p1", ip="192.168.1.20", status="offline", name="Unknown")
        )

    monkeypatch.setattr(client, "load_player", missed)
    updated = await poller.refresh_one("p1")
    assert updated is not None
    assert updated.name == "Kitchen"
    assert updated.volume == 22
    assert updated.track == "Song"
    assert updated.stale is True
    await client.aclose()


@pytest.mark.asyncio
async def test_refresh_one_keeps_a_moved_address(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online", volume=10)
    discovery._snapshot.devices = [player]
    discovery._snapshot.endpoints_by_id[player.id] = player.endpoint
    poller = StatusPoller(settings, discovery, client, EventBus())

    async def moved(target: str, **_kwargs: object) -> PlayerSnapshot:
        current = player.model_copy(update={"ip": "192.168.1.30"})
        discovery._snapshot.devices = [current]
        discovery._snapshot.endpoints_by_id = {current.id: current.endpoint}
        return PlayerSnapshot(
            player=PlayerStatus(id="p1", ip="192.168.1.20", status="online", volume=1)
        )

    monkeypatch.setattr(client, "load_player", moved)
    updated = await poller.refresh_one("p1")
    assert updated is not None
    assert updated.ip == "192.168.1.30"
    assert updated.volume == 10
    await client.aclose()


@pytest.mark.asyncio
async def test_refresh_one_without_a_room_ignores_an_offline_shell(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    discovery._snapshot.endpoints_by_id["p1"] = "192.168.1.20:11000"
    poller = StatusPoller(settings, discovery, client, EventBus())

    async def missed(target: str, **_kwargs: object) -> PlayerSnapshot:
        return PlayerSnapshot(player=PlayerStatus(id="p1", ip="192.168.1.20", status="offline"))

    monkeypatch.setattr(client, "load_player", missed)
    assert await poller.refresh_one("p1") is None
    await client.aclose()


@pytest.mark.asyncio
async def test_cycle_ignores_a_reply_from_the_old_address(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="node-1", ip="192.168.1.20", name="K", status="online", volume=10)
    discovery._snapshot.devices = [player]
    discovery._snapshot.endpoints_by_id[player.id] = player.endpoint
    poller = StatusPoller(settings, discovery, client, EventBus())

    async def moved(target: str, **_kwargs: object) -> PlayerSnapshot:
        current = player.model_copy(update={"ip": "192.168.1.30", "volume": 10})
        discovery._snapshot.devices = [current]
        discovery._snapshot.endpoints_by_id = {current.id: current.endpoint}
        discovery._snapshot.ids_by_endpoint = {current.endpoint: current.id}
        return PlayerSnapshot(
            player=PlayerStatus(id="node-1", ip="192.168.1.20", name="K", status="online", volume=1)
        )

    monkeypatch.setattr(client, "load_player", moved)
    await poller._cycle_device(player)
    stored = discovery.get_device("node-1")
    assert stored is not None
    assert stored.ip == "192.168.1.30"
    assert stored.volume == 10
    await client.aclose()


@pytest.mark.asyncio
async def test_failed_cycle_does_not_overwrite_a_newer_refresh(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online", volume=10)
    discovery._snapshot.devices = [player]
    discovery._snapshot.endpoints_by_id[player.id] = player.endpoint
    poller = StatusPoller(settings, discovery, client, EventBus())

    async def fail_after_refresh(target: str, **_kwargs: object) -> PlayerSnapshot:
        newer = player.model_copy(update={"volume": 40})
        await discovery.update_device(newer)
        raise RuntimeError("down")

    monkeypatch.setattr(client, "load_player", fail_after_refresh)
    await poller._cycle_device(player)
    stored = discovery.get_device("p1")
    assert stored is not None
    assert stored.volume == 40
    assert stored.stale is False
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


def _refresh_poller(settings: Settings) -> tuple[StatusPoller, BluOSClient]:
    client = BluOSClient(settings)
    return StatusPoller(settings, DiscoveryService(settings, client), client, EventBus()), client


@pytest.mark.asyncio
async def test_schedule_refresh_runs_one_refresh_per_player_at_a_time(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    poller, client = _refresh_poller(settings)
    release = asyncio.Event()
    calls: list[str] = []

    async def refresh_one(device_id: str) -> None:
        calls.append(device_id)
        await release.wait()

    monkeypatch.setattr(poller, "refresh_one", refresh_one)
    poller.schedule_refresh("p1")
    poller.schedule_refresh("p1")
    poller.schedule_refresh("p2")
    await asyncio.sleep(0)
    assert calls == ["p1", "p2"]

    release.set()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    poller.schedule_refresh("p1")
    await asyncio.sleep(0)
    assert calls == ["p1", "p2", "p1"]
    await poller.stop()
    await client.aclose()


@pytest.mark.asyncio
async def test_stop_cancels_refreshes_in_flight(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    poller, client = _refresh_poller(settings)
    started = asyncio.Event()

    async def refresh_one(device_id: str) -> None:
        started.set()
        await asyncio.sleep(60)

    monkeypatch.setattr(poller, "refresh_one", refresh_one)
    poller.schedule_refresh("p1")
    await started.wait()
    task = poller._refreshes["p1"]

    await poller.stop()

    assert task.cancelled()
    assert poller._refreshes == {}
    await client.aclose()


@pytest.mark.asyncio
async def test_syncstat_change_reads_the_player_again_after_the_last_change(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A player reports a new syncStat before its /SyncStatus shows the new group,
    and can report more than one while it settles. Read once, after the last."""
    poller, client = _refresh_poller(settings)
    settle = 0.3
    monkeypatch.setattr("app.services.poller.SYNC_SETTLE_SECONDS", settle)
    events: list[str] = []

    async def interrupt(device_ids: list[str]) -> None:
        events.append(f"interrupt:{','.join(device_ids)}")

    async def refresh_one(device_id: str, *, record_miss: bool = True) -> None:
        events.append(f"read:{device_id}:record_miss={record_miss}")

    monkeypatch.setattr(poller, "interrupt", interrupt)
    monkeypatch.setattr(poller, "refresh_one", refresh_one)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    remember = poller._remember_tags

    remember("p1", PlayerSnapshot(player, sync_stat="own-7", sync_read=True))
    remember("p1", PlayerSnapshot(player, sync_stat="own-7"))
    await asyncio.sleep(settle + 0.1)
    assert events == []

    # Joining a group: the follower carries its lead's syncStat, then it moves again.
    remember("p1", PlayerSnapshot(player, sync_stat="lead-55", sync_read=True))
    await asyncio.sleep(settle / 2)
    remember("p1", PlayerSnapshot(player, sync_stat="lead-56", sync_read=True))
    # Past the first change's deadline, but not the second's.
    await asyncio.sleep(settle * 0.75)
    assert events == []
    await asyncio.sleep(settle)
    assert events == ["interrupt:p1", "read:p1:record_miss=False"]
    await poller.stop()
    await client.aclose()


@pytest.mark.asyncio
async def test_a_change_seen_by_the_confirm_read_schedules_one_more(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    poller, client = _refresh_poller(settings)
    monkeypatch.setattr("app.services.poller.SYNC_SETTLE_SECONDS", 0.05)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    reads: list[str] = []

    async def refresh_one(device_id: str, *, record_miss: bool = True) -> None:
        reads.append(device_id)
        # The first confirm read finds the group still moving (56 -> 57); the second does not.
        poller._remember_tags(
            device_id, PlayerSnapshot(player, sync_stat="lead-57", sync_read=True)
        )

    monkeypatch.setattr(poller, "refresh_one", refresh_one)
    poller._remember_tags("p1", PlayerSnapshot(player, sync_stat="own-7", sync_read=True))
    poller._remember_tags("p1", PlayerSnapshot(player, sync_stat="lead-56", sync_read=True))
    await asyncio.sleep(0.4)
    assert reads == ["p1", "p1"]
    assert poller._confirms == {}
    await poller.stop()
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_a_failed_confirm_read_is_not_a_drop(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Real refresh_one, real interrupt: the held long-poll is cancelled, and short
    reads that fail leave the room as it was (no stale, no failure, no health drop)."""
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    discovery._snapshot.devices = [player]
    discovery._snapshot.endpoints_by_id = {"p1": player.endpoint}
    discovery._snapshot.ids_by_endpoint = {player.endpoint: "p1"}
    poller = StatusPoller(settings, discovery, client, EventBus())
    monkeypatch.setattr("app.services.poller.SYNC_SETTLE_SECONDS", 0)
    respx.get(url__regex=r"http://192\.168\.1\.20:11000/(Status|SyncStatus).*").mock(
        side_effect=httpx.ConnectTimeout("player busy")
    )
    held = asyncio.create_task(asyncio.sleep(100))
    poller._in_flight["p1"] = held  # type: ignore[assignment]

    poller._remember_tags("p1", PlayerSnapshot(player, sync_stat="own-7", sync_read=True))
    poller._remember_tags("p1", PlayerSnapshot(player, sync_stat="lead-55", sync_read=True))
    confirm = poller._confirms["p1"]
    await asyncio.wait_for(confirm, timeout=10)

    assert held.cancelled()
    room = discovery.get_device("p1")
    assert room is not None
    assert room.stale is False
    assert room.consecutive_failures == 0
    assert poller.health.snapshot().drops == []
    assert poller._sync_stats["p1"] == "lead-55"
    await poller.stop()
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_a_failed_refresh_still_counts_as_a_miss_by_default(settings: Settings) -> None:
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    discovery._snapshot.devices = [player]
    discovery._snapshot.endpoints_by_id = {"p1": player.endpoint}
    discovery._snapshot.ids_by_endpoint = {player.endpoint: "p1"}
    poller = StatusPoller(settings, discovery, client, EventBus())
    respx.get(url__regex=r"http://192\.168\.1\.20:11000/(Status|SyncStatus).*").mock(
        side_effect=httpx.ConnectTimeout("down")
    )

    await poller.refresh_one("p1")

    room = discovery.get_device("p1")
    assert room is not None
    assert room.stale is True
    assert room.consecutive_failures == 1
    await client.aclose()


@pytest.mark.asyncio
async def test_stop_cancels_a_pending_sync_confirm(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    poller, client = _refresh_poller(settings)
    monkeypatch.setattr("app.services.poller.SYNC_SETTLE_SECONDS", 60)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    poller._remember_tags("p1", PlayerSnapshot(player, sync_stat="a"))
    poller._remember_tags("p1", PlayerSnapshot(player, sync_stat="b"))
    task = poller._confirms["p1"]

    await poller.stop()

    assert task.done()
    assert poller._confirms == {}
    await client.aclose()


@pytest.mark.asyncio
async def test_failed_refresh_is_logged_and_forgotten(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    poller, client = _refresh_poller(settings)

    async def refresh_one(device_id: str) -> None:
        raise RuntimeError("player went away")

    monkeypatch.setattr(poller, "refresh_one", refresh_one)
    with caplog.at_level("WARNING"):
        poller.schedule_refresh("p1")
        task = poller._refreshes["p1"]
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.sleep(0)

    assert poller._refreshes == {}
    assert any(record.message == "refresh_one_failed" for record in caplog.records)
    await client.aclose()
