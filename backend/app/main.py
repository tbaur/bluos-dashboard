"""FastAPI application entrypoint."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api.common import drain_pending_refreshes
from app.api.errors import AppError
from app.api.routes import router
from app.bluos.client import BluOSClient
from app.config import Settings, get_settings
from app.discovery.service import DiscoveryService
from app.logging import configure_logging, request_id_var
from app.middleware import RequestContextMiddleware
from app.services.events import EventBus
from app.services.poller import StatusPoller
from app.state import AppState

logger = logging.getLogger(__name__)


def _resolve_static_dir(settings: Settings) -> Path:
    if settings.static_dir:
        return Path(settings.static_dir)
    return Path(__file__).resolve().parents[2] / "frontend" / "dist"


def _ui_origin(settings: Settings) -> str:
    origins = settings.cors_origin_list()
    return origins[0] if origins else "http://127.0.0.1:8765"


_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


def warn_if_open_to_network(settings: Settings) -> bool:
    """Log a warning when a non-loopback bind has no API token. Returns True if warned.

    Reboot and stop apply to every discovered player, so an untokened LAN bind
    hands that to any host on the network. Documented as allowed, never silent.
    """
    if settings.host in _LOOPBACK_HOSTS or settings.api_token.strip():
        return False
    logger.warning(
        "insecure_bind host=%s — BSD_API_TOKEN is empty, so every control endpoint "
        "(including fleet reboot) is open to the LAN. Set BSD_API_TOKEN, or bind "
        "127.0.0.1. See docs/CONFIGURATION.md 'Network exposure'.",
        settings.host,
    )
    return True


def _api_home_html(settings: Settings) -> str:
    """Small landing page when the SPA dist is not mounted (typical local API-only)."""
    ui = _ui_origin(settings)
    docs_link = (
        '<a class="btn btn-quiet" href="/api/docs">API docs</a>'
        if settings.openapi_enabled()
        else ""
    )
    # Tokens / type / chrome mirror frontend/src/styles/global.css.
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BluOS Dashboard</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #0c1014;
      --bg-raised: #141a21;
      --chrome: #1b2330;
      --border: #2a3545;
      --text: #e8eef6;
      --muted: #8b9bb0;
      --accent: #3d9cf0;
      --accent-dim: #2a6fad;
      --font-display: "Avenir Next", "Futura", "Century Gothic", sans-serif;
      --font-body: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      --font-mono: "SF Mono", Menlo, Consolas, monospace;
      --radius: 14px;
      --shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
    }}
    * {{ box-sizing: border-box; }}
    html, body {{ margin: 0; min-height: 100%; }}
    body {{
      font-family: var(--font-body);
      background:
        radial-gradient(1200px 600px at 10% -10%, rgba(61, 156, 240, 0.16), transparent 55%),
        radial-gradient(900px 500px at 90% 0%, rgba(62, 207, 142, 0.08), transparent 50%),
        linear-gradient(180deg, #0a0e12 0%, var(--bg) 40%, #0b1218 100%);
      color: var(--text);
    }}
    a {{ color: inherit; text-decoration: none; }}
    .app-shell {{
      max-width: 42rem;
      margin: 0 auto;
      padding: 28px 24px 64px;
    }}
    .app-header {{ margin-bottom: 28px; }}
    .brand {{
      font-family: var(--font-display);
      font-size: clamp(2rem, 4vw, 3rem);
      font-weight: 700;
      letter-spacing: -0.04em;
      margin: 0;
    }}
    .brand-sub {{
      margin: 8px 0 0;
      color: var(--muted);
      max-width: 42ch;
    }}
    .panel {{
      padding: 14px 16px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(27, 35, 48, 0.95), rgba(16, 22, 30, 0.92));
      box-shadow: var(--shadow);
    }}
    .panel-actions {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }}
    .btn {{
      appearance: none;
      display: inline-block;
      border: 1px solid var(--border);
      background: var(--chrome);
      color: var(--text);
      border-radius: 10px;
      padding: 10px 14px;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, filter 120ms ease;
    }}
    .btn:hover {{ background: #243041; border-color: #3a4a60; }}
    .btn-primary {{
      background: linear-gradient(180deg, var(--accent), var(--accent-dim));
      border-color: transparent;
      color: #041018;
      font-weight: 600;
    }}
    .btn-primary:hover {{ filter: brightness(1.06); }}
    .btn-quiet {{
      border-color: transparent;
      background: transparent;
      color: var(--muted);
    }}
    .btn-quiet:hover {{
      border-color: var(--border);
      background: var(--chrome);
      color: var(--text);
    }}
    .meta {{
      margin: 16px 0 0;
      color: var(--muted);
      font-size: 0.78rem;
      font-family: var(--font-mono);
    }}
  </style>
</head>
<body>
  <div class="app-shell">
    <header class="app-header">
      <h1 class="brand">BluOS</h1>
      <p class="brand-sub">
        API is up. In local development the React UI runs separately — open it to control the fleet.
      </p>
    </header>
    <section class="panel">
      <div class="panel-actions">
        <a class="btn btn-primary" href="{ui}/">Open dashboard</a>
        <a class="btn" href="/api/v1/healthz">Health</a>
        <a class="btn" href="/api/v1/version">Version</a>
        {docs_link}
      </div>
      <p class="meta">v{__version__} · API on this port · UI at {ui}</p>
    </section>
  </div>
</body>
</html>
"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)
    warn_if_open_to_network(settings)
    client = BluOSClient(settings)
    events = EventBus(max_queue_size=settings.sse_queue_size)
    discovery = DiscoveryService(settings, client)
    poller = StatusPoller(settings, discovery, client, events)
    app.state.app_state = AppState(
        settings=settings,
        client=client,
        discovery=discovery,
        events=events,
        poller=poller,
    )
    poller.start()
    try:
        await discovery.refresh()
    except Exception:  # noqa: BLE001
        logger.exception("initial_discovery_failed")
    logger.info("app_started host=%s port=%s", settings.host, settings.port)
    try:
        yield
    finally:
        await poller.stop()
        await drain_pending_refreshes()
        await client.aclose()
        logger.info("app_stopped")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="BluOS Dashboard",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs" if settings.openapi_enabled() else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.openapi_enabled() else None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list(),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
    app.add_middleware(RequestContextMiddleware)

    @app.exception_handler(AppError)
    async def app_error_handler(_request: Request, exc: AppError):
        detail = exc.detail if isinstance(exc.detail, dict) else {
            "error": "error",
            "message": str(exc.detail),
            "code": "error",
            "request_id": request_id_var.get("-"),
        }
        return JSONResponse(status_code=exc.status_code, content=detail)

    @app.exception_handler(HTTPException)
    async def http_exception_handler(_request: Request, exc: HTTPException):
        if isinstance(exc.detail, dict) and "code" in exc.detail:
            return JSONResponse(status_code=exc.status_code, content=exc.detail)
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": "http_error",
                "message": str(exc.detail),
                "code": "http_error",
                "request_id": request_id_var.get("-"),
            },
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.exception("unhandled_error")
        request_id = getattr(request.state, "request_id", "-")
        return JSONResponse(
            status_code=500,
            content={
                "error": "internal_error",
                "message": "An unexpected error occurred",
                "code": "internal_error",
                "request_id": request_id,
            },
        )

    app.include_router(router)

    @app.get("/health")
    async def health_alias() -> RedirectResponse:
        """Ops footgun guard: never serve SPA HTML for /health."""
        return RedirectResponse(url="/api/v1/healthz", status_code=307)

    static_dir = _resolve_static_dir(settings)
    index_html = static_dir / "index.html" if static_dir.is_dir() else None

    @app.get("/", response_model=None)
    async def root() -> FileResponse | HTMLResponse:
        """Serve the SPA when built; otherwise a small API home page."""
        if index_html is not None and index_html.is_file():
            return FileResponse(index_html)
        return HTMLResponse(_api_home_html(settings))

    if static_dir.is_dir():
        assets = static_dir / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        @app.get("/{full_path:path}")
        async def spa_fallback(full_path: str):
            if full_path.startswith("api/"):
                return JSONResponse(status_code=404, content={"error": "not_found"})
            if index_html is not None and index_html.is_file():
                return FileResponse(index_html)
            return JSONResponse(status_code=404, content={"error": "ui_not_built"})

    return app


app = create_app()
