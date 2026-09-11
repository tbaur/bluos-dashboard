"""FastAPI route dependencies."""

from __future__ import annotations

from fastapi import Request

from app.state import AppState


async def get_state(request: Request) -> AppState:
    """Async so FastAPI resolves it inline instead of paying a threadpool hop."""
    state = request.app.state.app_state
    if not isinstance(state, AppState):  # pragma: no cover - lifespan guarantees this
        raise RuntimeError("application state is not initialised")
    return state
