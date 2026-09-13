"""Multi-room sync group endpoints."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Response, status

from app.api.common import (
    StateDep,
    allow_master_endpoint,
    begin_control,
    clear_playback_after_leave,
    require_device,
    resolve_sync_master,
    sync_donor_endpoints,
)
from app.api.errors import AppError
from app.models import (
    FleetActionResponse,
    FleetVolumeResult,
    PlayerStatus,
    SyncEnableRequest,
    SyncEnableResponse,
    SyncPairRequest,
    SyncState,
)
from app.services.sync import build_sync_state, is_orphan_primary_id

logger = logging.getLogger(__name__)

router = APIRouter()

@router.get("/sync", response_model=SyncState)
async def sync_state(state: StateDep) -> SyncState:
    return build_sync_state(state.discovery.snapshot.devices)


@router.post("/sync/add", status_code=204)
async def sync_add(body: SyncPairRequest, state: StateDep) -> Response:
    master_ip = require_device(state, body.master_id)
    slave_ip = require_device(state, body.slave_id)
    if master_ip == slave_ip:
        raise AppError(400, "invalid_sync_pair", "Master and slave must differ")
    await begin_control(state, [body.master_id, body.slave_id])
    logger.info(
        "control_op",
        extra={
            "op": "sync_add",
            "device_id": body.master_id,
            "device_ip": master_ip,
        },
    )
    ok = await state.client.add_sync_slave(master_ip, slave_ip)
    if not ok:
        logger.warning(
            "control_failed",
            extra={"op": "sync_add", "device_id": body.master_id, "device_ip": master_ip},
        )
        raise AppError(502, "sync_add_failed", "Failed to add sync slave")
    await state.poller.refresh_one(body.master_id)
    await state.poller.refresh_one(body.slave_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/sync/enable", response_model=SyncEnableResponse)
async def sync_enable(body: SyncEnableRequest, state: StateDep) -> SyncEnableResponse:
    """Group all free (standalone) rooms under one primary — never steal from existing groups."""
    primary_ip = require_device(state, body.primary_id)
    snapshot = state.discovery.snapshot
    sync = build_sync_state(snapshot.devices)
    free_ids = set(sync.standalone_ids)
    if body.primary_id not in free_ids and not any(
        g.primary_id == body.primary_id for g in sync.groups
    ):
        # Primary must be free or already leading a group we are expanding.
        raise AppError(400, "primary_not_free", "Primary must be a free room or an existing lead")
    by_id = {d.id: d for d in snapshot.devices}
    slaves = [
        by_id[sid]
        for sid in sorted(free_ids)
        if sid != body.primary_id and sid in by_id and by_id[sid].status == "online"
    ]
    if not slaves:
        raise AppError(400, "no_slaves", "No free players to group under the primary")
    logger.info(
        "control_op",
        extra={"op": "sync_enable", "device_id": body.primary_id, "device_ip": primary_ip},
    )
    await begin_control(state, [body.primary_id, *(slave.id for slave in slaves)])

    async def link_slave(slave: PlayerStatus) -> FleetVolumeResult:
        ok = await state.client.add_sync_slave(primary_ip, slave.endpoint)
        return FleetVolumeResult(device_id=slave.id, name=slave.name, ok=ok)

    link_results = list(await asyncio.gather(*(link_slave(d) for d in slaves)))
    failures = sum(1 for r in link_results if not r.ok)
    if failures == len(link_results):
        logger.warning(
            "control_failed",
            extra={"op": "sync_enable", "device_id": body.primary_id, "device_ip": primary_ip},
        )
        raise AppError(502, "sync_enable_failed", "Failed to enable sync group")
    affected = {body.primary_id, *(d.id for d in slaves)}
    await asyncio.gather(*(state.poller.refresh_one(device_id) for device_id in affected))
    return SyncEnableResponse(
        primary_id=body.primary_id,
        succeeded=len(link_results) - failures,
        failed=failures,
        results=link_results,
    )


@router.post("/sync/remove", status_code=204)
async def sync_remove(body: SyncPairRequest, state: StateDep) -> Response:
    slave_ip = require_device(state, body.slave_id)
    master_ip = resolve_sync_master(state, body.master_id, body.slave_id)
    donors = sync_donor_endpoints(state, master_ip, slave_ip)
    await begin_control(state, [body.master_id, body.slave_id])
    logger.info(
        "control_op",
        extra={"op": "sync_remove", "device_id": body.master_id, "device_ip": master_ip},
    )
    ok = await state.client.remove_sync_slave(
        master_ip,
        slave_ip,
        donor_endpoints=donors,
    )
    if not ok:
        logger.warning(
            "control_failed",
            extra={"op": "sync_remove", "device_id": body.master_id, "device_ip": master_ip},
        )
        raise AppError(502, "sync_remove_failed", "Failed to remove sync slave")
    await clear_playback_after_leave(
        state,
        master_id=body.master_id,
        master_ip=master_ip,
        slave_id=body.slave_id,
        slave_ip=slave_ip,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/sync/break", response_model=FleetActionResponse)
async def sync_break(state: StateDep) -> FleetActionResponse:
    """Dissolve every sync group without a full LAN rediscovery.

    Removes links (including orphans whose primary is offline), stops freed
    players (clears AirPlay capture), then refreshes only the affected devices.
    Partial success returns succeeded/failed counts (502 only when every link fails).
    """
    logger.info("control_op", extra={"op": "sync_break", "device_id": "-", "device_ip": "-"})
    snapshot = state.discovery.snapshot
    sync = build_sync_state(snapshot.devices)
    interrupt_ids = [
        group.primary_id
        for group in sync.groups
        if not is_orphan_primary_id(group.primary_id)
    ]
    for group in sync.groups:
        interrupt_ids.extend(group.slave_ids)
    await begin_control(state, interrupt_ids)
    link_results: list[FleetVolumeResult] = []
    slave_stops: list[tuple[str, str]] = []
    primary_stops: list[tuple[str, str]] = []
    affected: set[str] = set()

    for group in sync.groups:
        if is_orphan_primary_id(group.primary_id):
            master_ip = allow_master_endpoint(
                state,
                group.primary_endpoint or group.primary_ip,
            )
        else:
            master_ip = require_device(state, group.primary_id)
            affected.add(group.primary_id)

        slave_endpoints: list[str] = []
        for slave_id in group.slave_ids:
            slave_endpoints.append(require_device(state, slave_id))
        # Do not use siblings in the same break as reparent donors.
        donors = sync_donor_endpoints(state, master_ip, *slave_endpoints)
        by_id = {d.id: d for d in snapshot.devices}

        async def remove_slave(
            slave_id: str,
            _master_ip: str = master_ip,
            _donors: list[str] = donors,
        ) -> bool:
            slave_ip = require_device(state, slave_id)
            return await state.client.remove_sync_slave(
                _master_ip,
                slave_ip,
                donor_endpoints=_donors,
            )

        # Orphans: serialize reparent so two slaves do not race onto one donor.
        if is_orphan_primary_id(group.primary_id):
            results = [await remove_slave(slave_id) for slave_id in group.slave_ids]
        else:
            results = await asyncio.gather(
                *(remove_slave(slave_id) for slave_id in group.slave_ids)
            )
        removed_any = False
        for slave_id, ok in zip(group.slave_ids, results, strict=True):
            slave = by_id.get(slave_id)
            link_results.append(
                FleetVolumeResult(
                    device_id=slave_id,
                    name=slave.name if slave else slave_id,
                    ok=ok,
                )
            )
            if not ok:
                continue
            removed_any = True
            slave_ip = require_device(state, slave_id)
            slave_stops.append((slave_id, slave_ip))
            affected.add(slave_id)
        # Only stop the primary when it no longer has followers (mirror sync/remove).
        if removed_any and not is_orphan_primary_id(group.primary_id):
            primary = await state.client.get_player_status(
                master_ip,
                device_id=group.primary_id,
            )
            if not primary.slaves:
                primary_stops.append((group.primary_id, master_ip))

    async def _stop(device_id: str, ip: str, role: str) -> None:
        ok = await state.client.stop(ip)
        if not ok:
            logger.warning(
                "stop_after_ungroup_failed",
                extra={"op": "stop", "device_id": device_id, "device_ip": ip, "role": role},
            )

    await asyncio.gather(*(_stop(did, ip, "slave") for did, ip in slave_stops))
    await asyncio.gather(*(_stop(did, ip, "primary") for did, ip in primary_stops))
    await asyncio.gather(*(state.poller.refresh_one(device_id) for device_id in affected))

    succeeded = sum(1 for r in link_results if r.ok)
    failures = sum(1 for r in link_results if not r.ok)
    if failures and succeeded == 0 and link_results:
        logger.warning(
            "control_failed",
            extra={"op": "sync_break", "device_id": "-", "device_ip": "-"},
        )
        raise AppError(502, "sync_break_failed", f"Failed to remove {failures} sync link(s)")
    return FleetActionResponse(
        action="sync_break",
        succeeded=succeeded,
        failed=failures,
        results=link_results,
    )
