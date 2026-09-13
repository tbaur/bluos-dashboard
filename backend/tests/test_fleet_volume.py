from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.bluos.client import BluOSClient
from app.config import Settings, get_settings
from app.discovery.service import DiscoveryService
from app.main import create_app
from app.models import PlayerStatus
from app.services.events import EventBus
from app.services.poller import StatusPoller
from app.state import AppState
from tests.helpers import app_with_players


@pytest.fixture
def settings() -> Settings:
    get_settings.cache_clear()
    return Settings(
        discovery_cache_ttl=60,
        poll_interval=60,
        allow_non_private_ips=True,
        control_rate_limit_seconds=0,
    )


@pytest.mark.asyncio
async def test_fleet_volume_sets_all(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    async def seeded(self: DiscoveryService, *args, **kwargs):
        return self._snapshot

    monkeypatch.setattr(DiscoveryService, "refresh", seeded)
    monkeypatch.setattr(DiscoveryService, "get_devices", seeded)

    app = create_app()
    client = BluOSClient(settings)
    client.set_volume = AsyncMock(return_value=True)  # type: ignore[method-assign]
    events = EventBus()
    discovery = DiscoveryService(settings, client)
    players = [
        PlayerStatus(id="player-a", ip="192.168.1.10", name="A", status="online", volume=5),
        PlayerStatus(id="player-b", ip="192.168.1.11", name="B", status="online", volume=20),
    ]
    discovery._snapshot.devices = players
    discovery._snapshot.endpoints_by_id = {p.id: p.endpoint for p in players}
    discovery._snapshot.ids_by_endpoint = {p.endpoint: p.id for p in players}
    discovery._snapshot.discovered_at = 1.0
    poller = StatusPoller(settings, discovery, client, events)
    poller.refresh_one = AsyncMock(return_value=None)  # type: ignore[method-assign]
    poller.running = True
    app.state.app_state = AppState(
        settings=settings,
        client=client,
        discovery=discovery,
        events=events,
        poller=poller,
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post("/api/v1/fleet/volume", json={"level": 33})
        assert response.status_code == 200
        body = response.json()
        assert body["level"] == 33
        assert body["succeeded"] == 2
        assert body["failed"] == 0
        assert client.set_volume.await_count == 2
        assert {c.args[0] for c in client.set_volume.await_args_list} == {
            "192.168.1.10:11000",
            "192.168.1.11:11000",
        }
    await client.aclose()


@pytest.mark.asyncio
async def test_fleet_volume_filters_device_ids(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def seeded(self: DiscoveryService, *args, **kwargs):
        return self._snapshot

    monkeypatch.setattr(DiscoveryService, "refresh", seeded)
    monkeypatch.setattr(DiscoveryService, "get_devices", seeded)

    app = create_app()
    client = BluOSClient(settings)
    client.set_volume = AsyncMock(return_value=True)  # type: ignore[method-assign]
    events = EventBus()
    discovery = DiscoveryService(settings, client)
    players = [
        PlayerStatus(id="room-a", ip="192.168.1.10", name="Patio", status="online", volume=5),
        PlayerStatus(
            id="zone-1",
            ip="172.16.10.144",
            port=11000,
            name="Living",
            model="CI S2",
            status="online",
            volume=40,
        ),
        PlayerStatus(
            id="zone-2",
            ip="172.16.10.144",
            port=11010,
            name="Kitchen",
            model="CI S2",
            status="online",
            volume=40,
        ),
    ]
    discovery._snapshot.devices = players
    discovery._snapshot.endpoints_by_id = {p.id: p.endpoint for p in players}
    discovery._snapshot.ids_by_endpoint = {p.endpoint: p.id for p in players}
    discovery._snapshot.discovered_at = 1.0
    poller = StatusPoller(settings, discovery, client, events)
    poller.refresh_one = AsyncMock(return_value=None)  # type: ignore[method-assign]
    poller.running = True
    app.state.app_state = AppState(
        settings=settings,
        client=client,
        discovery=discovery,
        events=events,
        poller=poller,
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post(
            "/api/v1/fleet/volume",
            json={"level": 22, "device_ids": ["zone-1", "zone-2"]},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["succeeded"] == 2
        assert {c.args[0] for c in client.set_volume.await_args_list} == {
            "172.16.10.144:11000",
            "172.16.10.144:11010",
        }
    await client.aclose()


@pytest.mark.asyncio
async def test_fleet_control_does_not_rebrowse_stale_cache(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Mute and volume must use the poller snapshot, not a 5s mDNS+enrich pass."""
    players = [
        PlayerStatus(id="player-a", ip="192.168.1.10", name="A", status="online"),
        PlayerStatus(id="player-b", ip="192.168.1.11", name="B", status="online"),
    ]
    app, client, discovery, _ = await app_with_players(
        settings, monkeypatch, players=players
    )
    discovery._snapshot.discovered_at = 1.0
    client.set_volume = AsyncMock(return_value=True)  # type: ignore[method-assign]
    client.set_mute = AsyncMock(return_value=True)  # type: ignore[method-assign]
    client.stop = AsyncMock(return_value=True)  # type: ignore[method-assign]

    async def forbidden(*_args: object, **_kwargs: object):
        raise AssertionError("fleet control must not call get_devices()")

    monkeypatch.setattr(DiscoveryService, "get_devices", forbidden)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        volume = await http.post("/api/v1/fleet/volume", json={"level": 18})
        assert volume.status_code == 200
        mute = await http.post("/api/v1/fleet/mute", json={"mute": True})
        assert mute.status_code == 200
        stop = await http.post("/api/v1/fleet/stop")
        assert stop.status_code == 200

    assert client.set_volume.await_count == 2
    assert client.set_mute.await_count == 2
    await client.aclose()


@pytest.mark.asyncio
async def test_fleet_mute_skips_offline_rooms(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    players = [
        PlayerStatus(id="live", ip="192.168.1.10", name="Live", status="online"),
        PlayerStatus(id="dead", ip="192.168.1.11", name="Dead", status="offline"),
    ]
    app, client, _, _ = await app_with_players(settings, monkeypatch, players=players)
    client.set_mute = AsyncMock(return_value=True)  # type: ignore[method-assign]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        mute = await http.post("/api/v1/fleet/mute", json={"mute": True})
        assert mute.status_code == 200
        assert mute.json()["succeeded"] == 1
        assert client.set_mute.await_count == 1
        assert client.set_mute.await_args_list[0].args[0] == "192.168.1.10:11000"
    await client.aclose()


@pytest.mark.asyncio
async def test_list_and_sync_reads_do_not_browse(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client, discovery, _ = await app_with_players(settings, monkeypatch)
    discovery._snapshot.discovered_at = 1.0

    async def forbidden(*_args: object, **_kwargs: object):
        raise AssertionError("reads must use the live snapshot")

    monkeypatch.setattr(DiscoveryService, "get_devices", forbidden)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        devices = await http.get("/api/v1/devices")
        assert devices.status_code == 200
        assert devices.json()["devices"][0]["id"] == "player-kitchen"
        sync = await http.get("/api/v1/sync")
        assert sync.status_code == 200
        firmware = await http.get("/api/v1/fleet/firmware")
        assert firmware.status_code == 200
    await client.aclose()


@pytest.mark.asyncio
async def test_volume_interrupts_held_status_polls(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client, _, poller = await app_with_players(settings, monkeypatch)
    client.set_volume = AsyncMock(return_value=True)  # type: ignore[method-assign]
    interrupted: list[list[str]] = []

    async def capture(device_ids: list[str]) -> None:
        interrupted.append(list(device_ids))

    monkeypatch.setattr(poller, "interrupt", capture)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post("/api/v1/fleet/volume", json={"level": 12})
        assert response.status_code == 200
    assert interrupted == [["player-kitchen"]]
    await client.aclose()


@pytest.mark.asyncio
async def test_device_play_interrupts_held_status_polls(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client, _, poller = await app_with_players(settings, monkeypatch)
    client.play = AsyncMock(return_value=True)  # type: ignore[method-assign]
    interrupted: list[list[str]] = []

    async def capture(device_ids: list[str]) -> None:
        interrupted.append(list(device_ids))

    monkeypatch.setattr(poller, "interrupt", capture)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post("/api/v1/devices/player-kitchen/play")
        assert response.status_code == 204
    assert interrupted == [["player-kitchen"]]
    await client.aclose()
