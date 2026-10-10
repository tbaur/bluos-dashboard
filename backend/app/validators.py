"""Shared validation helpers for BluOS targeting."""

from __future__ import annotations

import hashlib
import ipaddress
import re

_DEVICE_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")

DEFAULT_BLUOS_PORT = 11000


def sanitize_ip(ip: str) -> str | None:
    if not ip or not isinstance(ip, str):
        return None
    if any(ch in ip for ch in ("\x00", "\n", "\r", "/", "\\")):
        return None
    candidate = ip.strip()
    if len(candidate) > 15 or not candidate:
        return None
    try:
        addr = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    if not isinstance(addr, ipaddress.IPv4Address):
        return None
    return str(addr)


def validate_bluos_port(port: int) -> bool:
    """Return True if port is a plausible BluOS API port."""
    return isinstance(port, int) and 1024 <= port <= 65535


def parse_endpoint(
    value: str, default_port: int | None = None
) -> tuple[str | None, int]:
    """
    Parse ``ip`` or ``ip:port`` into ``(ip, port)``.

    Returns ``(None, default_port)`` when the IP is invalid.
    """
    if default_port is None:
        default_port = DEFAULT_BLUOS_PORT

    if not value or not isinstance(value, str):
        return None, default_port

    value = value.strip()
    if not value:
        return None, default_port

    if value.count(":") == 1:
        host, port_str = value.rsplit(":", 1)
        try:
            port = int(port_str)
        except ValueError:
            return None, default_port
        sanitized = sanitize_ip(host)
        if not sanitized or not validate_bluos_port(port):
            return None, default_port
        return sanitized, port

    sanitized = sanitize_ip(value)
    if not sanitized:
        return None, default_port
    return sanitized, default_port


def format_endpoint(ip: str, port: int | None = None) -> str:
    """Return canonical ``ip:port`` endpoint string."""
    if port is None:
        port = DEFAULT_BLUOS_PORT
    return f"{ip}:{port}"


def sanitize_endpoint(value: str, default_port: int | None = None) -> str | None:
    """Sanitize an endpoint to canonical ``ip:port`` form."""
    ip, port = parse_endpoint(value, default_port=default_port)
    if not ip:
        return None
    return format_endpoint(ip, port)


def parse_bluos_endpoint(value: str | None, default_port: int | None = None) -> str:
    """Normalize a BluOS id to canonical ``ip:port`` (default port 11000)."""
    if not value:
        return ""
    return sanitize_endpoint(value.strip(), default_port=default_port) or ""


def validate_device_id(device_id: str) -> bool:
    return bool(device_id and _DEVICE_ID_RE.fullmatch(device_id))


def make_device_id(
    ip: str,
    name: str = "",
    node_id: str = "",
    port: int | None = None,
) -> str:
    if node_id:
        cleaned = re.sub(r"[^a-zA-Z0-9._-]", "-", node_id.strip())[:64].strip("-")
        # Every zone of a multi-zone chassis announces the same node ID.
        if cleaned and port is not None and port != DEFAULT_BLUOS_PORT:
            cleaned = f"{cleaned}-{port}"
        if cleaned and validate_device_id(cleaned):
            return cleaned
    endpoint = format_endpoint(ip.strip(), port if port is not None else DEFAULT_BLUOS_PORT)
    seed = f"{name.strip().lower()}|{endpoint}"
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:12]
    return f"player-{digest}"


def parse_bluos_host(value: str) -> str:
    """Extract host/IP from a BluOS value (strips port)."""
    if not value:
        return ""
    ip, _port = parse_endpoint(value.strip())
    return ip or ""


_MAC_OCTET_RE = re.compile(r"^[0-9A-Fa-f]{2}$")


def normalize_bluos_mac(value: str | None) -> str:
    """Return a chassis MAC, stripping BluOS CI secondary-zone ``:port`` suffixes.

    Secondary zones often report ``mac="aa:bb:cc:dd:ee:ff:11010"`` so each zone has a
    distinct SyncStatus id while sharing one NIC. UI and diagnostics want the real MAC.
    """
    if not value or not isinstance(value, str):
        return ""
    cleaned = value.strip()
    if not cleaned:
        return ""
    parts = cleaned.split(":")
    octets_ok = all(_MAC_OCTET_RE.fullmatch(p) for p in parts[:6])
    if len(parts) >= 7 and parts[6].isdigit() and octets_ok:
        return ":".join(parts[:6]).upper()
    if len(parts) == 6 and all(_MAC_OCTET_RE.fullmatch(p) for p in parts):
        return cleaned.upper()
    return cleaned
