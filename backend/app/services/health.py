"""In-memory poller presence history (who dropped, when)."""

from __future__ import annotations

import time
from dataclasses import dataclass

from app.models import FleetHealthResponse, PlayerStatus, PresenceDrop

_WINDOW_SECONDS = 86_400
_PRESENCE_WINDOW_SECONDS = 43_200
_MAX_DROPS = 100


@dataclass
class _Drop:
    device_id: str
    name: str
    started_at: float
    ended_at: float | None = None
    peak_failures: int = 1
    slow_poll: bool = False


class HealthLog:
    """Ring of online→offline stretches for the current dashboard process."""

    def __init__(
        self,
        *,
        window_seconds: float = _WINDOW_SECONDS,
        presence_window_seconds: float = _PRESENCE_WINDOW_SECONDS,
        max_drops: int = _MAX_DROPS,
        circuit_threshold: int = 5,
        started_at: float | None = None,
    ) -> None:
        self.window_seconds = window_seconds
        self.presence_window_seconds = presence_window_seconds
        self.max_drops = max_drops
        self.circuit_threshold = circuit_threshold
        self.started_at = started_at if started_at is not None else time.time()
        self._first_online: dict[str, float] = {}
        self._drops: list[_Drop] = []
        # Bumped whenever the snapshot payload would differ, so callers can skip
        # republishing an unchanged fleet.
        self.revision = 0

    def note_seen_online(self, device_id: str, now: float) -> None:
        """Mark a player as known-up so a later failed poll counts as a drop."""
        if device_id not in self._first_online:
            self._first_online[device_id] = now
            self.revision += 1

    def forget(self, device_id: str) -> None:
        """Drop all history for a device that left the network for good."""
        if self._first_online.pop(device_id, None) is not None:
            self.revision += 1
        remaining = [d for d in self._drops if d.device_id != device_id]
        if len(remaining) != len(self._drops):
            self._drops = remaining
            self.revision += 1

    def observe(self, player: PlayerStatus, *, previous_failures: int, now: float) -> None:
        if player.status == "online":
            self.note_seen_online(player.id, now)
            self._close_open_drop(player.id, player.name, now)
            return
        if player.id not in self._first_online:
            return
        open_drop = self._open_for(player.id)
        failures = max(1, player.consecutive_failures, previous_failures + 1)
        if open_drop is None:
            self._drops.append(
                _Drop(
                    device_id=player.id,
                    name=player.name,
                    started_at=now,
                    peak_failures=failures,
                    slow_poll=failures >= self.circuit_threshold,
                )
            )
            self.revision += 1
        else:
            before = (open_drop.name, open_drop.peak_failures, open_drop.slow_poll)
            open_drop.name = player.name or open_drop.name
            open_drop.peak_failures = max(open_drop.peak_failures, failures)
            if failures >= self.circuit_threshold:
                open_drop.slow_poll = True
            if (open_drop.name, open_drop.peak_failures, open_drop.slow_poll) != before:
                self.revision += 1
        self._prune(now)

    def snapshot(self, now: float | None = None) -> FleetHealthResponse:
        wall = time.time() if now is None else now
        self._prune(wall)
        drops = [self._to_model(drop, wall) for drop in reversed(self._drops)]
        return FleetHealthResponse(
            started_at=self.started_at,
            observed_at=wall,
            window_seconds=int(self.window_seconds),
            presence_window_seconds=int(self.presence_window_seconds),
            circuit_failure_threshold=self.circuit_threshold,
            first_online=dict(self._first_online),
            drops=drops,
        )

    def _open_for(self, device_id: str) -> _Drop | None:
        for drop in reversed(self._drops):
            if drop.device_id == device_id and drop.ended_at is None:
                return drop
        return None

    def _close_open_drop(self, device_id: str, name: str, now: float) -> None:
        open_drop = self._open_for(device_id)
        if open_drop is None:
            return
        open_drop.ended_at = now
        if name:
            open_drop.name = name
        self.revision += 1

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_seconds
        kept: list[_Drop] = []
        for drop in self._drops:
            if drop.ended_at is None:
                kept.append(drop)
                continue
            if drop.ended_at >= cutoff:
                kept.append(drop)
        overflow = len(kept) - self.max_drops
        if overflow > 0:
            closed = [d for d in kept if d.ended_at is not None]
            remove = {id(item) for item in closed[:overflow]}
            kept = [d for d in kept if id(d) not in remove]
        if len(kept) != len(self._drops):
            self.revision += 1
        self._drops = kept

    @staticmethod
    def _to_model(drop: _Drop, now: float) -> PresenceDrop:
        end = drop.ended_at if drop.ended_at is not None else now
        return PresenceDrop(
            device_id=drop.device_id,
            name=drop.name,
            started_at=drop.started_at,
            ended_at=drop.ended_at,
            duration_seconds=max(0.0, end - drop.started_at),
            peak_failures=drop.peak_failures,
            slow_poll=drop.slow_poll,
        )
