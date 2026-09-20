"""Sync graph helpers."""

from __future__ import annotations

import hashlib

from app.models import PlayerStatus, SyncGroup, SyncRole, SyncState
from app.validators import DEFAULT_BLUOS_PORT, parse_endpoint


def orphan_primary_id(master_endpoint: str) -> str:
    """Stable synthetic id for a sync group whose primary is off-network."""
    digest = hashlib.sha256(master_endpoint.encode("utf-8")).hexdigest()[:12]
    return f"orphan-{digest}"


def is_orphan_primary_id(primary_id: str) -> bool:
    return primary_id.startswith("orphan-")


def drop_stale_follower_claims(devices: list[PlayerStatus]) -> list[PlayerStatus]:
    """Treat a follower as standalone when its live primary no longer lists it.

    After RemoveSlave the lead often updates first. The follower can still report
    ``master`` until the next SyncStatus, which left the fleet row saying SYNCED
    after the group graph was already empty.
    """
    by_endpoint = {device.endpoint: device for device in devices}
    updated: list[PlayerStatus] = []
    changed = False
    for device in devices:
        if device.sync_role != SyncRole.SYNCED:
            updated.append(device)
            continue
        master_ep = (device.master or "").strip()
        primary = by_endpoint.get(master_ep) if master_ep else None
        if primary is None or device.endpoint in primary.slaves:
            updated.append(device)
            continue
        changed = True
        updated.append(
            device.model_copy(
                update={
                    "sync_role": SyncRole.STANDALONE,
                    "master": "",
                    "group": "",
                }
            )
        )
    return updated if changed else devices


def build_sync_state(devices: list[PlayerStatus]) -> SyncState:
    by_endpoint = {d.endpoint: d for d in devices}
    groups: list[SyncGroup] = []
    in_group: set[str] = set()

    for device in devices:
        if device.sync_role != SyncRole.PRIMARY and not device.slaves:
            continue
        slave_ids: list[str] = []
        slave_names: list[str] = []
        for slave_ep in device.slaves:
            slave = by_endpoint.get(slave_ep)
            if slave:
                slave_ids.append(slave.id)
                slave_names.append(slave.name)
                in_group.add(slave.id)
        in_group.add(device.id)
        groups.append(
            SyncGroup(
                primary_id=device.id,
                primary_name=device.name,
                primary_ip=device.ip,
                primary_endpoint=device.endpoint,
                group=device.group,
                slave_ids=slave_ids,
                slave_names=slave_names,
            )
        )

    # Orphans: still report a master, but that primary is not on the network.
    # Without this, Break all never sees them and they stay ``reconnecting``.
    orphans_by_master: dict[str, list[PlayerStatus]] = {}
    for device in devices:
        if device.id in in_group:
            continue
        master_ep = (device.master or "").strip()
        if not master_ep or master_ep in by_endpoint:
            continue
        orphans_by_master.setdefault(master_ep, []).append(device)

    for master_ep, members in sorted(orphans_by_master.items()):
        host, _port = parse_endpoint(master_ep, default_port=DEFAULT_BLUOS_PORT)
        for member in members:
            in_group.add(member.id)
        groups.append(
            SyncGroup(
                primary_id=orphan_primary_id(master_ep),
                primary_name="Offline primary",
                primary_ip=host or master_ep,
                primary_endpoint=master_ep,
                group="",
                slave_ids=[m.id for m in members],
                slave_names=[m.name for m in members],
            )
        )

    standalone = [d.id for d in devices if d.id not in in_group]
    return SyncState(groups=groups, standalone_ids=standalone)
