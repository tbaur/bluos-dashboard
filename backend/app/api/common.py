"""Shared API helpers for device targeting, control, and fleet actions."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from typing import Annotated

from fastapi import Depends, Response, status

from app.api.deps import get_state
from app.api.errors import AppError
from app.capabilities import model_has_bluetooth
from app.models import FleetActionResponse, FleetVolumeResult, PlayerStatus, SyncRole
from app.services.sync import build_sync_state, is_orphan_primary_id
from app.state import AppState
from app.validators import DEFAULT_BLUOS_PORT, parse_endpoint, sanitize_ip, validate_device_id

logger = logging.getLogger(__name__)

StateDep = Annotated[AppState, Depends(get_state)]
ControlOp = Callable[[str], Awaitable[bool]]

_pending_refresh: dict[str, asyncio.Task[object]] = {}


def endpoint_host(endpoint: str, *, default_port: int = DEFAULT_BLUOS_PORT) -> str | None:
    host, _port = parse_endpoint(endpoint, default_port=default_port)
    return host


def chassis_representatives(devices: list[PlayerStatus]) -> list[PlayerStatus]:
    """One device per chassis IP (prefer primary BluOS port) for web-UI ops."""
    by_ip: dict[str, PlayerStatus] = {}
    for device in devices:
        existing = by_ip.get(device.ip)
        if existing is None or device.port < existing.port:
            by_ip[device.ip] = device
    return list(by_ip.values())


def require_device(state: AppState, device_id: str) -> str:
    """Return canonical BluOS endpoint (``ip:port``) for a known device id."""
    if not validate_device_id(device_id):
        raise AppError(400, "invalid_device_id", "Device id format is invalid")
    if not state.discovery.is_known_id(device_id):
        raise AppError(404, "device_not_found", "Device is not in the discovered set")
    endpoint = state.discovery.resolve_endpoint(device_id)
    if not endpoint:
        raise AppError(404, "device_not_found", "Device endpoint could not be resolved")
    host = endpoint_host(endpoint, default_port=state.settings.bluos_port)
    if not host or not state.settings.is_allowed_device_ip(host):
        raise AppError(403, "ip_not_allowed", "Device IP is outside the allowed range")
    if state.discovery.is_in_grace(device_id):
        logger.warning(
            "control_during_grace",
            extra={"op": "resolve", "device_id": device_id, "device_ip": endpoint},
        )
    return endpoint


def allow_master_endpoint(state: AppState, endpoint: str) -> str:
    """Validate a master endpoint that may not be in the discovered set."""
    host = endpoint_host(endpoint, default_port=state.settings.bluos_port)
    if not host or not sanitize_ip(host):
        raise AppError(400, "invalid_master", "Master endpoint is invalid")
    if not state.settings.is_allowed_device_ip(host):
        raise AppError(403, "ip_not_allowed", "Device IP is outside the allowed range")
    return endpoint


def resolve_sync_master(state: AppState, master_id: str, slave_id: str) -> str:
    """Resolve primary endpoint for ungroup — including offline/orphan primaries."""
    if state.discovery.is_known_id(master_id):
        return require_device(state, master_id)

    snapshot = state.discovery.snapshot
    if is_orphan_primary_id(master_id):
        for group in build_sync_state(snapshot.devices).groups:
            if group.primary_id == master_id and group.primary_endpoint:
                return allow_master_endpoint(state, group.primary_endpoint)

    slave = next((d for d in snapshot.devices if d.id == slave_id), None)
    if slave and slave.master:
        return allow_master_endpoint(state, slave.master)

    if not validate_device_id(master_id):
        raise AppError(400, "invalid_device_id", "Device id format is invalid")
    raise AppError(404, "device_not_found", "Device is not in the discovered set")


def sync_donor_endpoints(state: AppState, *exclude: str) -> list[str]:
    """Live standalones only — never reparent onto another group's members."""
    excluded = {ep for ep in exclude if ep}
    sync = build_sync_state(state.discovery.snapshot.devices)
    free_ids = set(sync.standalone_ids)
    return [
        d.endpoint
        for d in state.discovery.snapshot.devices
        if d.endpoint
        and d.endpoint not in excluded
        and d.id in free_ids
        and d.sync_role == SyncRole.STANDALONE
    ]


