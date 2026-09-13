from __future__ import annotations

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
