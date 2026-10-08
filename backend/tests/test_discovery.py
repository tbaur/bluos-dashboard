from __future__ import annotations

import time
from unittest.mock import AsyncMock

import pytest

from app.bluos.client import BluOSClient
from app.config import Settings
from app.discovery.service import DiscoveredEndpoint, DiscoveryService, DiscoverySnapshot
from app.models import PlayerStatus


@pytest.mark.asyncio
async def test_control_devices_is_the_live_snapshot() -> None:
    settings = Settings(allow_non_private_ips=True, discovery_cache_ttl=0)
    client = BluOSClient(settings)
    service = DiscoveryService(settings, client)
    online = PlayerStatus(id="a", ip="192.168.1.10", name="A", status="online")
    offline = PlayerStatus(id="b", ip="192.168.1.11", name="B", status="offline")
    service._snapshot.devices = [online, offline]
    assert service.control_devices() == [online]
    assert service.control_devices(["a"]) == [online]
    assert service.control_devices(["b"]) == []
    assert service.control_devices() is not service._snapshot.devices
    await client.aclose()


@pytest.mark.asyncio
async def test_discovery_enrich_uses_client(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(allow_non_private_ips=True, discovery_cache_ttl=0)
    client = BluOSClient(settings)
    service = DiscoveryService(settings, client)

    async def fake_endpoints(self: DiscoveryService):
        return [DiscoveredEndpoint(ip="192.168.1.20", node_id="n1")], "mdns"

    async def fake_status(target: str, device_id: str | None = None, node_id: str = ""):
        host = target.split(":")[0]
        port = int(target.split(":")[1]) if ":" in target else 11000
        return PlayerStatus(
            id=device_id or "player-x",
            ip=host,
            port=port,
            name="Kitchen",
            status="online",
        )

    monkeypatch.setattr(DiscoveryService, "_discover_endpoints", fake_endpoints)
    client.get_player_status = AsyncMock(side_effect=fake_status)  # type: ignore[method-assign]

    snapshot = await service.refresh()
    assert len(snapshot.devices) == 1
    assert snapshot.devices[0].name == "Kitchen"
    assert service.is_known_id(snapshot.devices[0].id)
    await client.aclose()


@pytest.mark.asyncio
async def test_refresh_keeps_live_player_when_enrich_would_miss(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(allow_non_private_ips=True, discovery_cache_ttl=0)
    client = BluOSClient(settings)
    service = DiscoveryService(settings, client)
    live = PlayerStatus(
        id="player-kitchen",
        ip="192.168.1.20",
        name="Kitchen",
        status="online",
        volume=40,
        track="Current",
    )
    service._snapshot.devices = [live]
    service._snapshot.endpoints_by_id = {live.id: live.endpoint}
    service._snapshot.ids_by_endpoint = {live.endpoint: live.id}
    service._snapshot.discovered_at = 1.0

    async def fake_endpoints(self: DiscoveryService):
        return [DiscoveredEndpoint(ip="192.168.1.20", port=11000)], "mdns"

    async def fake_status(*_args: object, **_kwargs: object) -> PlayerStatus:
        raise AssertionError("live players are not re-enriched")

    monkeypatch.setattr(DiscoveryService, "_discover_endpoints", fake_endpoints)
    client.get_player_status = AsyncMock(side_effect=fake_status)  # type: ignore[method-assign]

    snapshot = await service.refresh()
    assert snapshot.devices[0].volume == 40
    assert snapshot.devices[0].track == "Current"
    assert client.get_player_status.await_count == 0
    await client.aclose()


@pytest.mark.asyncio
async def test_refresh_keeps_poll_that_lands_during_enrich(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(allow_non_private_ips=True, discovery_cache_ttl=0)
    client = BluOSClient(settings)
    service = DiscoveryService(settings, client)

    async def fake_endpoints(self: DiscoveryService):
        return [DiscoveredEndpoint(ip="192.168.1.21", port=11000, node_id="n2")], "mdns"

    async def fake_status(target: str, device_id: str | None = None, node_id: str = ""):
        host = target.split(":")[0]
        # A poll publishes a newer volume while enrich is in flight.
        await service.update_device(
            PlayerStatus(
                id=device_id or "player-new",
                ip=host,
                name="Patio",
                status="online",
                volume=7,
            )
        )
        return PlayerStatus(
            id=device_id or "player-new",
            ip=host,
            name="Patio",
            status="online",
            volume=1,
        )

    monkeypatch.setattr(DiscoveryService, "_discover_endpoints", fake_endpoints)
    client.get_player_status = AsyncMock(side_effect=fake_status)  # type: ignore[method-assign]

    snapshot = await service.refresh()
    assert len(snapshot.devices) == 1
    assert snapshot.devices[0].volume == 7
    await client.aclose()


@pytest.mark.asyncio
async def test_grace_mac_mismatch_drops_the_address() -> None:
    from app.api.common import _confirm_grace_mac
    from app.api.errors import AppError
    from app.services.events import EventBus
    from app.services.poller import StatusPoller
    from app.state import AppState

    settings = Settings(allow_non_private_ips=True, control_rate_limit_seconds=0)
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    device_id = "player-grace"
    discovery._grace_endpoints[device_id] = "192.168.1.20:11000"
    discovery._grace_until[device_id] = time.time() + 60
    discovery._grace_macs[device_id] = "90:56:82:00:00:01"
    client.get_player_status = AsyncMock(  # type: ignore[method-assign]
        return_value=PlayerStatus(
            id=device_id,
            ip="192.168.1.20",
            status="online",
            mac="AA:BB:CC:DD:EE:FF",
        )
    )
    state = AppState(
        settings=settings,
        client=client,
        discovery=discovery,
        events=EventBus(),
        poller=StatusPoller(settings, discovery, client, EventBus()),
    )
    with pytest.raises(AppError) as caught:
        await _confirm_grace_mac(state, device_id, "192.168.1.20:11000")
    assert caught.value.status_code == 409
    assert discovery.resolve_endpoint(device_id) is None
    await client.aclose()


@pytest.mark.asyncio
async def test_grace_probe_failure_keeps_the_address() -> None:
    from app.api.common import _confirm_grace_mac
    from app.api.errors import AppError
    from app.services.events import EventBus
    from app.services.poller import StatusPoller
    from app.state import AppState

    settings = Settings(allow_non_private_ips=True, control_rate_limit_seconds=0)
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    device_id = "player-grace"
    discovery._grace_endpoints[device_id] = "192.168.1.20:11000"
    discovery._grace_until[device_id] = time.time() + 60
    discovery._grace_macs[device_id] = "90:56:82:00:00:01"
    client.get_player_status = AsyncMock(  # type: ignore[method-assign]
        return_value=PlayerStatus(id=device_id, ip="192.168.1.20", status="offline", mac="")
    )
    state = AppState(
        settings=settings,
        client=client,
        discovery=discovery,
        events=EventBus(),
        poller=StatusPoller(settings, discovery, client, EventBus()),
    )
    with pytest.raises(AppError) as caught:
        await _confirm_grace_mac(state, device_id, "192.168.1.20:11000")
    assert caught.value.status_code == 409
    assert discovery.resolve_endpoint(device_id) == "192.168.1.20:11000"
    await client.aclose()


@pytest.mark.asyncio
async def test_grace_online_without_mac_still_allows_the_command() -> None:
    from app.api.common import _confirm_grace_mac
    from app.services.events import EventBus
    from app.services.poller import StatusPoller
    from app.state import AppState

    settings = Settings(allow_non_private_ips=True, control_rate_limit_seconds=0)
    client = BluOSClient(settings)
    discovery = DiscoveryService(settings, client)
    device_id = "player-grace"
    discovery._grace_endpoints[device_id] = "192.168.1.20:11000"
    discovery._grace_until[device_id] = time.time() + 60
    discovery._grace_macs[device_id] = "90:56:82:00:00:01"
    client.get_player_status = AsyncMock(  # type: ignore[method-assign]
        return_value=PlayerStatus(id=device_id, ip="192.168.1.20", status="online", mac="")
    )
    state = AppState(
        settings=settings,
        client=client,
        discovery=discovery,
        events=EventBus(),
        poller=StatusPoller(settings, discovery, client, EventBus()),
    )
    await _confirm_grace_mac(state, device_id, "192.168.1.20:11000")
    assert discovery.resolve_endpoint(device_id) == "192.168.1.20:11000"
    await client.aclose()


@pytest.mark.asyncio
async def test_known_endpoint_accepts_a_followers_master_and_unexpired_grace() -> None:
    settings = Settings(allow_non_private_ips=True)
    client = BluOSClient(settings)
    service = DiscoveryService(settings, client)
    service._snapshot.devices = [
        PlayerStatus(
            id="follower",
            ip="192.168.1.21",
            status="online",
            master="192.168.1.55:11000",
            sync_role="synced",
        )
    ]
    assert service.is_known_endpoint("192.168.1.55:11000")
    assert not service.is_known_endpoint("192.168.1.99:11000")
    service._grace_endpoints["old"] = "192.168.1.77:11000"
    service._grace_until["old"] = time.time() - 5
    assert not service.is_known_endpoint("192.168.1.77:11000")
    service._grace_until["old"] = time.time() + 30
    assert service.is_known_endpoint("192.168.1.77:11000")
    await client.aclose()


@pytest.mark.asyncio
async def test_grace_preserves_ip_after_drop(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(
        allow_non_private_ips=True,
        discovery_cache_ttl=0,
        discovered_grace_ttl=120,
    )
    client = BluOSClient(settings)
    service = DiscoveryService(settings, client)
    device_id = "player-grace"
    service._snapshot.endpoints_by_id = {device_id: "192.168.1.55:11000"}
    service._snapshot.devices = [
        PlayerStatus(id=device_id, ip="192.168.1.55", name="Office", status="online"),
    ]
    service._snapshot.discovered_at = 1.0

    async def empty_refresh(self: DiscoveryService, *, force: bool = True):
        now = __import__("time").time()
        self._grace_until[device_id] = now + settings.discovered_grace_ttl
        self._grace_endpoints[device_id] = "192.168.1.55:11000"
        self._snapshot = DiscoverySnapshot(
            devices=[],
            discovered_at=now,
            method_used="mdns",
            endpoints_by_id={},
            ids_by_endpoint={},
        )
        return self._snapshot

    monkeypatch.setattr(DiscoveryService, "_refresh", empty_refresh)
    await service.refresh()
    assert device_id not in service.snapshot.endpoints_by_id
    assert service.is_known_id(device_id)
    assert service.resolve_endpoint(device_id) == "192.168.1.55:11000"
    await client.aclose()
