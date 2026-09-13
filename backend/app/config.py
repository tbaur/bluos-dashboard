"""Typed configuration with fail-fast validation."""

from __future__ import annotations

from functools import lru_cache
from ipaddress import IPv4Address, ip_address
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DiscoveryMethod = Literal["mdns", "lsdp", "both"]

# Repo root `.env` (docs) plus cwd `.env` when running from backend/
_REPO_ROOT = Path(__file__).resolve().parents[2]
_ENV_FILES = (
    str(_REPO_ROOT / ".env"),
    ".env",
)


class Settings(BaseSettings):
    """Environment-backed settings. Prefix: BSD_."""

    model_config = SettingsConfigDict(
        env_prefix="BSD_",
        env_file=_ENV_FILES,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    log_level: str = "INFO"
    cors_origins: str = "http://127.0.0.1:8765,http://localhost:8765"
    # When non-empty, require Bearer / X-API-Token (or ?token= for EventSource).
    api_token: str = ""
    # Comma-separated client IPs allowed to supply X-Forwarded-For for API rate limits.
    trusted_proxies: str = ""

    discovery_method: DiscoveryMethod = "both"
    discovery_timeout: float = Field(default=5.0, ge=1.0, le=60.0)
    discovery_cache_ttl: float = Field(default=300.0, ge=0.0, le=3600.0)
    empty_fleet_rediscovery_seconds: float = Field(default=30.0, ge=5.0, le=600.0)
    allow_non_private_ips: bool = False

    poll_interval: float = Field(default=3.0, ge=1.0, le=60.0)
    device_http_timeout: float = Field(default=3.0, ge=0.5, le=30.0)
    # Custom Integration API v1.7: Status long-poll timeout (recommended 100s).
    status_long_poll_seconds: float = Field(default=100.0, ge=10.0, le=180.0)
    # Extra read time so httpx does not cut off the player at exactly timeout=.
    long_poll_read_slack_seconds: float = Field(default=5.0, ge=1.0, le=30.0)
    # v1.7: consecutive Status/SyncStatus GETs for the same resource ≥ 1s apart.
    long_poll_gap_seconds: float = Field(default=1.0, ge=0.0, le=10.0)
    max_concurrent_device_calls: int = Field(default=20, ge=1, le=50)
    control_rate_limit_seconds: float = Field(default=0.1, ge=0.0, le=5.0)
    # Bound wait after cancelling a Status long-poll so control can use the player.
    control_interrupt_wait_seconds: float = Field(default=0.25, ge=0.0, le=2.0)
    api_rate_limit_seconds: float = Field(default=0.05, ge=0.0, le=5.0)

    enable_openapi: bool | None = None

    circuit_failure_threshold: int = Field(default=5, ge=1, le=100)
    circuit_slow_poll_seconds: float = Field(default=15.0, ge=3.0, le=300.0)
    discovered_grace_ttl: float = Field(default=60.0, ge=0.0, le=600.0)
    sse_keepalive_seconds: float = Field(default=15.0, ge=0.1, le=120.0)
    sse_queue_size: int = Field(default=32, ge=1, le=1000)
    fleet_upgrades_cache_seconds: float = Field(default=30.0, ge=0.0, le=600.0)

    max_xml_size: int = Field(default=1_048_576, ge=1024, le=10_485_760)
    max_xml_depth: int = Field(default=20, ge=2, le=100)
    max_xml_elements: int = Field(default=10_000, ge=100, le=100_000)

    bluos_port: int = Field(default=11000, ge=1, le=65535)
    web_ui_port: int = Field(default=80, ge=1, le=65535)
    static_dir: str = ""

    @field_validator("host")
    @classmethod
    def validate_host(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("host must not be empty")
        if value in {"0.0.0.0", "::", "localhost"}:
            return value
        try:
            ip_address(value)
        except ValueError as exc:
            raise ValueError(f"invalid bind host: {value}") from exc
        return value

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, value: str) -> str:
        level = value.upper().strip()
        allowed = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        if level not in allowed:
            raise ValueError(f"log_level must be one of {sorted(allowed)}")
        return level

    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def trusted_proxy_set(self) -> set[str]:
        return {o.strip() for o in self.trusted_proxies.split(",") if o.strip()}

    def openapi_enabled(self) -> bool:
        if self.enable_openapi is not None:
            return self.enable_openapi
        return self.host in {"127.0.0.1", "localhost", "::1"}

    def is_allowed_device_ip(self, ip: str) -> bool:
        try:
            addr = ip_address(ip)
        except ValueError:
            return False
        if not isinstance(addr, IPv4Address):
            return False
        if self.allow_non_private_ips:
            return not (addr.is_loopback or addr.is_multicast or addr.is_unspecified)
        return addr.is_private and not addr.is_loopback


@lru_cache
def get_settings() -> Settings:
    return Settings()