def schedule_refresh(state: AppState, device_id: str) -> None:
    """Coalesce fire-and-forget status refreshes per device."""
    existing = _pending_refresh.get(device_id)
    if existing is not None and not existing.done():
        return

    task: asyncio.Task[object] = asyncio.create_task(
        state.poller.refresh_one(device_id),
        name=f"refresh-{device_id}",
    )
    _pending_refresh[device_id] = task

    def _done(done: asyncio.Task[object]) -> None:
        current = _pending_refresh.get(device_id)
        if current is done:
            _pending_refresh.pop(device_id, None)
        try:
            exc = done.exception()
        except asyncio.CancelledError:
            return
        if exc is not None:
            logger.warning(
                "refresh_one_failed",
                extra={"device_id": device_id},
                exc_info=exc,
            )

    task.add_done_callback(_done)


async def drain_pending_refreshes() -> None:
    """Cancel and await in-flight refreshes so shutdown leaves no live tasks."""
    tasks = [task for task in _pending_refresh.values() if not task.done()]
    _pending_refresh.clear()
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def begin_control(state: AppState, device_ids: Sequence[str]) -> None:
    """Free held Status long-polls before a command hits the same players."""
    await state.poller.interrupt(device_ids)


async def run_control(state: AppState, device_id: str, op_name: str, coro: ControlOp) -> Response:
    ip = require_device(state, device_id)
    logger.info(
        "control_op",
        extra={"op": op_name, "device_id": device_id, "device_ip": ip},
    )
    await begin_control(state, [device_id])
    ok = await coro(ip)
    if not ok:
        logger.warning(
            "control_failed",
            extra={"op": op_name, "device_id": device_id, "device_ip": ip},
        )
        raise AppError(502, "bluos_control_failed", f"BluOS {op_name} failed")
    schedule_refresh(state, device_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def fleet_action(
    state: AppState,
    action: str,
    run: ControlOp,
    *,
    devices: list[PlayerStatus] | None = None,
) -> FleetActionResponse:
    """Run a BluOS (or chassis) control against each target endpoint."""
    if devices is None:
        devices = state.discovery.control_devices()
    if not devices:
        raise AppError(404, "no_devices", "No discovered devices to control")

    await begin_control(state, [device.id for device in devices])
    default_port = state.settings.bluos_port

    async def one(device_id: str, name: str, endpoint: str) -> FleetVolumeResult:
        host = endpoint_host(endpoint, default_port=default_port)
        if not host or not state.settings.is_allowed_device_ip(host):
            return FleetVolumeResult(device_id=device_id, name=name, ok=False)
        logger.info(
            "control_op",
            extra={"op": f"fleet_{action}", "device_id": device_id, "device_ip": endpoint},
        )
        ok = await run(endpoint)
        if ok:
            schedule_refresh(state, device_id)
        else:
            logger.warning(
                "control_failed",
                extra={
                    "op": f"fleet_{action}",
                    "device_id": device_id,
                    "device_ip": endpoint,
                },
            )
        return FleetVolumeResult(device_id=device_id, name=name, ok=ok)

    results = await asyncio.gather(*(one(d.id, d.name, d.endpoint) for d in devices))
    succeeded = sum(1 for r in results if r.ok)
    failed = len(results) - succeeded
    logger.info(
        "fleet_action_complete",
        extra={"action": action, "succeeded": succeeded, "failed": failed},
    )
    if succeeded == 0:
        raise AppError(502, "fleet_action_failed", f"Failed to {action} on all devices")
    return FleetActionResponse(
        action=action,
        succeeded=succeeded,
        failed=failed,
        results=list(results),
    )


def bluetooth_unsupported_by_model(state: AppState, device_id: str) -> bool:
    device = state.discovery.get_device(device_id)
    if device is None:
        return False
    return (
        model_has_bluetooth(
            model=device.model,
            brand=device.brand,
            full_model=device.full_model,
        )
        is False
    )


async def clear_playback_after_leave(
    state: AppState,
    *,
    master_id: str,
    master_ip: str,
    slave_id: str,
    slave_ip: str,
) -> None:
    """Stop freed players so leftover AirPlay/capture sessions do not linger."""
    await begin_control(state, [master_id, slave_id])
    slave_stopped = await state.client.stop(slave_ip)
    if not slave_stopped:
        logger.warning(
            "stop_after_ungroup_failed",
            extra={"op": "stop", "device_id": slave_id, "device_ip": slave_ip, "role": "slave"},
        )
    if not is_orphan_primary_id(master_id):
        primary = await state.client.get_player_status(master_ip, device_id=master_id)
        if not primary.slaves:
            master_stopped = await state.client.stop(master_ip)
            if not master_stopped:
                logger.warning(
                    "stop_after_ungroup_failed",
                    extra={
                        "op": "stop",
                        "device_id": master_id,
                        "device_ip": master_ip,
                        "role": "primary",
                    },
                )
        await state.poller.refresh_one(master_id)
    await state.poller.refresh_one(slave_id)
