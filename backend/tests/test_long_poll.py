"""Status etag long-poll (Custom Integration API v1.7)."""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest
import respx

from app.bluos.client import BluOSClient
from app.config import Settings
from app.discovery.service import DiscoveryService
from app.models import PlayerStatus, SyncRole
from app.services.events import EventBus
from app.services.poller import StatusPoller
from tests.fixtures.xml_samples import STATUS, STATUS_GROUP_VOLUME, SYNC_STATUS, SYNC_STATUS_SLAVE

STATUS_SKIP = STATUS.replace(b'etag="2"', b'etag="3"').replace(b"Song Title", b"Next Song")
STATUS_SYNC_CHANGED = STATUS.replace(b'etag="2"', b'etag="4"').replace(
    b"<syncStat>ss-1</syncStat>", b"<syncStat>ss-2</syncStat>"
)
SYNC_AFTER_VOLUME = SYNC_STATUS.replace(b'volume="22"', b'volume="31"').replace(
    b'syncStat="ss-1"', b'syncStat="ss-2"'
)
SLAVE_STATUS = STATUS_GROUP_VOLUME.replace(
    b"<status etag=\"g1\">", b'<status etag="g1">\n  <syncStat>ss-slave</syncStat>'
)
SLAVE_SYNC = SYNC_STATUS_SLAVE.replace(b'etag="252"', b'etag="252" syncStat="ss-slave"')


@pytest.fixture
def settings() -> Settings:
    return Settings(
        allow_non_private_ips=True,
        device_http_timeout=1.0,
        control_rate_limit_seconds=0,
        long_poll_gap_seconds=0,
        status_long_poll_seconds=10,
        long_poll_read_slack_seconds=1,
        max_concurrent_device_calls=1,
        poll_interval=1,
        circuit_failure_threshold=5,
    )


def _poller(settings: Settings, client: BluOSClient) -> tuple[StatusPoller, DiscoveryService]:
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    discovery._snapshot.devices = [player]
    discovery._snapshot.ips_by_id = {"p1": "192.168.1.20:11000"}
    discovery._snapshot.discovered_at = time.time()
    return StatusPoller(settings, discovery, client, EventBus()), discovery


