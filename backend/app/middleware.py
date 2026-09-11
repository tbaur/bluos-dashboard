"""ASGI middleware that must not buffer streaming responses (SSE)."""

from __future__ import annotations

import hmac
import logging
import time
import uuid
from urllib.parse import unquote_to_bytes

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.bluos.rate_limit import RateLimiter
from app.config import get_settings
from app.logging import request_id_var

logger = logging.getLogger(__name__)

# Album art is served from BluOS players on the LAN (http://<device>:11000/...).
# CSP cannot express RFC1918 CIDRs, so http: is required for single-process deploys.
_DEFAULT_CSP = (
    "default-src 'self'; "
    "connect-src 'self'; "
    "img-src 'self' data: http:; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; "
    "frame-ancestors 'none'"
)
# FastAPI Swagger UI loads bundle/CSS from jsDelivr and boots with an inline script.
_SWAGGER_CSP = (
    "default-src 'self'; "
    "connect-src 'self'; "
    "img-src 'self' data: https: http:; "
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
    "frame-ancestors 'none'"
)
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
}

# Cheap in-memory GETs (/devices, /sync) overlap on UI mount / Strict Mode;
# 429ing them surfaces "Too many requests" while an earlier load still succeeds.
_EXPENSIVE_GET_PATHS = frozenset({"/api/v1/fleet/upgrades"})
_AUTH_EXEMPT_PATHS = frozenset(
    {
        "/api/v1/healthz",
        "/api/v1/readyz",
        "/api/v1/version",
        "/health",
    }
)


class RequestContextMiddleware:
    """Attach request IDs, security headers, API rate limits, and access logs.

    FastAPI's ``@app.middleware("http")`` uses BaseHTTPMiddleware, which
    buffers responses and breaks Server-Sent Events. This pure ASGI wrapper
    streams through unchanged.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        settings = get_settings()
        self._api_rate = RateLimiter(settings.api_rate_limit_seconds)
        # Bytes, not str: headers arrive as bytes and hmac.compare_digest raises
        # TypeError on str with non-ASCII characters.
        self._api_token = (settings.api_token or "").strip().encode("utf-8")
        self._trusted_proxies = settings.trusted_proxy_set()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "GET")
        path = scope.get("path", "")
        peer = (scope.get("client") or ("unknown", 0))[0] or "unknown"

        if self._api_token and path.startswith("/api/v1/") and path not in _AUTH_EXEMPT_PATHS:
            if not _authorized(scope, self._api_token):
                await _send_json(
                    send,
                    401,
                    {
                        "error": "unauthorized",
                        "message": "Valid API token required",
                        "code": "unauthorized",
                        "request_id": _header_value(scope, b"x-request-id") or "-",
                    },
                )
                return

        rate_limit = (
            method == "POST" and path.startswith("/api/v1/") and path != "/api/v1/events"
        ) or (method == "GET" and path in _EXPENSIVE_GET_PATHS)
        if rate_limit:
            client_host = _client_ip(scope, peer, self._trusted_proxies)
            bucket = f"{client_host}:{method}:{path}"
            if not await self._api_rate.acquire(bucket):
                await _send_json(
                    send,
                    429,
                    {
                        "error": "rate_limited",
                        "message": "Too many requests",
                        "code": "rate_limited",
                        "request_id": _header_value(scope, b"x-request-id") or "-",
                    },
                    extra_headers=[(b"retry-after", b"1")],
                )
                return

        request_id = _header_value(scope, b"x-request-id") or str(uuid.uuid4())
        scope.setdefault("state", {})
        scope["state"]["request_id"] = request_id
        token = request_id_var.set(request_id)
        started = time.monotonic()
        status_code = 500

        async def send_with_headers(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = request_id
                for name, value in _SECURITY_HEADERS.items():
                    headers[name] = value
                headers["Content-Security-Policy"] = _csp_for_path(path)
            await send(message)

        try:
            await self.app(scope, receive, send_with_headers)
        finally:
            duration_ms = round((time.monotonic() - started) * 1000, 1)
            if path != "/api/v1/events":
                logger.info(
                    "http_request",
                    extra={
                        "http_method": method,
                        "http_path": path,
                        "http_status": status_code,
                        "duration_ms": duration_ms,
                    },
                )
            request_id_var.reset(token)


def _csp_for_path(path: str) -> str:
    if path == "/api/docs" or path.startswith("/api/docs/"):
        return _SWAGGER_CSP
    return _DEFAULT_CSP


def _header_raw(scope: Scope, name: bytes) -> bytes | None:
    for key, value in scope.get("headers") or []:
        if key == name:
            return value
    return None


def _header_value(scope: Scope, name: bytes) -> str | None:
    raw = _header_raw(scope, name)
    return None if raw is None else raw.decode("latin-1")


def _client_ip(scope: Scope, peer: str, trusted_proxies: set[str]) -> str:
    if peer not in trusted_proxies:
        return peer
    forwarded = _header_value(scope, b"x-forwarded-for")
    if not forwarded:
        return peer
    # Left-most is the original client when proxies append.
    first = forwarded.split(",")[0].strip()
    return first or peer


def _query_token(query_string: bytes) -> bytes | None:
    """Read token= from a raw query string without ever decoding it to text.

    parse_qs decodes a bytes query string as ASCII on Python below 3.13 and
    raises UnicodeDecodeError on anything else, which would make a non-ASCII
    token a 500 rather than a 401. Percent-decoding stays in the bytes domain.
    """
    for field in query_string.split(b"&"):
        name, sep, value = field.partition(b"=")
        if sep and name == b"token":
            return unquote_to_bytes(value.replace(b"+", b" "))
    return None


def _authorized(scope: Scope, expected: bytes) -> bool:
    """Compare tokens as bytes so a non-ASCII credential cannot raise."""
    auth = _header_raw(scope, b"authorization")
    if auth and auth[:7].lower() == b"bearer ":
        if hmac.compare_digest(auth[7:].strip(), expected):
            return True
    header_token = _header_raw(scope, b"x-api-token")
    if header_token and hmac.compare_digest(header_token.strip(), expected):
        return True
    # EventSource cannot set Authorization — allow ?token= on SSE only.
    path = scope.get("path", "")
    if path == "/api/v1/events":
        candidate = _query_token(scope.get("query_string", b"") or b"")
        if candidate is not None and hmac.compare_digest(candidate, expected):
            return True
    return False


async def _send_json(
    send: Send,
    status: int,
    body: dict[str, str],
    extra_headers: list[tuple[bytes, bytes]] | None = None,
) -> None:
    import json

    payload = json.dumps(body).encode("utf-8")
    headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(payload)).encode("ascii")),
    ]
    if extra_headers:
        headers.extend(extra_headers)
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": headers,
        }
    )
    await send({"type": "http.response.body", "body": payload})
