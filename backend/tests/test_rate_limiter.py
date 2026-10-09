"""Unit tests for BluOS client helpers."""

from __future__ import annotations

import asyncio
import time

import pytest

from app.bluos.client import RateLimiter
from app.bluos.rate_limit import RateLimiter as RateLimiterDirect


@pytest.mark.asyncio
async def test_rate_limiter_does_not_hold_lock_across_sleep() -> None:
    limiter = RateLimiter(0.05)
    started: list[float] = []

    async def one(key: str) -> None:
        await limiter.wait(key)
        started.append(time.monotonic())

    # Different keys must proceed concurrently even when both need to wait.
    await limiter.wait("a")
    await limiter.wait("b")
    t0 = time.monotonic()
    await asyncio.gather(one("a"), one("b"))
    elapsed = time.monotonic() - t0
    assert elapsed < 0.12
    assert len(started) == 2


@pytest.mark.asyncio
async def test_acquire_returns_false_during_cooldown() -> None:
    limiter = RateLimiterDirect(0.2)
    assert await limiter.acquire("client-a") is True
    assert await limiter.acquire("client-a") is False
    assert await limiter.acquire("client-b") is True


@pytest.mark.asyncio
async def test_rate_limiter_prunes_when_over_cap() -> None:
    from app.bluos.client import RateLimiter

    limiter = RateLimiter(0.001, max_keys=4)
    for i in range(8):
        await limiter.wait(f"k{i}")
    assert len(limiter._last) <= 4
