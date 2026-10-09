"""Route-level failure paths and edge cases: fleet, sync, Bluetooth, grace, upgrades."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import Settings, get_settings
from app.models import BluetoothResponse, PlayerStatus, SyncRole
from app.services.sync import orphan_primary_id
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
        cors_origins="http://127.0.0.1:8765,http://localhost:8765",
    )


@pytest.mark.asyncio
async def test_fleet_volume_rejects_empty_device_ids(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client, _, _ = await app_with_players(settings, monkeypatch)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post(
            "/api/v1/fleet/volume",
            json={"level": 10, "device_ids": []},
        )
        assert response.status_code == 400
        assert response.json()["code"] == "empty_device_ids"
    await client.aclose()


@pytest.mark.asyncio
async def test_refresh_devices_includes_sync(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    players = [
        PlayerStatus(
            id="primary",
            ip="192.168.1.10",
            name="P",
            status="online",
            sync_role=SyncRole.PRIMARY,
            slaves=["192.168.1.11:11000"],
        ),
        PlayerStatus(
            id="slave",
            ip="192.168.1.11",
            name="S",
            status="online",
            sync_role=SyncRole.SYNCED,
            master="192.168.1.10:11000",
        ),
    ]
    app, client, discovery, _ = await app_with_players(
        settings, monkeypatch, players=players
    )
    published: list[dict] = []

    async def capture(event_type: str, data: object) -> None:
        published.append({"type": event_type, "data": data})

    app.state.app_state.events.publish = capture  # type: ignore[method-assign]
    discovery.refresh = AsyncMock(return_value=discovery.snapshot)  # type: ignore[method-assign]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post("/api/v1/devices/refresh")
        assert response.status_code == 200
    assert published
    assert "sync" in published[0]["data"]
    assert published[0]["data"]["sync"]["groups"]
    await client.aclose()


@pytest.mark.asyncio
async def test_sync_enable_rejects_grouped_slave_as_primary(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    players = [
        PlayerStatus(
            id="primary",
            ip="192.168.1.10",
            name="Lead",
            status="online",
            sync_role=SyncRole.PRIMARY,
            slaves=["192.168.1.11:11000"],
        ),
        PlayerStatus(
            id="slave",
            ip="192.168.1.11",
            name="Follower",
            status="online",
            sync_role=SyncRole.SYNCED,
            master="192.168.1.10:11000",
        ),
        PlayerStatus(
            id="free",
            ip="192.168.1.12",
            name="Free",
            status="online",
            sync_role=SyncRole.STANDALONE,
        ),
    ]
    app, client, _, _ = await app_with_players(settings, monkeypatch, players=players)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post("/api/v1/sync/enable", json={"primary_id": "slave"})
        assert response.status_code == 400
        assert response.json()["code"] == "primary_not_free"
    await client.aclose()


@pytest.mark.asyncio
async def test_volume_adjust_fails_when_live_offline_and_no_cache(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    players = [
        PlayerStatus(
            id="player-kitchen",
            ip="192.168.1.20",
            name="Kitchen",
            status="online",
            volume=40,
        )
    ]
    app, client, discovery, _ = await app_with_players(
        settings, monkeypatch, players=players
    )
    discovery._snapshot.devices = []
    discovery._snapshot.endpoints_by_id = {"player-kitchen": "192.168.1.20:11000"}
    discovery._snapshot.ids_by_endpoint = {"192.168.1.20:11000": "player-kitchen"}
    client.get_player_status = AsyncMock(  # type: ignore[method-assign]
        return_value=PlayerStatus(
            id="player-kitchen",
            ip="192.168.1.20",
            name="Kitchen",
            status="offline",
            volume=0,
        )
    )
    client.adjust_volume = AsyncMock(return_value=True)  # type: ignore[method-assign]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post(
            "/api/v1/devices/player-kitchen/volume/adjust",
            json={"delta": 1},
        )
        assert response.status_code == 502
        assert response.json()["code"] == "bluos_status_failed"
    await client.aclose()


@pytest.mark.asyncio
async def test_bluetooth_post_probe_fail_is_unsupported(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client, _, _ = await app_with_players(settings, monkeypatch)
    client.get_bluetooth_info = AsyncMock(return_value=None)  # type: ignore[method-assign]
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post(
            "/api/v1/devices/player-kitchen/bluetooth",
            json={"mode": 1},
        )
        assert response.status_code == 404
        assert response.json()["code"] == "bluetooth_unsupported"
    await client.aclose()


@pytest.mark.asyncio
async def test_bluetooth_post_interrupts_before_probe(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client, _, poller = await app_with_players(settings, monkeypatch)
    order: list[str] = []

    async def interrupt(device_ids: list[str]) -> None:
        order.append("interrupt")

    async def probe(*_args: object, **_kwargs: object) -> BluetoothResponse:
        order.append("probe")
        return BluetoothResponse(supported=True, mode="Manual")

    client.get_bluetooth_info = AsyncMock(side_effect=probe)  # type: ignore[method-assign]
    client.set_bluetooth_mode = AsyncMock(return_value=True)  # type: ignore[method-assign]
    monkeypatch.setattr(poller, "interrupt", interrupt)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post(
            "/api/v1/devices/player-kitchen/bluetooth",
            json={"mode": 1},
        )
        assert response.status_code == 204
    assert order[:2] == ["interrupt", "probe"]
    await client.aclose()


@pytest.mark.asyncio
async def test_sync_remove_resolves_orphan_primary_id(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    master_ep = "192.168.1.99:11000"
    orphan_id = orphan_primary_id(master_ep)
    players = [
        PlayerStatus(
            id="orphan",
            ip="192.168.1.20",
            name="Orphan",
            status="online",
            sync_role=SyncRole.SYNCED,
            master=master_ep,
        ),
        PlayerStatus(
            id="donor",
            ip="192.168.1.21",
            name="Donor",
            status="online",
            sync_role=SyncRole.STANDALONE,
        ),
    ]
    app, client, _, poller = await app_with_players(
        settings, monkeypatch, players=players
    )
    app.state.app_state.discovery._grace_endpoints["gone"] = master_ep
    app.state.app_state.discovery._grace_until["gone"] = time.time() + 60
    client.remove_sync_slave = AsyncMock(return_value=True)  # type: ignore[method-assign]
    client.stop = AsyncMock(return_value=True)  # type: ignore[method-assign]
    poller.refresh_one = AsyncMock(return_value=None)  # type: ignore[method-assign]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post(
            "/api/v1/sync/remove",
            json={"master_id": orphan_id, "slave_id": "orphan"},
        )
        assert response.status_code == 204
        client.remove_sync_slave.assert_awaited()
        assert client.remove_sync_slave.await_args is not None
        assert client.remove_sync_slave.await_args.args[0] == master_ep
    await client.aclose()


@pytest.mark.asyncio
async def test_fleet_upgrades_marks_disallowed_ip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    settings = Settings(
        discovery_cache_ttl=0,
        poll_interval=60,
        allow_non_private_ips=False,
        control_rate_limit_seconds=0,
        api_rate_limit_seconds=0,
        cors_origins="http://127.0.0.1:8765",
    )
    # Public IP is kept in snapshot only via monkeypatched allow during seed.
    players = [
        PlayerStatus(
            id="public",
            ip="8.8.8.8",
            name="Public",
            status="online",
            fw="1.0.0",
        )
    ]
    # Seed with allow, then flip settings so probe path hits IP-not-allowed.
    seed_settings = Settings(
        discovery_cache_ttl=0,
        poll_interval=60,
        allow_non_private_ips=True,
        control_rate_limit_seconds=0,
        api_rate_limit_seconds=0,
        cors_origins="http://127.0.0.1:8765",
    )
    app, client, _, _ = await app_with_players(seed_settings, monkeypatch, players=players)
    app.state.app_state.settings = settings
    client.get_upgrade_status = AsyncMock(  # type: ignore[method-assign]
        side_effect=AssertionError("should not probe disallowed IP")
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.get("/api/v1/fleet/upgrades")
        assert response.status_code == 200
        body = response.json()
        assert body["failed"] == 1
        assert body["results"][0]["message"] == "IP not allowed"
        assert body["results"][0]["ok"] is False
    await client.aclose()


@pytest.mark.asyncio
async def test_bluetooth_supported_false_post(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client, _, _ = await app_with_players(settings, monkeypatch)
    client.get_bluetooth_info = AsyncMock(  # type: ignore[method-assign]
        return_value=BluetoothResponse(supported=False, mode=None)
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post(
            "/api/v1/devices/player-kitchen/bluetooth",
            json={"mode": 0},
        )
        assert response.status_code == 404
    await client.aclose()


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
