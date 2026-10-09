"""API token auth, the session cookie, client IPs, and inbound rate limits."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.auth import SESSION_COOKIE, session_cookie_value
from app.config import Settings, get_settings
from app.middleware import _authorized, _client_ip
from app.models import UpgradeStatus
from tests.helpers import app_with_players

TOKEN = b"secret-token"
COOKIE = session_cookie_value(TOKEN)


def _scope(headers: list[tuple[bytes, bytes]], **over: object) -> dict[str, object]:
    scope: dict[str, object] = {
        "path": "/api/v1/devices",
        "method": "GET",
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 12345),
    }
    scope.update(over)
    return scope


def _auth(*headers: tuple[bytes, bytes], **over: object) -> bool:
    return _authorized(_scope(list(headers), **over), TOKEN, COOKIE)


def _cookie(value: bytes) -> tuple[bytes, bytes]:
    return (b"cookie", SESSION_COOKIE.encode() + b"=" + value)


def test_authorized_rejects_non_ascii_without_raising() -> None:
    """Non-ASCII credential bytes must compare False, not raise from compare_digest.

    Driven at the ASGI layer on purpose. A non-ASCII header cannot be sent
    through every httpx version, but uvicorn hands the middleware raw bytes
    regardless, which is exactly the input that used to turn a failed auth
    attempt into a 500.
    """
    # UTF-8 continuation bytes decode to codepoints > 127 under latin-1.
    non_ascii = "\u00e9token".encode()

    assert _auth((b"authorization", b"Bearer " + non_ascii)) is False
    assert _auth((b"x-api-token", non_ascii)) is False
    assert _auth(_cookie(non_ascii)) is False
    # Differing lengths are a plain mismatch, never an error.
    assert _auth((b"authorization", b"Bearer s")) is False
    assert _auth((b"authorization", b"Bearer " + TOKEN)) is True


def test_session_cookie_is_derived_and_needs_the_request_header_on_post() -> None:
    assert COOKIE != TOKEN
    assert _auth(_cookie(COOKIE)) is True
    assert _auth(_cookie(COOKIE), method="POST") is False
    assert _auth(_cookie(COOKIE), (b"x-bsd-request", b"1"), method="POST") is True
    # Every method with side effects needs the header, not only POST.
    for method in ("PUT", "PATCH", "DELETE"):
        assert _auth(_cookie(COOKIE), method=method) is False
    assert _auth(_cookie(COOKIE), method="HEAD") is True
    # The raw token is not a valid cookie.
    assert _auth(_cookie(TOKEN)) is False


def test_token_in_the_query_string_is_not_accepted() -> None:
    """A URL token ends up in history and logs, so SSE authenticates like every other call."""
    assert _auth(path="/api/v1/events", query_string=b"token=" + TOKEN) is False


def test_client_ip_trusts_forwarded_for_only_from_proxies() -> None:
    forwarded = _scope([(b"x-forwarded-for", b"10.0.0.9, 127.0.0.1")])
    assert _client_ip(forwarded, "127.0.0.1", {"127.0.0.1"}) == "10.0.0.9"
    assert _client_ip(forwarded, "192.168.1.50", {"127.0.0.1"}) == "192.168.1.50"
    assert _client_ip(_scope([]), "127.0.0.1", {"127.0.0.1"}) == "127.0.0.1"


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

        session = await http.post(
            "/api/v1/session",
            headers={"Authorization": "Bearer secret-token", "X-BSD-Request": "1"},
        )
        assert session.status_code == 204
        assert session.cookies[SESSION_COOKIE] != "secret-token"

        # The client now holds the issued cookie.
        assert (await http.get("/api/v1/devices")).status_code == 200
        cookie_post = await http.post("/api/v1/fleet/pause")
        assert cookie_post.status_code == 401
        cookie_ok = await http.post(
            "/api/v1/fleet/pause",
            headers={"X-BSD-Request": "1"},
        )
        assert cookie_ok.status_code != 401

        http.cookies.clear()
        http.cookies.set(SESSION_COOKIE, "secret-token")
        assert (await http.get("/api/v1/devices")).status_code == 401
    await client.aclose()
    get_settings.cache_clear()


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
