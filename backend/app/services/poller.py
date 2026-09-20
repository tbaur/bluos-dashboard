"""Background status poller with per-device etag long-poll."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Sequence
from typing import Any

from app.bluos.client import BluOSClient
from app.bluos.status import PlayerSnapshot
from app.config import Settings
from app.discovery.service import DiscoveryService
from app.models import PlayerStatus
from app.services.events import EventBus
from app.services.health import HealthLog
from app.services.sync import build_sync_state

logger = logging.getLogger(__name__)


class StatusPoller:
    def __init__(
        self,
        settings: Settings,
        discovery: DiscoveryService,
        client: BluOSClient,
        events: EventBus,
    ) -> None:
        self.settings = settings
        self.discovery = discovery
        self.client = client
        self.events = events
        self.health = HealthLog(circuit_threshold=settings.circuit_failure_threshold)
        self._task: asyncio.Task[None] | None = None
        self._watchers: dict[str, asyncio.Task[None]] = {}
        self._in_flight: dict[str, asyncio.Task[PlayerSnapshot]] = {}
        self._control_holdoff_until: dict[str, float] = {}
        self._stop = asyncio.Event()
        self._failures: dict[str, int] = {}
        self._next_due: dict[str, float] = {}
        self._status_etags: dict[str, str] = {}
        self._sync_stats: dict[str, str] = {}
        self._last_status_at: dict[str, float] = {}
        self.running = False
        self.last_poll_at: float | None = None
        # Full text stays process-local (logs only); `last_error_kind` is the
        # exception class name, safe to expose on the unauthenticated /readyz.
        self.last_error: str | None = None
        self.last_error_kind: str | None = None

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="status-poller")
        self.running = True

    async def stop(self) -> None:
        self._stop.set()
        await self._cancel_watchers()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self.running = False

    def fleet_payload(self) -> dict[str, Any]:
        snapshot = self.discovery.snapshot
        return {
            "devices": [d.model_dump() for d in snapshot.devices],
            "discovered_at": snapshot.discovered_at,
            "sync": build_sync_state(snapshot.devices).model_dump(),
            "health": self.health.snapshot().model_dump(),
        }

    async def refresh_one(self, device_id: str) -> PlayerStatus | None:
        endpoint = self.discovery.resolve_endpoint(device_id)
        if not endpoint:
            return None
        existing = self.discovery.get_device(device_id)
        if existing is not None and existing.status == "online":
            self.health.note_seen_online(existing.id, time.time())
        snap = await self.client.load_player(endpoint, device_id=device_id)
        self._remember_tags(device_id, snap)
        self._record_result(snap.player)
        fleet_before = self._fleet_signature()
        await self.discovery.update_device(snap.player)
        stored = self.discovery.get_device(device_id) or snap.player
        if self._fleet_signature() == fleet_before:
            await self.events.publish("device", stored.model_dump())
        else:
            await self.events.publish("fleet", self.fleet_payload())
        return stored

    async def interrupt(self, device_ids: Sequence[str]) -> None:
        """Drop held Status long-polls so a control request can use the player.

        Cancelling the in-flight read closes that socket. The player can then
        accept ``/Volume`` or ``/Skip`` instead of queueing behind a 100s hold.
        Interrupt is not a poll failure — the room stays online.
        """
        now = time.monotonic()
        hold_until = now + self.settings.long_poll_gap_seconds
        tasks: list[asyncio.Task[PlayerSnapshot]] = []
        for device_id in device_ids:
            # Stamp the v1.7 Status gap from *this* cancel. The previous cycle
            # set _last_status_at at hold start, so the watcher would otherwise
            # open a new 100s poll before /Volume runs.
            self._last_status_at[device_id] = now
            self._control_holdoff_until[device_id] = hold_until
            task = self._in_flight.get(device_id)
            if task is not None and not task.done():
                tasks.append(task)
        for task in tasks:
            task.cancel()
        wait = self.settings.control_interrupt_wait_seconds
        if not tasks or wait <= 0:
            return
        try:
            await asyncio.wait_for(
                asyncio.gather(*tasks, return_exceptions=True),
                timeout=wait,
            )
        except asyncio.TimeoutError:
            logger.debug("control_interrupt_wait_timeout count=%s", len(tasks))

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await self._reconcile()
                self.last_poll_at = time.time()
                self.last_error = None
                self.last_error_kind = None
            except Exception as exc:  # noqa: BLE001
                self.last_error = str(exc)
                self.last_error_kind = type(exc).__name__
                logger.exception("poller_cycle_failed")
            wait = max(0.5, self.settings.long_poll_gap_seconds)
            await self._sleep(wait)

    async def _reconcile(self) -> None:
        await self._maybe_rediscover()
        live_ids = {device.id for device in self.discovery.snapshot.devices}
        for device_id, task in list(self._watchers.items()):
            if device_id not in live_ids or task.done():
                task.cancel()
                self._watchers.pop(device_id, None)
                if device_id not in live_ids:
                    self._forget_device(device_id)
        for device in self.discovery.snapshot.devices:
            existing = self._watchers.get(device.id)
            if existing is None or existing.done():
                self._watchers[device.id] = asyncio.create_task(
                    self._watch_device(device.id),
                    name=f"watch-{device.id}",
                )

    async def _maybe_rediscover(self) -> None:
        """Browse the LAN on the poller clock, never on a mute or volume key."""
        if self.discovery.cache_fresh():
            return
        now = time.monotonic()
        if any(until > now for until in self._control_holdoff_until.values()):
            return
        await self.discovery.refresh()
        await self.events.publish("fleet", self.fleet_payload())

    async def _watch_device(self, device_id: str) -> None:
        while not self._stop.is_set():
            device = self.discovery.get_device(device_id)
            if device is None:
                return
            try:
                await self._cycle_device(device)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("device_watch_failed id=%s", device_id)
                await self._sleep(self.settings.poll_interval)

    async def _poll_once(self) -> None:
        """One sequential status pass (tests). Production uses per-device watchers."""
        for device in list(self.discovery.snapshot.devices):
            await self._cycle_device(device)

    async def _cycle_device(self, device: PlayerStatus) -> None:
        await self._wait_until_due(device.id)
        if self._stop.is_set():
            return
        await self._wait_gap(device.id)
        if self._stop.is_set():
            return
        if device.status == "online":
            self.health.note_seen_online(device.id, time.time())
        self._last_status_at[device.id] = time.monotonic()
        fleet_before = self._fleet_signature()
        try:
            snap = await self._fetch_snapshot(device)
        except asyncio.CancelledError:
            if self._stop.is_set():
                raise
            return
        except Exception as exc:
            player = self._apply_poll_result(device, exc)
            self._forget_tags(device.id)
        else:
            self._remember_tags(device.id, snap)
            player = self._apply_poll_result(device, snap.player)
        await self.discovery.update_device(player)
        stored = self.discovery.get_device(device.id) or player
        self.last_poll_at = time.time()
        # A track or seek tick only moves one player; sending the whole fleet on
        # every poll costs O(devices) serialization and re-renders the whole UI.
        if self._fleet_signature() == fleet_before:
            await self.events.publish("device", stored.model_dump())
        else:
            await self.events.publish("fleet", self.fleet_payload())

    def _fleet_signature(self) -> tuple[object, ...]:
        """Fields that change the fleet-level payload (sync graph + health)."""
        return (
            self.health.revision,
            tuple(
                (d.id, d.name, d.endpoint, d.sync_role, tuple(d.slaves), d.master, d.status)
                for d in self.discovery.snapshot.devices
            ),
        )

    async def _fetch_snapshot(self, device: PlayerStatus) -> PlayerSnapshot:
        task = asyncio.create_task(
            self._load_player(device),
            name=f"status-{device.id}",
        )
        self._in_flight[device.id] = task
        try:
            return await task
        except asyncio.CancelledError:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            raise
        finally:
            if self._in_flight.get(device.id) is task:
                self._in_flight.pop(device.id, None)

    async def _load_player(self, device: PlayerStatus) -> PlayerSnapshot:
        etag = self._status_etags.get(device.id)
        wait = self.settings.status_long_poll_seconds if etag else None
        return await self.client.load_player(
            device.endpoint,
            device_id=device.id,
            status_etag=etag,
            sync_stat=self._sync_stats.get(device.id),
            previous=device if etag else None,
            long_poll_seconds=wait,
        )

    def _apply_poll_result(self, device: PlayerStatus, result: object) -> PlayerStatus:
        if isinstance(result, Exception):
            logger.debug("poll_device_error id=%s err=%s", device.id, result)
            offline = device.model_copy(
                update={
                    "status": "offline",
                    "consecutive_failures": device.consecutive_failures + 1,
                }
            )
            self._record_result(offline)
            return offline
        if isinstance(result, PlayerStatus):
            self._record_result(result)
            return result
        raise TypeError(f"unexpected poll result: {type(result)!r}")

    def _record_result(self, player: PlayerStatus) -> None:
        now = time.monotonic()
        prev_failures = self._failures.get(player.id, 0)
        if player.status == "online":
            self._failures[player.id] = 0
            player.consecutive_failures = 0
            self._next_due[player.id] = now
        else:
            failures = prev_failures + 1
            self._failures[player.id] = failures
            player.consecutive_failures = failures
            delay = (
                self.settings.circuit_slow_poll_seconds
                if failures >= self.settings.circuit_failure_threshold
                else self.settings.poll_interval
            )
            self._next_due[player.id] = now + delay
        self.health.observe(player, previous_failures=prev_failures, now=time.time())

    def _remember_tags(self, device_id: str, snap: PlayerSnapshot) -> None:
        if snap.player.status != "online":
            self._forget_tags(device_id)
            return
        if snap.status_etag:
            self._status_etags[device_id] = snap.status_etag
        if snap.sync_stat:
            self._sync_stats[device_id] = snap.sync_stat

    def _forget_tags(self, device_id: str) -> None:
        self._status_etags.pop(device_id, None)
        self._sync_stats.pop(device_id, None)

    def _forget_device(self, device_id: str) -> None:
        inflight = self._in_flight.pop(device_id, None)
        if inflight is not None and not inflight.done():
            inflight.cancel()
        self._forget_tags(device_id)
        self._last_status_at.pop(device_id, None)
        self._control_holdoff_until.pop(device_id, None)
        self._failures.pop(device_id, None)
        self._next_due.pop(device_id, None)
        self.health.forget(device_id)

    async def _cancel_watchers(self) -> None:
        tasks = list(self._watchers.values())
        self._watchers.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _wait_until_due(self, device_id: str) -> None:
        due = self._next_due.get(device_id, 0.0)
        await self._sleep(due - time.monotonic())

    async def _wait_gap(self, device_id: str) -> None:
        now = time.monotonic()
        last = self._last_status_at.get(device_id)
        gap_until = (
            last + self.settings.long_poll_gap_seconds if last is not None else 0.0
        )
        hold_until = self._control_holdoff_until.get(device_id, 0.0)
        await self._sleep(max(gap_until, hold_until) - now)

    async def _sleep(self, seconds: float) -> None:
        if seconds <= 0 or self._stop.is_set():
            return
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            return
