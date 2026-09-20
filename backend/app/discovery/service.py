"""Orchestrates mDNS/LSDP discovery and BluOS enrichment."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

from app.bluos.client import BluOSClient
from app.config import Settings
from app.discovery.lsdp import LSDPDevice, LSDPDiscovery
from app.discovery.mdns import BLUOS_MDNS_SERVICES, MDNSDiscovery
from app.models import PlayerStatus
from app.services.sync import drop_stale_follower_claims
from app.validators import (
    DEFAULT_BLUOS_PORT,
    format_endpoint,
    make_device_id,
    parse_endpoint,
    sanitize_endpoint,
)

logger = logging.getLogger(__name__)


@dataclass
class DiscoveredEndpoint:
    ip: str
    port: int = DEFAULT_BLUOS_PORT
    node_id: str = ""

    @property
    def endpoint(self) -> str:
        return format_endpoint(self.ip, self.port)


@dataclass
class DiscoverySnapshot:
    devices: list[PlayerStatus] = field(default_factory=list)
    endpoints: dict[str, DiscoveredEndpoint] = field(default_factory=dict)
    discovered_at: float | None = None
    method_used: str = ""
    # device_id -> canonical ip:port
    endpoints_by_id: dict[str, str] = field(default_factory=dict)
    # canonical ip:port -> device_id
    ids_by_endpoint: dict[str, str] = field(default_factory=dict)

    # Backward-compatible aliases used by older tests/helpers.
    @property
    def ips_by_id(self) -> dict[str, str]:
        return self.endpoints_by_id

    @ips_by_id.setter
    def ips_by_id(self, value: dict[str, str]) -> None:
        self.endpoints_by_id = value

    @property
    def ids_by_ip(self) -> dict[str, str]:
        return self.ids_by_endpoint

    @ids_by_ip.setter
    def ids_by_ip(self, value: dict[str, str]) -> None:
        self.ids_by_endpoint = value


class DiscoveryService:
    def __init__(self, settings: Settings, client: BluOSClient) -> None:
        self.settings = settings
        self.client = client
        self._data_lock = asyncio.Lock()
        self._refresh_lock = asyncio.Lock()
        self._snapshot = DiscoverySnapshot()
        self._grace_until: dict[str, float] = {}
        self._grace_endpoints: dict[str, str] = {}

    @property
    def _grace_ips(self) -> dict[str, str]:
        """Alias for older tests; stores canonical endpoints."""
        return self._grace_endpoints

    @_grace_ips.setter
    def _grace_ips(self, value: dict[str, str]) -> None:
        self._grace_endpoints = value

    @property
    def snapshot(self) -> DiscoverySnapshot:
        return self._snapshot

    def is_known_id(self, device_id: str) -> bool:
        if device_id in self._snapshot.endpoints_by_id:
            return True
        return time.time() < self._grace_until.get(device_id, 0.0)

    def is_in_grace(self, device_id: str) -> bool:
        """True when the id is only reachable via discovered-grace TTL."""
        if device_id in self._snapshot.endpoints_by_id:
            return False
        return time.time() < self._grace_until.get(device_id, 0.0)

    def resolve_endpoint(self, device_id: str) -> str | None:
        endpoint = self._snapshot.endpoints_by_id.get(device_id)
        if endpoint:
            return endpoint
        if time.time() < self._grace_until.get(device_id, 0.0):
            return self._grace_endpoints.get(device_id)
        return None

    def resolve_ip(self, device_id: str) -> str | None:
        """Return canonical endpoint (``ip:port``). Name kept for call-site churn."""
        return self.resolve_endpoint(device_id)

    def get_device(self, device_id: str) -> PlayerStatus | None:
        for device in self._snapshot.devices:
            if device.id == device_id:
                return device
        return None

    def control_devices(self, device_ids: list[str] | None = None) -> list[PlayerStatus]:
        """Online players from the live snapshot. Never browses or re-enriches.

        Offline rooms are omitted so a dead player cannot stall mute-all
        behind ``BSD_DEVICE_HTTP_TIMEOUT``.
        """
        devices = list(self._snapshot.devices)
        if device_ids is not None:
            by_id = {device.id: device for device in devices}
            devices = [by_id[device_id] for device_id in device_ids if device_id in by_id]
        return [device for device in devices if device.status == "online"]

    def cache_fresh(self) -> bool:
        """True when the last discovery result (including empty) is still within TTL.

        Empty fleets use ``empty_fleet_rediscovery_seconds`` so API/REST-fallback
        paths do not re-run a full mDNS+LSDP window on every request.
        """
        if self._snapshot.discovered_at is None:
            return False
        age = time.time() - self._snapshot.discovered_at
        if not self._snapshot.devices:
            return age < self.settings.empty_fleet_rediscovery_seconds
        return age < self.settings.discovery_cache_ttl

    async def get_devices(self, *, force: bool = False) -> DiscoverySnapshot:
        async with self._data_lock:
            if not force and self.cache_fresh():
                return self._snapshot
        return await self._refresh(force=force)

    async def refresh(self) -> DiscoverySnapshot:
        """Always run discovery+enrich (used by poller / explicit rescan)."""
        return await self._refresh(force=True)

    async def _refresh(self, *, force: bool) -> DiscoverySnapshot:
        """Discover + enrich outside the data lock; swap snapshot atomically."""
        async with self._refresh_lock:
            async with self._data_lock:
                if not force and self.cache_fresh():
                    return self._snapshot
                previous_ids = set(self._snapshot.endpoints_by_id)
                previous_endpoints = dict(self._snapshot.endpoints_by_id)

            endpoints, method_used = await self._discover_endpoints()
            players = await self._enrich(endpoints)
            now = time.time()

            async with self._data_lock:
                new_ids = {p.id for p in players}
                for missing in previous_ids - new_ids:
                    self._grace_until[missing] = now + self.settings.discovered_grace_ttl
                    grace_ep = previous_endpoints.get(missing)
                    if grace_ep:
                        self._grace_endpoints[missing] = grace_ep
                for present in new_ids:
                    self._grace_until.pop(present, None)
                    self._grace_endpoints.pop(present, None)

                players = drop_stale_follower_claims(players)
                endpoints_by_id = {p.id: p.endpoint for p in players}
                ids_by_endpoint = {p.endpoint: p.id for p in players}
                self._snapshot = DiscoverySnapshot(
                    devices=players,
                    endpoints={e.endpoint: e for e in endpoints},
                    discovered_at=now,
                    method_used=method_used,
                    endpoints_by_id=endpoints_by_id,
                    ids_by_endpoint=ids_by_endpoint,
                )
                logger.info(
                    "discovery_complete count=%s method=%s",
                    len(players),
                    method_used,
                )
                return self._snapshot

    async def _discover_endpoints(self) -> tuple[list[DiscoveredEndpoint], str]:
        method = self.settings.discovery_method
        by_endpoint: dict[str, DiscoveredEndpoint] = {}
        methods_run: list[str] = []

        run_mdns = method in ("mdns", "both")
        run_lsdp = method in ("lsdp", "both")

        mdns_task = (
            asyncio.to_thread(
                MDNSDiscovery(BLUOS_MDNS_SERVICES, self.settings.discovery_timeout).discover
            )
            if run_mdns
            else None
        )
        lsdp_task = (
            asyncio.to_thread(LSDPDiscovery(self.settings.discovery_timeout).discover)
            if run_lsdp
            else None
        )

        mdns_endpoints: list[str] = []
        lsdp_devices: list[LSDPDevice] = []
        if mdns_task is not None and lsdp_task is not None:
            mdns_endpoints, lsdp_devices = await asyncio.gather(mdns_task, lsdp_task)
        elif mdns_task is not None:
            mdns_endpoints = await mdns_task
        elif lsdp_task is not None:
            lsdp_devices = await lsdp_task

        if run_mdns:
            mdns_added = False
            for raw in mdns_endpoints:
                cleaned = sanitize_endpoint(raw, default_port=self.settings.bluos_port)
                if not cleaned:
                    continue
                ip, port = parse_endpoint(cleaned, default_port=self.settings.bluos_port)
                if not ip or not self.settings.is_allowed_device_ip(ip):
                    continue
                by_endpoint[cleaned] = DiscoveredEndpoint(ip=ip, port=port)
                mdns_added = True
            if mdns_added:
                methods_run.append("mdns")

        if run_lsdp:
            lsdp_added = False
            for device in lsdp_devices:
                if not self.settings.is_allowed_device_ip(device.ip):
                    continue
                # LSDP is chassis-level; normalize to primary BluOS port.
                endpoint = format_endpoint(device.ip, self.settings.bluos_port)
                existing = by_endpoint.get(endpoint)
                if existing is None:
                    by_endpoint[endpoint] = DiscoveredEndpoint(
                        ip=device.ip,
                        port=self.settings.bluos_port,
                        node_id=device.node_id,
                    )
                    lsdp_added = True
                elif device.node_id and not existing.node_id:
                    by_endpoint[endpoint] = DiscoveredEndpoint(
                        ip=device.ip,
                        port=self.settings.bluos_port,
                        node_id=device.node_id,
                    )
                    lsdp_added = True
                else:
                    lsdp_added = True
            if lsdp_added:
                methods_run.append("lsdp")

        method_used = "+".join(methods_run) if methods_run else method
        return sorted(by_endpoint.values(), key=lambda e: e.endpoint), method_used

    async def _enrich(self, endpoints: list[DiscoveredEndpoint]) -> list[PlayerStatus]:
        """Keep only endpoints that answer SyncStatus successfully."""

        async def one(endpoint: DiscoveredEndpoint) -> PlayerStatus | None:
            device_id = make_device_id(
                endpoint.ip,
                node_id=endpoint.node_id,
                port=endpoint.port,
            )
            try:
                player = await self.client.get_player_status(
                    endpoint.endpoint,
                    device_id=device_id,
                    node_id=endpoint.node_id,
                )
            except Exception as exc:  # noqa: BLE001 — isolate per device
                logger.debug(
                    "enrich_failed endpoint=%s err=%s",
                    endpoint.endpoint,
                    exc,
                )
                return None
            if player.status != "online":
                logger.debug(
                    "enrich_unverified endpoint=%s status=%s",
                    endpoint.endpoint,
                    player.status,
                )
                return None
            return player

        results = await asyncio.gather(*(one(e) for e in endpoints))
        return [p for p in results if p is not None]

    async def update_device(self, player: PlayerStatus) -> None:
        async with self._data_lock:
            devices = [player if d.id == player.id else d for d in self._snapshot.devices]
            if not any(d.id == player.id for d in self._snapshot.devices):
                devices.append(player)
            self._snapshot.devices = drop_stale_follower_claims(devices)
            self._snapshot.endpoints_by_id[player.id] = player.endpoint
            self._snapshot.ids_by_endpoint[player.endpoint] = player.id
            existing = self._snapshot.endpoints.get(
                player.endpoint,
                DiscoveredEndpoint(player.ip, player.port),
            )
            self._snapshot.endpoints[player.endpoint] = DiscoveredEndpoint(
                ip=player.ip,
                port=player.port,
                node_id=existing.node_id,
            )
