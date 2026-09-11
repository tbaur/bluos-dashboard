"""HTTP transport for BluOS and device web-UI calls."""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urljoin, urlparse

import httpx

from app.bluos.rate_limit import RateLimiter
from app.config import Settings
from app.validators import format_endpoint, parse_endpoint, sanitize_ip

logger = logging.getLogger(__name__)

_MAX_REDIRECTS = 5
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})


class BluOSTransport:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self._owns_client = client is None
        # Manual redirects so each Location host is re-validated (BluOS may
        # 301 /Settings from :11000 -> :11001 on the same device IP).
        # Keepalive room for per-player Status long-polls plus control calls.
        pool = max(48, settings.max_concurrent_device_calls + 24)
        self._client = client or httpx.AsyncClient(
            timeout=settings.device_http_timeout,
            follow_redirects=False,
            limits=httpx.Limits(max_connections=pool + 16, max_keepalive_connections=pool),
        )
        self._rate = RateLimiter(settings.control_rate_limit_seconds)
        self._sem = asyncio.Semaphore(settings.max_concurrent_device_calls)
        # Short-lived settings page cache so unresolved writes do not double-fetch.
        self._settings_page_cache: dict[tuple[str, str], tuple[float, object]] = {}
        self._settings_page_cache_ttl = 5.0

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _resolve_target(self, target: str) -> tuple[str, int] | None:
        """Parse ``ip`` or ``ip:port`` into a validated ``(ip, port)`` pair."""
        ip, port = parse_endpoint(target, default_port=self.settings.bluos_port)
        if not ip:
            return None
        return ip, port

    def _url(self, ip: str, path: str, query: str = "", *, port: int | None = None) -> str:
        api_port = self.settings.bluos_port if port is None else port
        base = f"http://{ip}:{api_port}{path}"
        return f"{base}?{query}" if query else base

    def _redirect_target_allowed(
        self,
        origin_ip: str,
        current_url: str,
        location: str,
    ) -> str | None:
        """Return absolute next URL if redirect stays on the same allowed device IP."""
        next_url = urljoin(current_url, location)
        parsed = urlparse(next_url)
        if parsed.scheme not in {"http", "https"}:
            return None
        host = parsed.hostname
        if not host:
            return None
        sanitized_host = sanitize_ip(host)
        if not sanitized_host or sanitized_host != origin_ip:
            logger.warning(
                "blocked_redirect_host",
                extra={"device_ip": origin_ip, "redirect_host": host},
            )
            return None
        if not self.settings.is_allowed_device_ip(sanitized_host):
            logger.warning("blocked_non_private_ip", extra={"device_ip": sanitized_host})
            return None
        return next_url

    @asynccontextmanager
    async def _call_slot(self, hold_slot: bool) -> AsyncIterator[None]:
        if hold_slot:
            async with self._sem:
                yield
            return
        yield

    async def _follow_get(
        self,
        origin_ip: str,
        url: str,
        *,
        timeout: float | httpx.Timeout | None = None,
    ) -> httpx.Response | None:
        current = url
        for _ in range(_MAX_REDIRECTS + 1):
            response = (
                await self._client.get(current, timeout=timeout)
                if timeout is not None
                else await self._client.get(current)
            )
            if response.status_code not in _REDIRECT_STATUSES:
                return response
            location = response.headers.get("Location")
            if not location:
                return response
            nxt = self._redirect_target_allowed(origin_ip, current, location)
            if nxt is None:
                return None
            current = nxt
        logger.warning("redirect_limit_exceeded", extra={"device_ip": origin_ip, "url": url})
        return None

    async def _follow_post(
        self,
        origin_ip: str,
        url: str,
        data: dict[str, str],
    ) -> httpx.Response | None:
        current = url
        body = data
        for _ in range(_MAX_REDIRECTS + 1):
            response = await self._client.post(current, data=body)
            if response.status_code not in _REDIRECT_STATUSES:
                return response
            location = response.headers.get("Location")
            if not location:
                return response
            nxt = self._redirect_target_allowed(origin_ip, current, location)
            if nxt is None:
                return None
            current = nxt
            # 303 / non-307/308 redirects switch to GET without body.
            if response.status_code in {301, 302, 303}:
                get_response = await self._follow_get(origin_ip, current)
                return get_response
            body = data
        logger.warning("redirect_limit_exceeded", extra={"device_ip": origin_ip, "url": url})
        return None

    async def _get(
        self,
        target: str,
        path: str,
        *,
        query: str = "",
        retries: int = 3,
        control: bool = False,
        timeout: float | httpx.Timeout | None = None,
        hold_slot: bool = True,
    ) -> bytes | None:
        resolved = self._resolve_target(target)
        if not resolved:
            return None
        sanitized, port = resolved
        endpoint_key = format_endpoint(sanitized, port)
        if not self.settings.is_allowed_device_ip(sanitized):
            logger.warning("blocked_non_private_ip", extra={"device_ip": sanitized})
            return None
        if control:
            await self._rate.wait(endpoint_key)
        url = self._url(sanitized, path, query, port=port)
        last_error: Exception | None = None
        for attempt in range(retries if not control else 1):
            try:
                async with self._call_slot(hold_slot):
                    response = await self._follow_get(sanitized, url, timeout=timeout)
                if response is None:
                    return None
                if response.status_code >= 400:
                    logger.debug(
                        "bluos_http_error endpoint=%s path=%s status=%s",
                        endpoint_key,
                        path,
                        response.status_code,
                    )
                    return None
                content = response.content
                if len(content) > self.settings.max_xml_size:
                    logger.warning(
                        "payload_too_large endpoint=%s path=%s",
                        endpoint_key,
                        path,
                    )
                    return None
                return content
            except (httpx.TimeoutException, httpx.TransportError, OSError) as exc:
                last_error = exc
                if attempt + 1 >= retries or control:
                    break
                # Jitter the backoff: a LAN blip fails every device at once, and
                # a fixed delay would march them all back in lockstep.
                base = min(10.0, (2**attempt) + 0.1)
                await asyncio.sleep(base * (0.5 + random.random() / 2))
        if last_error:
            logger.debug(
                "bluos_request_failed endpoint=%s path=%s err=%s",
                endpoint_key,
                path,
                last_error,
            )
        return None

    async def _post(
        self,
        target: str,
        path: str,
        *,
        data: dict[str, str] | None = None,
        control: bool = False,
    ) -> bool:
        resolved = self._resolve_target(target)
        if not resolved:
            return False
        sanitized, port = resolved
        endpoint_key = format_endpoint(sanitized, port)
        if not self.settings.is_allowed_device_ip(sanitized):
            logger.warning("blocked_non_private_ip", extra={"device_ip": sanitized})
            return False
        if control:
            await self._rate.wait(endpoint_key)
        url = self._url(sanitized, path, port=port)
        try:
            async with self._sem:
                response = await self._follow_post(sanitized, url, data or {})
            return response is not None and response.status_code < 400
        except (httpx.TimeoutException, httpx.TransportError, OSError) as exc:
            logger.debug(
                "bluos_post_failed endpoint=%s path=%s err=%s",
                endpoint_key,
                path,
                exc,
            )
            return False

    async def _get_text(self, ip: str, path: str) -> str | None:
        raw = await self._get(ip, path)
        if raw is None:
            return None
        return raw.decode("utf-8", errors="ignore")

