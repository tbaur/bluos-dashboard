"""Health, readiness, and version endpoints."""

from __future__ import annotations

from fastapi import APIRouter

from app import __version__
from app.api.common import StateDep
from app.api.errors import AppError
from app.models import HealthResponse, VersionInfo

router = APIRouter()

@router.get("/healthz", response_model=HealthResponse)
async def healthz(state: StateDep) -> HealthResponse:
    poller_running = state.poller.running
    return HealthResponse(
        status="ok" if poller_running else "degraded",
        details={"poller_running": poller_running},
    )


@router.get("/readyz", response_model=HealthResponse)
async def readyz(state: StateDep) -> HealthResponse:
    if not state.poller.running:
        raise AppError(503, "not_ready", "Status poller is not running")
    return HealthResponse(
        status="ok",
        details={
            "device_count": len(state.discovery.snapshot.devices),
            "last_poll_at": state.poller.last_poll_at,
            # Class name only — /readyz is auth-exempt, so no exception text.
            "last_error_kind": state.poller.last_error_kind,
            "sse_dropped_events": state.events.dropped_events,
            "sse_subscribers": state.events.subscriber_count,
        },
    )


@router.get("/version", response_model=VersionInfo)
async def version() -> VersionInfo:
    return VersionInfo(version=__version__)
