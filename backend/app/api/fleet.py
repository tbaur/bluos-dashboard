"""House-wide fleet control and firmware."""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter

from app.api.common import (
    StateDep,
    begin_control,
    chassis_representatives,
    endpoint_host,
    fleet_action,
    schedule_refresh,
)
from app.api.errors import AppError
from app.models import (
    FirmwareEntry,
    FleetActionResponse,
    FleetFirmwareResponse,
    FleetHealthResponse,
    FleetUpgradeResponse,
    FleetVolumeResponse,
    FleetVolumeResult,
    MuteRequest,
    PlayerStatus,
    UpgradeStatus,
    VolumeRequest,
)
from app.validators import validate_device_id

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/fleet/health", response_model=FleetHealthResponse)
async def fleet_health(state: StateDep) -> FleetHealthResponse:
    """In-memory drop history from the status poller (this process only)."""
    return state.poller.health.snapshot()


@router.post("/fleet/volume", response_model=FleetVolumeResponse)
async def set_fleet_volume(body: VolumeRequest, state: StateDep) -> FleetVolumeResponse:
    """Set volume on discovered players (optionally filtered by ``device_ids``)."""
    if body.device_ids is not None:
        if not body.device_ids:
            raise AppError(400, "empty_device_ids", "device_ids must be omitted or non-empty")
        for device_id in body.device_ids:
            if not validate_device_id(device_id):
                raise AppError(400, "invalid_device_id", "Device id format is invalid")
        targets = state.discovery.control_devices(body.device_ids)
        if not targets:
            raise AppError(404, "no_devices", "No matching devices to control")
    else:
        targets = state.discovery.control_devices()
        if not targets:
            raise AppError(404, "no_devices", "No discovered devices to control")

    level = body.level
    default_port = state.settings.bluos_port

    async def set_one(device_id: str, name: str, endpoint: str) -> FleetVolumeResult:
        host = endpoint_host(endpoint, default_port=default_port)
        if not host or not state.settings.is_allowed_device_ip(host):
            return FleetVolumeResult(device_id=device_id, name=name, ok=False)
        logger.info(
            "control_op",
            extra={"op": "fleet_volume", "device_id": device_id, "device_ip": endpoint},
        )
        ok = await state.client.set_volume(endpoint, level)
        if ok:
            schedule_refresh(state, device_id)
        else:
            logger.warning(
                "control_failed",
                extra={"op": "fleet_volume", "device_id": device_id, "device_ip": endpoint},
            )
        return FleetVolumeResult(device_id=device_id, name=name, ok=ok)

    logger.info(
        "fleet_volume_targets",
        extra={
            "action": "volume",
            "target_count": len(targets),
            "scoped": bool(body.device_ids),
        },
    )
    await begin_control(state, [device.id for device in targets])
    results = await asyncio.gather(
        *(set_one(d.id, d.name, d.endpoint) for d in targets)
    )
    succeeded = sum(1 for r in results if r.ok)
    failed = len(results) - succeeded
    logger.info(
        "fleet_action_complete",
        extra={"action": "volume", "succeeded": succeeded, "failed": failed},
    )
    if succeeded == 0:
        raise AppError(502, "fleet_volume_failed", "Failed to set volume on all devices")
    return FleetVolumeResponse(
        level=level,
        succeeded=succeeded,
        failed=failed,
        results=list(results),
    )

@router.post("/fleet/mute", response_model=FleetActionResponse)
async def fleet_mute(body: MuteRequest, state: StateDep) -> FleetActionResponse:
    return await fleet_action(
        state,
        "mute" if body.mute else "unmute",
        lambda endpoint: state.client.set_mute(endpoint, body.mute),
    )


@router.post("/fleet/pause", response_model=FleetActionResponse)
async def fleet_pause(state: StateDep) -> FleetActionResponse:
    return await fleet_action(state, "pause", state.client.pause)


@router.post("/fleet/stop", response_model=FleetActionResponse)
async def fleet_stop(state: StateDep) -> FleetActionResponse:
    return await fleet_action(state, "stop", state.client.stop)


@router.post("/fleet/reboot", response_model=FleetActionResponse)
async def fleet_reboot(state: StateDep) -> FleetActionResponse:
    """Reboot each chassis once (device web UI POST /reboot yes=1)."""
    targets = chassis_representatives(state.discovery.control_devices())

    async def run(endpoint: str) -> bool:
        return await state.client.reboot(endpoint)

    return await fleet_action(state, "reboot", run, devices=targets)

@router.get("/fleet/firmware", response_model=FleetFirmwareResponse)
async def fleet_firmware(state: StateDep) -> FleetFirmwareResponse:
    snapshot = state.discovery.snapshot
    devices = [
        FirmwareEntry(
            device_id=d.id,
            name=d.name,
            ip=d.ip,
            port=d.port,
            model=d.full_model or d.model,
            fw=d.fw,
            status=d.status,
        )
        for d in snapshot.devices
    ]
    versions = sorted({d.fw for d in devices if d.fw})
    return FleetFirmwareResponse(
        unique_versions=versions,
        skew=len(versions) > 1,
        devices=devices,
    )


@router.get("/fleet/upgrades", response_model=FleetUpgradeResponse)
async def fleet_upgrades(state: StateDep) -> FleetUpgradeResponse:
    async with state.fleet_upgrades_lock:
        now = time.monotonic()
        cached = state.fleet_upgrades_cache
        if (
            cached is not None
            and (now - state.fleet_upgrades_cached_at)
            < state.settings.fleet_upgrades_cache_seconds
        ):
            return cached

        snapshot = state.discovery.snapshot
        if not snapshot.devices:
            empty = FleetUpgradeResponse(updates_available=0, checked=0, failed=0, results=[])
            state.fleet_upgrades_cache = empty
            state.fleet_upgrades_cached_at = now
            return empty

        # Upgrade status is chassis web-UI scoped; probe once per IP, then fan out
        # so secondary CI zones share the same result without duplicate HTTP calls.
        chassis = chassis_representatives(snapshot.devices)

        async def probe(device: PlayerStatus) -> UpgradeStatus:
            if not state.settings.is_allowed_device_ip(device.ip):
                return UpgradeStatus(
                    device_id=device.id,
                    name=device.name,
                    ip=device.ip,
                    current_fw=device.fw,
                    update_available=False,
                    message="IP not allowed",
                    ok=False,
                )
            return await state.client.get_upgrade_status(
                device.ip,
                device_id=device.id,
                name=device.name,
                current_fw=device.fw,
            )

        probed = list(await asyncio.gather(*(probe(d) for d in chassis)))
        by_ip = {status.ip: status for status in probed}
        results: list[UpgradeStatus] = []
        for device in snapshot.devices:
            base = by_ip.get(device.ip)
            if base is None:
                results.append(
                    UpgradeStatus(
                        device_id=device.id,
                        name=device.name,
                        ip=device.ip,
                        current_fw=device.fw,
                        update_available=False,
                        message="IP not allowed",
                        ok=False,
                    )
                )
                continue
            results.append(
                base.model_copy(
                    update={
                        "device_id": device.id,
                        "name": device.name,
                        "current_fw": device.fw or base.current_fw,
                    }
                )
            )
        failed = sum(1 for r in results if not r.ok)
        updates = sum(1 for r in results if r.ok and r.update_available)
        response = FleetUpgradeResponse(
            updates_available=updates,
            checked=len(results) - failed,
            failed=failed,
            results=results,
        )
        state.fleet_upgrades_cache = response
        state.fleet_upgrades_cached_at = now
        return response
