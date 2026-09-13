"""Coverage and behavior gaps called out by principal review."""

from __future__ import annotations

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
        cors_origins="http://127.0.0.1:8765,http://localhost:8765",
        fleet_upgrades_cache_seconds=30,
        sse_queue_size=16,
    )


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
