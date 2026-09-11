"""Auth, empty-fleet cache, fleet volume device_ids, and related gaps."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import Settings, get_settings
from app.models import PlayerStatus, SyncRole, UpgradeStatus
from tests.helpers import app_with_players


@pytest.fixture
def settings() -> Settings:
    get_settings.cache_clear()
    return Settings(
        discovery_cache_ttl=0,
        empty_fleet_rediscovery_seconds=30,
        poll_interval=60,
        allow_non_private_ips=True,
        control_rate_limit_seconds=0,
        api_rate_limit_seconds=0,
        cors_origins="http://127.0.0.1:8765,http://localhost:8765",
    )


def test_authorized_rejects_non_ascii_without_raising() -> None:
    """Non-ASCII token bytes must compare False, not raise from compare_digest.

    Driven at the ASGI layer on purpose. A non-ASCII header cannot be sent
    through every httpx version, but uvicorn hands the middleware raw bytes
    regardless, which is exactly the input that used to turn a failed auth
    attempt into a 500.
    """
    from app.middleware import _authorized

    expected = b"secret-token"
    # UTF-8 continuation bytes decode to codepoints > 127 under latin-1.
    non_ascii = "\u00e9token".encode()

    def scope(**over: object) -> dict[str, object]:
        base: dict[str, object] = {
            "path": "/api/v1/devices",
            "query_string": b"",
            "headers": [],
            "client": ("127.0.0.1", 12345),
        }
        base.update(over)
        return base

    def bearer(value: bytes) -> dict[str, object]:
        return scope(headers=[(b"authorization", b"Bearer " + value)])

    def sse(query_string: bytes) -> dict[str, object]:
        return scope(path="/api/v1/events", query_string=query_string)

    assert _authorized(bearer(non_ascii), expected) is False
    assert _authorized(scope(headers=[(b"x-api-token", non_ascii)]), expected) is False
    # Raw and percent-encoded: parse_qs raised on both below Python 3.13.
    assert _authorized(sse(b"token=" + non_ascii), expected) is False
    assert _authorized(sse(b"token=%C3%A9token"), expected) is False
    # Differing lengths are a plain mismatch, never an error.
    assert _authorized(bearer(b"s"), expected) is False
    # And the correct token still authorizes, by header or by query.
    assert _authorized(bearer(b"secret-token"), expected) is True
    assert _authorized(sse(b"token=secret-token"), expected) is True


def test_query_token_parsing() -> None:
    """The hand-rolled parser has to keep the parse_qs semantics it replaced."""
    from app.middleware import _query_token

    assert _query_token(b"token=abc") == b"abc"
    assert _query_token(b"other=1&token=abc&more=2") == b"abc"
    # First occurrence wins, as parse_qs list ordering did.
    assert _query_token(b"token=first&token=second") == b"first"
    assert _query_token(b"token=a%2Bb") == b"a+b"
    assert _query_token(b"token=a+b") == b"a b"
    assert _query_token(b"token=") == b""
    assert _query_token(b"") is None
    assert _query_token(b"tokenish=abc") is None
    # A bare "token" with no "=" is not a value.
    assert _query_token(b"token") is None


@pytest.mark.asyncio
async def test_api_token_required_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    settings = Settings(
        discovery_cache_ttl=0,
        poll_interval=60,
        allow_non_private_ips=True,
        control_rate_limit_seconds=0,
        api_rate_limit_seconds=0,
        api_token="secret-token",
        cors_origins="http://127.0.0.1:8765",
    )
    # Middleware reads get_settings() at create_app time — pin both import sites.
    monkeypatch.setattr("app.main.get_settings", lambda: settings)
    monkeypatch.setattr("app.middleware.get_settings", lambda: settings)
    app, client, _, _ = await app_with_players(settings, monkeypatch)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        denied = await http.get("/api/v1/devices")
        assert denied.status_code == 401
        assert denied.json()["code"] == "unauthorized"

        ok = await http.get(
            "/api/v1/devices",
            headers={"Authorization": "Bearer secret-token"},
        )
        assert ok.status_code == 200

        health = await http.get("/api/v1/healthz")
        assert health.status_code == 200
    await client.aclose()
    get_settings.cache_clear()


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
async def test_empty_fleet_get_devices_uses_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.bluos.client import BluOSClient
    from app.discovery.service import DiscoveryService

    get_settings.cache_clear()
    settings = Settings(
        allow_non_private_ips=True,
        discovery_cache_ttl=300,
        empty_fleet_rediscovery_seconds=60,
        discovery_method="mdns",
    )
    client = BluOSClient(settings)
    service = DiscoveryService(settings, client)
    calls = {"n": 0}

    async def fake_discover(self: DiscoveryService):
        calls["n"] += 1
        return [], "mdns"

    monkeypatch.setattr(DiscoveryService, "_discover_endpoints", fake_discover)
    first = await service.refresh()
    assert first.devices == []
    assert calls["n"] == 1
    second = await service.get_devices()
    assert second.discovered_at == first.discovered_at
    assert calls["n"] == 1  # cached empty
    await client.aclose()


@pytest.mark.asyncio
async def test_api_token_accepts_x_api_token_and_forwarded_for(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    settings = Settings(
        discovery_cache_ttl=0,
        poll_interval=60,
        allow_non_private_ips=True,
        control_rate_limit_seconds=0,
        api_rate_limit_seconds=0.01,
        api_token="sse-secret",
        trusted_proxies="127.0.0.1",
        cors_origins="http://127.0.0.1:8765",
    )
    monkeypatch.setattr("app.main.get_settings", lambda: settings)
    monkeypatch.setattr("app.middleware.get_settings", lambda: settings)
    app, client, _, _ = await app_with_players(settings, monkeypatch)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        via_header = await http.get(
            "/api/v1/devices",
            headers={"X-API-Token": "sse-secret", "X-Forwarded-For": "10.0.0.9"},
        )
        assert via_header.status_code == 200
        denied_sse = await http.get("/api/v1/events")
        assert denied_sse.status_code == 401
    await client.aclose()
    get_settings.cache_clear()


def test_authorized_accepts_sse_query_token() -> None:
    from app.middleware import _authorized, _client_ip

    scope = {
        "path": "/api/v1/events",
        "query_string": b"token=sse-secret",
        "headers": [],
        "client": ("127.0.0.1", 12345),
    }
    assert _authorized(scope, b"sse-secret") is True
    assert _authorized(scope, b"wrong") is False
    assert _client_ip(scope, "127.0.0.1", {"127.0.0.1"}) == "127.0.0.1"
    scope["headers"] = [(b"x-forwarded-for", b"10.0.0.9, 127.0.0.1")]
    assert _client_ip(scope, "127.0.0.1", {"127.0.0.1"}) == "10.0.0.9"


@pytest.mark.asyncio
async def test_settings_cache_invalidated_after_write(settings: Settings) -> None:
    from app.bluos.client import BluOSClient
    from app.models import DeviceSettingsResponse

    client = BluOSClient(settings)
    client._settings_page_cache[("192.168.1.20:11000", "audio")] = (
        0.0,
        DeviceSettingsResponse(page_id="audio", settings=[]),
    )
    client._get = AsyncMock(return_value=b"<ok/>")  # type: ignore[method-assign]
    ok = await client.set_device_setting(
        "192.168.1.20",
        "eq-treble",
        "3",
        control_path="/Volume",
    )
    assert ok is True
    assert ("192.168.1.20:11000", "audio") not in client._settings_page_cache
    await client.aclose()


@pytest.mark.asyncio
async def test_rate_limiter_prunes_when_over_cap() -> None:
    from app.bluos.client import RateLimiter

    limiter = RateLimiter(0.001, max_keys=4)
    for i in range(8):
        await limiter.wait(f"k{i}")
    assert len(limiter._last) <= 4


@pytest.mark.asyncio
async def test_hot_get_rate_limit_returns_429(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    settings = Settings(
        discovery_cache_ttl=0,
        poll_interval=60,
        allow_non_private_ips=True,
        control_rate_limit_seconds=0,
        api_rate_limit_seconds=5.0,
        cors_origins="http://127.0.0.1:8765",
    )
    monkeypatch.setattr("app.main.get_settings", lambda: settings)
    monkeypatch.setattr("app.middleware.get_settings", lambda: settings)
    app, client, _, _ = await app_with_players(settings, monkeypatch)
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
        assert second.status_code == 429
        body = second.json()
        assert body["code"] == "rate_limited"
        assert second.headers.get("retry-after") == "1"

        devices_a = await http.get("/api/v1/devices")
        devices_b = await http.get("/api/v1/devices")
        assert devices_a.status_code == 200
        assert devices_b.status_code == 200

        sync_a = await http.get("/api/v1/sync")
        sync_b = await http.get("/api/v1/sync")
        assert sync_a.status_code == 200
        assert sync_b.status_code == 200
    await client.aclose()
    get_settings.cache_clear()


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
