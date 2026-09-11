"""Remaining API failure paths and discovery service coverage."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import Settings, get_settings
from app.discovery.lsdp import LSDPDevice
from app.discovery.service import DiscoveredEndpoint, DiscoveryService
from app.models import PlayerStatus, SyncRole
from tests.helpers import app_with_players


@pytest.fixture
def settings() -> Settings:
    get_settings.cache_clear()
    return Settings(
        discovery_cache_ttl=0,
        poll_interval=60,
        allow_non_private_ips=True,
        control_rate_limit_seconds=0,
        discovered_grace_ttl=120,
    )


@pytest.mark.asyncio
async def test_invalid_device_id_and_empty_fleet(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, client, discovery, _ = await app_with_players(settings, monkeypatch)
    discovery._snapshot.devices = []
    discovery._snapshot.ips_by_id = {}
    discovery._snapshot.ids_by_ip = {}

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        bad_id = await http.post("/api/v1/devices/bad@id/play")
        assert bad_id.status_code == 400

        empty_vol = await http.post("/api/v1/fleet/volume", json={"level": 10})
        assert empty_vol.status_code == 404
        assert empty_vol.json()["code"] == "no_devices"

        empty_pause = await http.post("/api/v1/fleet/pause")
        assert empty_pause.status_code == 404
    await client.aclose()


@pytest.mark.asyncio
async def test_fleet_all_failures_and_partial(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    players = [
        PlayerStatus(id="a", ip="192.168.1.10", name="A", status="online"),
        PlayerStatus(id="b", ip="192.168.1.11", name="B", status="online"),
    ]
    app, client, _, _ = await app_with_players(settings, monkeypatch, players=players)
    client.set_volume = AsyncMock(side_effect=[False, False])  # type: ignore[method-assign]
    client.pause = AsyncMock(side_effect=[True, False])  # type: ignore[method-assign]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        all_fail = await http.post("/api/v1/fleet/volume", json={"level": 10})
        assert all_fail.status_code == 502

        partial = await http.post("/api/v1/fleet/pause")
        assert partial.status_code == 200
        assert partial.json()["succeeded"] == 1
        assert partial.json()["failed"] == 1
    await client.aclose()


@pytest.mark.asyncio
async def test_sync_failures_and_enable_edges(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    players = [
        PlayerStatus(id="primary", ip="192.168.1.10", name="P", status="online"),
        PlayerStatus(id="slave", ip="192.168.1.11", name="S", status="online"),
    ]
    app, client, _, poller = await app_with_players(settings, monkeypatch, players=players)
    client.add_sync_slave = AsyncMock(return_value=False)  # type: ignore[method-assign]
    poller.refresh_one = AsyncMock(return_value=None)  # type: ignore[method-assign]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        add_fail = await http.post(
            "/api/v1/sync/add",
            json={"master_id": "primary", "slave_id": "slave"},
        )
        assert add_fail.status_code == 502

        enable_fail = await http.post("/api/v1/sync/enable", json={"primary_id": "primary"})
        assert enable_fail.status_code == 502
        assert enable_fail.json()["code"] == "sync_enable_failed"

    # Single device → no slaves
    solo_app, solo_client, _, _ = await app_with_players(settings, monkeypatch)
    transport = ASGITransport(app=solo_app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        no_slaves = await http.post(
            "/api/v1/sync/enable",
            json={"primary_id": "player-kitchen"},
        )
        assert no_slaves.status_code == 400
        assert no_slaves.json()["code"] == "no_slaves"
    await client.aclose()
    await solo_client.aclose()


@pytest.mark.asyncio
async def test_sync_enable_partial_failure(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    players = [
        PlayerStatus(id="primary", ip="192.168.1.10", name="P", status="online"),
        PlayerStatus(id="s1", ip="192.168.1.11", name="S1", status="online"),
        PlayerStatus(id="s2", ip="192.168.1.12", name="S2", status="online"),
    ]
    app, client, _, poller = await app_with_players(settings, monkeypatch, players=players)
    client.add_sync_slave = AsyncMock(side_effect=[True, False])  # type: ignore[method-assign]
    poller.refresh_one = AsyncMock(return_value=None)  # type: ignore[method-assign]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post("/api/v1/sync/enable", json={"primary_id": "primary"})
        assert response.status_code == 200
        body = response.json()
        assert body["succeeded"] == 1
        assert body["failed"] == 1
        assert body["primary_id"] == "primary"
    await client.aclose()


@pytest.mark.asyncio
async def test_get_device_refresh_and_grace_control(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, client, discovery, poller = await app_with_players(settings, monkeypatch)
    grace_id = "player-grace"
    discovery._snapshot.devices = []
    discovery._snapshot.endpoints_by_id = {}
    discovery._grace_until[grace_id] = time.time() + 60
    discovery._grace_endpoints[grace_id] = "192.168.1.99:11000"

    refreshed = PlayerStatus(
        id=grace_id,
        ip="192.168.1.99",
        name="Grace",
        status="online",
    )
    poller.refresh_one = AsyncMock(return_value=refreshed)  # type: ignore[method-assign]
    client.play = AsyncMock(return_value=True)  # type: ignore[method-assign]
    client.get_diagnostics = AsyncMock(return_value={"uptime": "1m"})  # type: ignore[method-assign]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        # Grace-only id: control logs grace path
        play = await http.post(f"/api/v1/devices/{grace_id}/play")
        assert play.status_code == 204

        # Known in map but missing from devices list → refresh_one
        discovery._snapshot.endpoints_by_id[grace_id] = "192.168.1.99:11000"
        discovery._snapshot.devices = []
        got = await http.get(f"/api/v1/devices/{grace_id}")
        assert got.status_code == 200
        assert got.json()["name"] == "Grace"

        diag = await http.get(f"/api/v1/devices/{grace_id}/diagnose")
        assert diag.status_code == 200
        assert diag.json()["uptime"] == "1m"
    await client.aclose()


@pytest.mark.asyncio
async def test_sync_remove_and_break_failures(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    players = [
        PlayerStatus(
            id="primary",
            ip="192.168.1.10",
            name="P",
            status="online",
            slaves=["192.168.1.11:11000"],
            sync_role=SyncRole.PRIMARY,
        ),
        PlayerStatus(
            id="slave",
            ip="192.168.1.11",
            name="S",
            status="online",
            master="192.168.1.10:11000",
            sync_role=SyncRole.SYNCED,
        ),
    ]
    app, client, _, poller = await app_with_players(settings, monkeypatch, players=players)
    client.remove_sync_slave = AsyncMock(return_value=False)  # type: ignore[method-assign]
    poller.refresh_one = AsyncMock(return_value=None)  # type: ignore[method-assign]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        remove_fail = await http.post(
            "/api/v1/sync/remove",
            json={"master_id": "primary", "slave_id": "slave"},
        )
        assert remove_fail.status_code == 502

        break_fail = await http.post("/api/v1/sync/break")
        assert break_fail.status_code == 502
    await client.aclose()


@pytest.mark.asyncio
async def test_discovery_cache_grace_and_enrich_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.bluos.client import BluOSClient

    settings = Settings(
        allow_non_private_ips=True,
        discovery_cache_ttl=60,
        discovery_method="both",
    )
    client = BluOSClient(settings)
    service = DiscoveryService(settings, client)

    async def endpoints(self: DiscoveryService):
        return [DiscoveredEndpoint(ip="192.168.1.20", node_id="n1")], "mdns"

    async def boom(*_a, **_k):
        raise RuntimeError("enrich fail")

    monkeypatch.setattr(DiscoveryService, "_discover_endpoints", endpoints)
    client.get_player_status = AsyncMock(side_effect=boom)  # type: ignore[method-assign]

    snap = await service.refresh()
    # Failed SyncStatus probes are dropped (not kept as error players).
    assert snap.devices == []
    assert snap.discovered_at is not None
    # Empty fleets cache for empty_fleet_rediscovery_seconds (avoid discovery storms).
    cached = await service.get_devices()
    assert cached.devices == []
    assert cached.discovered_at == snap.discovered_at

    # update_device appends unknown player
    extra = PlayerStatus(id="extra", ip="192.168.1.30", name="X", status="online")
    await service.update_device(extra)
    assert any(d.id == "extra" for d in service.snapshot.devices)

    assert service.get_device("missing") is None
    assert service.is_in_grace("extra") is False
    await client.aclose()


@pytest.mark.asyncio
async def test_discover_endpoints_mdns_lsdp_merge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.bluos.client import BluOSClient

    settings = Settings(allow_non_private_ips=False, discovery_method="both")
    client = BluOSClient(settings)
    service = DiscoveryService(settings, client)

    monkeypatch.setattr(
        "app.discovery.service.MDNSDiscovery.discover",
        lambda self: ["192.168.1.10", "8.8.8.8"],
    )
    monkeypatch.setattr(
        "app.discovery.service.LSDPDiscovery.discover",
        lambda self: [
            LSDPDevice(node_id="n10", ip="192.168.1.10", class_id=1),
            LSDPDevice(node_id="n11", ip="192.168.1.11", class_id=1),
        ],
    )

    endpoints, method = await service._discover_endpoints()
    ips = {e.ip for e in endpoints}
    assert ips == {"192.168.1.10", "192.168.1.11"}
    assert "mdns" in method and "lsdp" in method
    # node id merged onto mdns-first endpoint
    assert next(e for e in endpoints if e.ip == "192.168.1.10").node_id == "n10"
    await client.aclose()


def test_config_validators() -> None:
    from pydantic import ValidationError

    assert Settings(host="0.0.0.0").host == "0.0.0.0"
    assert Settings(log_level="debug").log_level == "DEBUG"
    with pytest.raises(ValidationError):
        Settings(host="")
    with pytest.raises(ValidationError):
        Settings(host="not a host!!")
    with pytest.raises(ValidationError):
        Settings(log_level="VERBOSE")
    s = Settings(host="127.0.0.1", enable_openapi=None)
    assert s.openapi_enabled() is True
    s2 = Settings(host="0.0.0.0", enable_openapi=None)
    assert s2.openapi_enabled() is False
    s3 = Settings(enable_openapi=True, host="0.0.0.0")
    assert s3.openapi_enabled() is True
    assert Settings(cors_origins="a, b ,").cors_origin_list() == ["a", "b"]
    assert Settings(allow_non_private_ips=True).is_allowed_device_ip("1.2.3.4") is True
    assert Settings().is_allowed_device_ip("not-ip") is False
    assert Settings().is_allowed_device_ip("::1") is False


def test_get_request_id_helper() -> None:
    from app.api.errors import get_request_id
    from app.logging import request_id_var

    class Req:
        state = type("S", (), {"request_id": "from-state"})()

    assert get_request_id(Req()) == "from-state"  # type: ignore[arg-type]
    token = request_id_var.set("from-ctx")
    try:

        class Bare:
            state = type("S", (), {})()

        assert get_request_id(Bare()) == "from-ctx"  # type: ignore[arg-type]
    finally:
        request_id_var.reset(token)


def test_validators_edge_cases() -> None:
    from app.validators import make_device_id, parse_bluos_host, sanitize_ip

    assert sanitize_ip("") is None
    assert sanitize_ip("192.168.1.1\n") is None
    assert sanitize_ip("999.999.999.999") is None
    assert parse_bluos_host("192.168.1.5:11000") == "192.168.1.5"
    assert parse_bluos_host("") == ""
    # Invalid node_id characters fall back to hash id
    assert make_device_id("192.168.1.1", node_id="!!!").startswith("player-")


@pytest.mark.asyncio
async def test_fleet_upgrades_cache_and_empty(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.models import UpgradeStatus

    app, client, discovery, _ = await app_with_players(settings, monkeypatch)
    client.get_upgrade_status = AsyncMock(  # type: ignore[method-assign]
        return_value=UpgradeStatus(
            device_id="player-kitchen",
            name="Kitchen",
            ip="192.168.1.20",
            current_fw="4.16.6",
            update_available=False,
            message="ok",
            ok=True,
        )
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        first = await http.get("/api/v1/fleet/upgrades")
        second = await http.get("/api/v1/fleet/upgrades")
        assert first.status_code == 200
        assert second.status_code == 200
        assert client.get_upgrade_status.await_count == 1

        discovery._snapshot.devices = []
        discovery._snapshot.ips_by_id = {}
        discovery._snapshot.ids_by_ip = {}
        app.state.app_state.fleet_upgrades_cache = None
        app.state.app_state.fleet_upgrades_cached_at = 0.0
        empty = await http.get("/api/v1/fleet/upgrades")
        assert empty.status_code == 200
        assert empty.json()["checked"] == 0
    await client.aclose()


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
