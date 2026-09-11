"""App lifespan, SPA fallback, and exception handlers."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from app.config import Settings, get_settings
from app.discovery.service import DiscoveryService, DiscoverySnapshot
from app.main import create_app
from app.middleware import _DEFAULT_CSP, _SWAGGER_CSP


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    get_settings.cache_clear()
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "app.js").write_text("console.log(1)", encoding="utf-8")
    (tmp_path / "index.html").write_text("<html>ok</html>", encoding="utf-8")
    return Settings(
        discovery_cache_ttl=0,
        poll_interval=60,
        allow_non_private_ips=True,
        static_dir=str(tmp_path),
        enable_openapi=True,
        control_rate_limit_seconds=0,
    )


@pytest.mark.asyncio
async def test_lifespan_starts_and_stops(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def empty_refresh(self: DiscoveryService):
        return DiscoverySnapshot(discovered_at=1.0, method_used="mdns")

    monkeypatch.setattr(DiscoveryService, "refresh", empty_refresh)
    monkeypatch.setattr("app.main.get_settings", lambda: settings)

    app = create_app()
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            health = await http.get("/api/v1/healthz")
            assert health.status_code == 200
            alias = await http.get("/health", follow_redirects=False)
            assert alias.status_code == 307
            assert alias.headers["location"] == "/api/v1/healthz"
            spa = await http.get("/players/kitchen")
            assert spa.status_code == 200
            assert "ok" in spa.text
            api_miss = await http.get("/api/missing")
            assert api_miss.status_code == 404
            assert api_miss.json()["error"] == "not_found"
            asset = await http.get("/assets/app.js")
            assert asset.status_code == 200
            docs = await http.get("/api/docs")
            assert docs.status_code == 200
            assert docs.headers["content-security-policy"] == _SWAGGER_CSP
            assert health.headers["content-security-policy"] == _DEFAULT_CSP


@pytest.mark.asyncio
async def test_lifespan_survives_initial_discovery_failure(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def boom(self: DiscoveryService):
        raise RuntimeError("discovery down")

    monkeypatch.setattr(DiscoveryService, "refresh", boom)
    monkeypatch.setattr("app.main.get_settings", lambda: settings)

    app = create_app()
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            assert (await http.get("/api/v1/healthz")).status_code == 200


@pytest.mark.asyncio
async def test_exception_handlers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    # Nonexistent static_dir → no SPA catch-all stealing /__test/*
    missing = tmp_path / "no-ui"
    settings = Settings(
        discovery_cache_ttl=0,
        poll_interval=60,
        static_dir=str(missing),
        enable_openapi=False,
    )
    monkeypatch.setattr("app.main.get_settings", lambda: settings)
    monkeypatch.setattr(
        DiscoveryService,
        "refresh",
        AsyncMock(return_value=DiscoverySnapshot()),
    )
    app = create_app()

    @app.get("/__test/http")
    async def raise_http() -> None:
        raise HTTPException(status_code=418, detail="teapot")

    @app.get("/__test/http-dict")
    async def raise_http_dict() -> None:
        raise HTTPException(
            status_code=409,
            detail={"error": "conflict", "message": "nope", "code": "conflict", "request_id": "r1"},
        )

    @app.get("/__test/boom")
    async def raise_boom() -> None:
        raise RuntimeError("unexpected")

    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            http_err = await http.get("/__test/http")
            assert http_err.status_code == 418
            assert http_err.json()["code"] == "http_error"

            dict_err = await http.get("/__test/http-dict")
            assert dict_err.status_code == 409
            assert dict_err.json()["code"] == "conflict"

            boom = await http.get("/__test/boom")
            assert boom.status_code == 500
            assert boom.json()["code"] == "internal_error"


@pytest.mark.asyncio
async def test_root_serves_api_home_when_spa_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    get_settings.cache_clear()
    settings = Settings(
        static_dir=str(tmp_path),
        poll_interval=60,
        discovery_cache_ttl=0,
        enable_openapi=True,
        cors_origins="http://127.0.0.1:8765",
    )
    monkeypatch.setattr("app.main.get_settings", lambda: settings)
    monkeypatch.setattr(
        DiscoveryService,
        "refresh",
        AsyncMock(return_value=DiscoverySnapshot()),
    )
    app = create_app()
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            home = await http.get("/")
            assert home.status_code == 200
            assert "text/html" in home.headers["content-type"]
            assert 'class="brand"' in home.text
            assert "BluOS" in home.text
            assert "--font-display" in home.text
            assert "http://127.0.0.1:8765/" in home.text
            assert "/api/docs" in home.text

            # Deep links still report that the SPA was not built.
            deep = await http.get("/players/kitchen")
            assert deep.status_code == 404
            assert deep.json()["error"] == "ui_not_built"


@pytest.mark.asyncio
async def test_root_serves_spa_index_when_built(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        DiscoveryService,
        "refresh",
        AsyncMock(return_value=DiscoverySnapshot()),
    )
    monkeypatch.setattr("app.main.get_settings", lambda: settings)
    app = create_app()
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            response = await http.get("/")
            assert response.status_code == 200
            assert "ok" in response.text


@pytest.mark.parametrize(
    ("host", "token", "expected"),
    [
        ("127.0.0.1", "", False),
        ("localhost", "", False),
        ("::1", "", False),
        ("0.0.0.0", "shared-secret", False),
        ("0.0.0.0", "", True),
        ("192.168.1.50", "", True),
        ("0.0.0.0", "   ", True),
    ],
)
def test_warn_if_open_to_network(host: str, token: str, expected: bool) -> None:
    from app.main import warn_if_open_to_network

    get_settings.cache_clear()
    assert warn_if_open_to_network(Settings(host=host, api_token=token)) is expected


@pytest.mark.asyncio
async def test_drain_pending_refreshes_cancels_in_flight() -> None:
    import asyncio

    from app.api.common import _pending_refresh, drain_pending_refreshes

    started = asyncio.Event()

    async def slow() -> None:
        started.set()
        await asyncio.sleep(60)

    task: asyncio.Task[object] = asyncio.create_task(slow())
    _pending_refresh["device-1"] = task
    await started.wait()

    await drain_pending_refreshes()

    assert task.cancelled()
    assert _pending_refresh == {}
