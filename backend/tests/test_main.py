"""Ops / security middleware / SSE smoke tests."""

from __future__ import annotations

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


@pytest.fixture
def settings() -> Settings:
    get_settings.cache_clear()
    return Settings(
        discovery_cache_ttl=0,
        poll_interval=60,
        allow_non_private_ips=False,
        cors_origins="http://127.0.0.1:8765,http://localhost:8765",
        sse_keepalive_seconds=0.2,
    )


def _seed_state(app, settings: Settings) -> BluOSClient:
    client = BluOSClient(settings)
    events = EventBus()
    discovery = DiscoveryService(settings, client)
    player = PlayerStatus(
        id="player-kitchen",
        ip="192.168.1.20",
        name="Kitchen",
        status="online",
    )
    discovery._snapshot.devices = [player]
    discovery._snapshot.ips_by_id = {player.id: player.ip}
    discovery._snapshot.ids_by_ip = {player.ip: player.id}
    discovery._snapshot.discovered_at = 1.0
    discovery._snapshot.method_used = "mdns"
    poller = StatusPoller(settings, discovery, client, events)
    poller.running = True
    app.state.app_state = AppState(
        settings=settings,
        client=client,
        discovery=discovery,
        events=events,
        poller=poller,
    )
    return client


async def _seeded_app(settings: Settings, monkeypatch: pytest.MonkeyPatch):
    async def seeded(self: DiscoveryService, *args, **kwargs):
        return self._snapshot

    monkeypatch.setattr(DiscoveryService, "refresh", seeded)
    monkeypatch.setattr(DiscoveryService, "get_devices", seeded)
    app = create_app()
    client = _seed_state(app, settings)
    return app, client, app.state.app_state.poller


@pytest.mark.asyncio
async def test_readyz_ok_and_not_ready(settings: Settings, monkeypatch: pytest.MonkeyPatch):
    app, client, poller = await _seeded_app(settings, monkeypatch)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        ok = await http.get("/api/v1/readyz")
        assert ok.status_code == 200
        assert ok.headers.get("X-Content-Type-Options") == "nosniff"
        assert ok.headers.get("X-Frame-Options") == "DENY"
        assert "Content-Security-Policy" in ok.headers
        assert "X-Request-ID" in ok.headers

        poller.running = False
        bad = await http.get("/api/v1/readyz")
        assert bad.status_code == 503
        assert bad.json()["code"] == "not_ready"
    await client.aclose()


@pytest.mark.asyncio
async def test_readyz_does_not_leak_exception_text(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
):
    """/readyz is auth-exempt, so it reports the error class, never its message."""
    app, client, poller = await _seeded_app(settings, monkeypatch)
    poller.last_error = "connect failed at 192.168.1.20:11000 (internal-detail)"
    poller.last_error_kind = "ConnectError"
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.get("/api/v1/readyz")
        assert response.status_code == 200
        details = response.json()["details"]
        assert details["last_error_kind"] == "ConnectError"
        assert "last_error" not in details
        assert "internal-detail" not in response.text
    await client.aclose()


@pytest.mark.asyncio
async def test_ip_not_allowed_when_non_private_disabled(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
):
    app, client, _poller = await _seeded_app(settings, monkeypatch)
    public = PlayerStatus(
        id="player-public",
        ip="8.8.8.8",
        name="Public",
        status="online",
    )
    state: AppState = app.state.app_state
    state.discovery._snapshot.devices = [public]
    state.discovery._snapshot.ips_by_id = {public.id: public.ip}
    state.discovery._snapshot.ids_by_ip = {public.ip: public.id}

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post("/api/v1/devices/player-public/play")
        assert response.status_code == 403
        assert response.json()["code"] == "ip_not_allowed"
    await client.aclose()


@pytest.mark.asyncio
async def test_events_initial_fleet_snapshot(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ASGI-level SSE check: first body chunk is the fleet snapshot, then disconnect.

    httpx ASGITransport deadlocks on long-lived streams (receive waits for
    response_complete while StreamingResponse waits for disconnect), so this
    drives the app protocol directly.
    """
    import asyncio

    app, client, _poller = await _seeded_app(settings, monkeypatch)
    sent: list[dict] = []
    saw_body = asyncio.Event()

    async def receive() -> dict:
        await saw_body.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        sent.append(message)
        if message["type"] == "http.response.body" and message.get("body"):
            saw_body.set()

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "path": "/api/v1/events",
        "raw_path": b"/api/v1/events",
        "root_path": "",
        "scheme": "http",
        "query_string": b"",
        "headers": [(b"host", b"test")],
        "client": ("127.0.0.1", 50000),
        "server": ("test", 80),
        "state": {},
    }

    try:
        await asyncio.wait_for(app(scope, receive, send), timeout=2.0)
    finally:
        await client.aclose()

    start = next(m for m in sent if m["type"] == "http.response.start")
    headers = {k.decode().lower(): v.decode() for k, v in start["headers"]}
    assert "text/event-stream" in headers.get("content-type", "")
    assert headers.get("x-request-id")
    assert headers.get("x-content-type-options") == "nosniff"

    body = b"".join(
        m.get("body", b"") for m in sent if m["type"] == "http.response.body"
    ).decode()
    assert "data:" in body
    assert '"type": "fleet"' in body or '"type":"fleet"' in body
    assert "player-kitchen" in body
