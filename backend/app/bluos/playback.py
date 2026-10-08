"""Playback and volume control."""

from __future__ import annotations

from app.bluos.result import CallResult
from app.bluos.transport import BluOSTransport


class BluOSPlaybackMixin(BluOSTransport):
    async def _command(self, ip: str, path: str, *, query: str = "") -> bool:
        return self._ok(await self._control_get(ip, path, query=query))

    async def play(self, ip: str) -> bool:
        return await self._command(ip, "/Play")

    async def pause(self, ip: str) -> bool:
        return await self._command(ip, "/Pause")

    async def stop(self, ip: str) -> bool:
        return await self._command(ip, "/Stop")

    async def skip(self, ip: str) -> bool:
        return await self._command(ip, "/Skip")

    async def back(self, ip: str) -> bool:
        return await self._command(ip, "/Back")

    async def toggle(self, ip: str, *, state: str) -> bool:
        if state in ("play", "stream", "connecting"):
            return await self.pause(ip)
        return await self.play(ip)

    async def set_volume(self, ip: str, level: int) -> bool:
        level = max(0, min(100, level))
        return await self._command(ip, "/Volume", query=f"level={level}")

    async def adjust_volume(self, ip: str, delta: int, current_level: int) -> bool:
        level = max(0, min(100, current_level + delta))
        return await self.set_volume(ip, level)

    async def set_mute(self, ip: str, mute: bool) -> bool:
        return await self._command(ip, "/Volume", query=f"mute={1 if mute else 0}")

    async def seek(self, ip: str, seconds: int) -> bool:
        """Seek the current track via BluOS v1.7 GET /Play?seek=."""
        secs = max(0, min(86_400, int(seconds)))
        return await self._command(ip, "/Play", query=f"seek={secs}")

    async def set_shuffle(self, ip: str, state: int) -> bool:
        if state not in (0, 1):
            return self._ok(CallResult.failure("rejected", "invalid shuffle state"))
        return await self._command(ip, "/Shuffle", query=f"state={state}")

    async def set_repeat(self, ip: str, state: int) -> bool:
        if state not in (0, 1, 2):
            return self._ok(CallResult.failure("rejected", "invalid repeat state"))
        return await self._command(ip, "/Repeat", query=f"state={state}")