@pytest.mark.asyncio
@respx.mock
async def test_long_poll_uses_timeout_and_etag(settings: Settings) -> None:
    status_route = respx.get(url__regex=r"http://192\.168\.1\.20:11000/Status.*").mock(
        return_value=httpx.Response(200, content=STATUS)
    )
    sync_route = respx.get("http://192.168.1.20:11000/SyncStatus").mock(
        return_value=httpx.Response(200, content=SYNC_STATUS)
    )
    client = BluOSClient(settings)
    try:
        first = await client.load_player("192.168.1.20", device_id="p1")
        assert first.player.track == "Song Title"
        assert first.status_etag == "2"
        assert first.sync_stat == "ss-1"
        assert sync_route.call_count == 1

        second = await client.load_player(
            "192.168.1.20",
            device_id="p1",
            status_etag=first.status_etag,
            sync_stat=first.sync_stat,
            previous=first.player,
            long_poll_seconds=10,
        )
        assert second.player.track == "Song Title"
        assert sync_route.call_count == 1
        long_poll = status_route.calls.last.request
        assert long_poll.url.params["timeout"] == "10"
        assert long_poll.url.params["etag"] == "2"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_syncstat_change_refetches_syncstatus(settings: Settings) -> None:
    respx.get(url__regex=r"http://192\.168\.1\.20:11000/Status.*").mock(
        return_value=httpx.Response(200, content=STATUS_SYNC_CHANGED)
    )
    sync_route = respx.get("http://192.168.1.20:11000/SyncStatus").mock(
        return_value=httpx.Response(200, content=SYNC_AFTER_VOLUME)
    )
    previous = PlayerStatus(
        id="p1",
        ip="192.168.1.20",
        name="Kitchen",
        status="online",
        volume=22,
        track="Song Title",
    )
    client = BluOSClient(settings)
    try:
        snap = await client.load_player(
            "192.168.1.20",
            device_id="p1",
            status_etag="2",
            sync_stat="ss-1",
            previous=previous,
            long_poll_seconds=10,
        )
        assert sync_route.call_count == 1
        assert snap.sync_stat == "ss-2"
        assert snap.player.volume == 31
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_synced_follower_keeps_syncstatus_volume_on_status_only(
    settings: Settings,
) -> None:
    respx.get(url__regex=r"http://192\.168\.1\.88:11000/Status.*").mock(
        return_value=httpx.Response(200, content=SLAVE_STATUS)
    )
    sync_route = respx.get("http://192.168.1.88:11000/SyncStatus").mock(
        return_value=httpx.Response(200, content=SLAVE_SYNC)
    )
    previous = PlayerStatus(
        id="p1",
        ip="192.168.1.88",
        name="Kitchen Speakers",
        status="online",
        volume=64,
        sync_role=SyncRole.SYNCED,
        master="192.168.1.174:11000",
        state="stream",
        track="Old",
    )
    client = BluOSClient(settings)
    try:
        snap = await client.load_player(
            "192.168.1.88",
            device_id="p1",
            status_etag="g1",
            sync_stat="ss-slave",
            previous=previous,
            long_poll_seconds=10,
        )
        assert sync_route.call_count == 0
        assert snap.player.volume == 64
        assert snap.player.track == "Track"
        assert snap.player.sync_role == SyncRole.SYNCED
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_skip_not_blocked_by_held_status_long_poll(settings: Settings) -> None:
    held = asyncio.Event()
    release = asyncio.Event()

    async def delayed_status(_request: httpx.Request) -> httpx.Response:
        held.set()
        await asyncio.wait_for(release.wait(), timeout=5)
        return httpx.Response(200, content=STATUS)

    respx.get(url__regex=r"http://192\.168\.1\.20:11000/Status.*").mock(side_effect=delayed_status)
    respx.get("http://192.168.1.20:11000/Skip").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    respx.get("http://192.168.1.20:11000/SyncStatus").mock(
        return_value=httpx.Response(200, content=SYNC_STATUS)
    )
    previous = PlayerStatus(id="p1", ip="192.168.1.20", name="K", status="online")
    client = BluOSClient(settings)
    try:
        task = asyncio.create_task(
            client.load_player(
                "192.168.1.20",
                device_id="p1",
                status_etag="2",
                sync_stat="ss-1",
                previous=previous,
                long_poll_seconds=10,
            )
        )
        await asyncio.wait_for(held.wait(), timeout=2)
        assert await asyncio.wait_for(client.skip("192.168.1.20"), timeout=2)
        release.set()
        snap = await asyncio.wait_for(task, timeout=2)
        assert snap.player.status == "online"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_poller_second_cycle_long_polls_status(settings: Settings) -> None:
    status_route = respx.get(url__regex=r"http://192\.168\.1\.20:11000/Status.*").mock(
        side_effect=[
            httpx.Response(200, content=STATUS),
            httpx.Response(200, content=STATUS_SKIP),
        ]
    )
    sync_route = respx.get("http://192.168.1.20:11000/SyncStatus").mock(
        return_value=httpx.Response(200, content=SYNC_STATUS)
    )
    client = BluOSClient(settings)
    poller, discovery = _poller(settings, client)
    try:
        await poller._poll_once()
        assert discovery.snapshot.devices[0].track == "Song Title"
        assert poller._status_etags["p1"] == "2"
        await poller._poll_once()
        assert discovery.snapshot.devices[0].track == "Next Song"
        assert poller._status_etags["p1"] == "3"
        assert sync_route.call_count == 1
        assert status_route.calls[1].request.url.params["etag"] == "2"
        assert status_route.calls[1].request.url.params["timeout"] == "10"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_poller_clears_etag_when_player_goes_offline(settings: Settings) -> None:
    respx.get(url__regex=r"http://192\.168\.1\.20:11000/Status.*").mock(
        side_effect=[
            httpx.Response(200, content=STATUS),
            httpx.ConnectError("down"),
        ]
    )
    respx.get("http://192.168.1.20:11000/SyncStatus").mock(
        return_value=httpx.Response(200, content=SYNC_STATUS)
    )
    client = BluOSClient(settings)
    poller, discovery = _poller(settings, client)
    try:
        await poller._poll_once()
        assert "p1" in poller._status_etags
        await poller._poll_once()
        assert discovery.snapshot.devices[0].status == "offline"
        assert "p1" not in poller._status_etags
        drops = poller.health.snapshot().drops
        assert len(drops) == 1
        assert drops[0].device_id == "p1"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_long_poll_malformed_status_is_xml_error(settings: Settings) -> None:
    respx.get(url__regex=r"http://192\.168\.1\.20:11000/Status.*").mock(
        return_value=httpx.Response(200, content=b"<not-xml")
    )
    client = BluOSClient(settings)
    try:
        snap = await client.load_player(
            "192.168.1.20",
            device_id="p1",
            status_etag="2",
            long_poll_seconds=10,
        )
        assert snap.player.status == "xml_error"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_poller_starts_per_device_watchers(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    poller, _discovery = _poller(settings, client)

    async def hang(_device: PlayerStatus) -> None:
        await poller._stop.wait()

    monkeypatch.setattr(poller, "_cycle_device", hang)
    try:
        await poller._reconcile()
        assert "p1" in poller._watchers
        await poller.stop()
        assert poller._watchers == {}
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_reconcile_forgets_removed_devices(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = BluOSClient(settings)
    poller, discovery = _poller(settings, client)
    poller._status_etags["p1"] = "e1"
    poller._sync_stats["p1"] = "s1"

    async def hang(_device: PlayerStatus) -> None:
        await poller._stop.wait()

    monkeypatch.setattr(poller, "_cycle_device", hang)

    async def no_refresh(_self: DiscoveryService) -> object:
        return discovery._snapshot

    monkeypatch.setattr(DiscoveryService, "refresh", no_refresh)
    try:
        await poller._reconcile()
        assert "p1" in poller._watchers
        discovery._snapshot.devices = []
        await poller._reconcile()
        assert poller._watchers == {}
        assert "p1" not in poller._status_etags
        await poller.stop()
    finally:
        await client.aclose()
