"""Device web UI: reboot, diagnostics, firmware, settings."""

from __future__ import annotations

import asyncio
import logging
import re
import time
import xml.etree.ElementTree as ET
from urllib.parse import quote

import httpx

from app.bluos.result import CallResult, classify_control_body
from app.bluos.transport import BluOSTransport
from app.bluos.xml import safe_parse_xml
from app.models import (
    DeviceSetting,
    DeviceSettingsResponse,
    SettingDependency,
    SettingOption,
    UpgradeStatus,
)
from app.validators import format_endpoint, sanitize_ip

logger = logging.getLogger(__name__)

_XML_TRUE = frozenset({"true", "1", "yes"})
# /diagnostics can stall while the player enumerates peers; control GETs stay at 3s.
_WEB_UI_GET_TIMEOUT = 10.0
_WEB_UI_GET_ATTEMPTS = 2
_UPTIME_PATTERNS = (
    re.compile(
        r"Uptime:\s*</div>\s*<div[^>]*>\s*([^<]+?)\s*</div>",
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(r"Uptime:\s*</[^>]+>\s*([^<\s]+)", re.IGNORECASE),
)


def _xml_flag(node: ET.Element, attr: str) -> bool:
    return (node.get(attr) or "").lower() in _XML_TRUE


def _optional_float(raw: str | None) -> float | None:
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _parse_setting_values(
    node: ET.Element,
) -> tuple[list[SettingOption], float | None, float | None, float | None, float | None, str]:
    options: list[SettingOption] = []
    min_value: float | None = None
    max_value: float | None = None
    min_range: float | None = None
    step: float | None = None
    units = ""
    for value_node in node.findall("value"):
        option_name = (value_node.get("name") or "").strip()
        if option_name:
            options.append(
                SettingOption(
                    name=option_name,
                    display_name=value_node.get("displayName") or option_name,
                )
            )
            continue
        if value_node.get("min") is None:
            continue
        min_value = _optional_float(value_node.get("min"))
        max_value = _optional_float(value_node.get("max"))
        step = _optional_float(value_node.get("step"))
        min_range = _optional_float(value_node.get("minRange"))
        units = value_node.get("units") or ""
    return options, min_value, max_value, min_range, step, units


def _parse_setting_dependencies(node: ET.Element) -> list[SettingDependency]:
    deps: list[SettingDependency] = []
    for dep in node.findall("dependsOn"):
        name = (dep.get("name") or "").strip()
        if name:
            deps.append(SettingDependency(name=name, value=dep.get("value") or ""))
    return deps


def _parse_setting_node(node: ET.Element) -> DeviceSetting | None:
    setting_id = (node.get("id") or node.get("name") or "").strip()
    if not setting_id or node.find("webview") is not None:
        return None
    options, min_value, max_value, min_range, step, units = _parse_setting_values(node)
    dependencies = _parse_setting_dependencies(node)
    first = dependencies[0] if dependencies else None
    return DeviceSetting(
        id=setting_id,
        name=node.get("name") or setting_id,
        display_name=node.get("displayName") or setting_id,
        kind=(node.get("class") or "").strip(),
        value=node.get("value") or "",
        description=node.get("description") or "",
        explanation=node.get("explanation") or "",
        disabled=_xml_flag(node, "disable"),
        hide_if_disabled=_xml_flag(node, "hideIfDisabled"),
        control_path=node.get("url") or "",
        min_value=min_value,
        max_value=max_value,
        min_range=min_range,
        step=step,
        units=units,
        pattern=node.get("pattern") or "",
        pattern_error=node.get("patternError") or "",
        refresh_after_write=_xml_flag(node, "refresh"),
        options=options,
        dependencies=dependencies,
        depends_on=first.name if first else "",
        depends_value=first.value if first else "",
    )


class BluOSWebUIMixin(BluOSTransport):
    async def reboot(self, ip: str) -> bool:
        """Restart the player via the device web UI (:80).

        Custom Integration API v1.7 documents one reboot: POST /reboot with
        yes=1. There is no separate soft path — POST /Reboot soft=1 404s on
        current firmware, and :11000 has no reboot handler.
        """
        return await self._post_web_ui(ip, "/reboot", {"yes": "1"})

    def _web_ui_url(self, ip: str, path: str) -> str:
        port = self.settings.web_ui_port
        if port == 80:
            return f"http://{ip}{path}"
        return f"http://{ip}:{port}{path}"

    async def _get_web_ui(self, ip: str, path: str) -> str | None:
        """GET the device web UI (port 80 by default), not BluOS :11000."""
        resolved = self._resolve_target(ip)
        sanitized = resolved[0] if resolved else sanitize_ip(ip)
        if not sanitized:
            return None
        if not self.settings.is_allowed_device_ip(sanitized):
            logger.warning("blocked_non_private_ip", extra={"device_ip": sanitized})
            return None
        url = self._web_ui_url(sanitized, path)
        timeout = max(self.settings.device_http_timeout, _WEB_UI_GET_TIMEOUT)
        last_error: Exception | None = None
        for attempt in range(_WEB_UI_GET_ATTEMPTS):
            try:
                async with self._sem:
                    response = await self._follow_get(sanitized, url, timeout=timeout)
                if response is None or response.status_code >= 400:
                    return None
                text_body = response.text
                if len(text_body.encode("utf-8", errors="ignore")) > self.settings.max_xml_size:
                    logger.warning("payload_too_large ip=%s path=%s", sanitized, path)
                    return None
                return text_body
            except httpx.TimeoutException as exc:
                last_error = exc
                break
            except (httpx.TransportError, OSError) as exc:
                last_error = exc
                if attempt + 1 >= _WEB_UI_GET_ATTEMPTS:
                    break
                await asyncio.sleep(0.2)
        logger.debug("web_ui_get_failed ip=%s path=%s err=%s", sanitized, path, last_error)
        return None

    async def _post_web_ui(self, ip: str, path: str, data: dict[str, str]) -> bool:
        """POST form data to the device web UI (reverse-engineered settings writes)."""
        resolved = self._resolve_target(ip)
        sanitized = resolved[0] if resolved else sanitize_ip(ip)
        if not sanitized:
            return False
        if not self.settings.is_allowed_device_ip(sanitized):
            logger.warning("blocked_non_private_ip", extra={"device_ip": sanitized})
            return False
        # Same keying as BluOS control: ip:port (web UI uses BSD_WEB_UI_PORT).
        await self._rate.wait(format_endpoint(sanitized, self.settings.web_ui_port))
        url = self._web_ui_url(sanitized, path)
        try:
            async with self._sem:
                response = await self._follow_post(sanitized, url, data)
            if response is None:
                return self._ok(CallResult.failure("rejected", "redirect blocked"))
            if response.status_code >= 400:
                return self._ok(CallResult.failure("http_status", str(response.status_code)))
            return self._ok(
                classify_control_body(
                    response.content,
                    self.settings,
                    sanitized,
                    allow_plain=True,
                    empty_ok=True,
                )
            )
        except httpx.TimeoutException as exc:
            logger.debug("web_ui_post_failed ip=%s path=%s err=%s", sanitized, path, exc)
            return self._ok(CallResult.failure("timeout", type(exc).__name__))
        except (httpx.TransportError, OSError) as exc:
            logger.debug("web_ui_post_failed ip=%s path=%s err=%s", sanitized, path, exc)
            return self._ok(CallResult.failure("transport", type(exc).__name__))

    @staticmethod
    def _parse_diagnostics_html(html: str) -> dict[str, str]:
        pairs = re.findall(
            r'<div class="ui-block-a">\s*([^<:]+?)\s*:?\s*</div>\s*'
            r'<div class="ui-block-b">\s*(.*?)\s*</div>',
            html,
            re.IGNORECASE | re.DOTALL,
        )
        label_map = {
            "connected to network": "network_name",
            "signal strength": "signal_strength",
            "ip address": "web_ip",
            "mac address": "web_mac",
            "bluos version": "web_fw",
            "uptime": "uptime",
            "total songs": "total_songs",
        }
        out: dict[str, str] = {}
        for label, value in pairs:
            key = label_map.get(re.sub(r"\s+", " ", label.strip().lower()))
            if not key:
                continue
            cleaned = re.sub(r"<[^>]+>", "", value).strip()
            if cleaned:
                out[key] = cleaned
        if "uptime" not in out:
            extracted = BluOSWebUIMixin._extract_uptime(html)
            if extracted:
                out["uptime"] = extracted
        return out

    @staticmethod
    def _extract_uptime(html: str) -> str:
        for pattern in _UPTIME_PATTERNS:
            match = pattern.search(html)
            if not match:
                continue
            cleaned = re.sub(r"<[^>]+>", "", match.group(1)).strip()
            if cleaned:
                return cleaned
        return ""

    async def get_diagnostics(self, ip: str) -> dict[str, str] | None:
        html = await self._get_web_ui(ip, "/diagnostics")
        if html is None:
            return None
        parsed = self._parse_diagnostics_html(html)
        if not parsed.get("uptime"):
            logger.warning("diagnostics_uptime_missing endpoint=%s html_len=%s", ip, len(html))
        return parsed or {}

    async def get_uptime(self, ip: str) -> str | None:
        """Read uptime from the device web UI diagnostics page."""
        parsed = await self.get_diagnostics(ip)
        if parsed is None:
            return None
        return parsed.get("uptime")

    @staticmethod
    def _parse_upgrade_html(html: str) -> tuple[bool, str]:
        content_match = re.search(
            r'data-role="content"[^>]*>(.*?)</div>',
            html,
            re.IGNORECASE | re.DOTALL,
        )
        chunk = content_match.group(1) if content_match else html
        text_body = re.sub(r"<[^>]+>", " ", chunk)
        text_body = re.sub(r"\s+", " ", text_body).strip()
        lowered = text_body.lower()
        if "no update available" in lowered:
            return False, text_body or "No update available."
        if "update available" in lowered or "i want it now" in lowered:
            return True, text_body or "Update available."
        if text_body:
            return False, text_body
        return False, "Upgrade status unknown."

    async def get_upgrade_status(
        self, ip: str, *, device_id: str = "", name: str = "", current_fw: str = ""
    ) -> UpgradeStatus:
        resolved = self._resolve_target(ip)
        host = resolved[0] if resolved else (sanitize_ip(ip) or ip)
        port = resolved[1] if resolved else self.settings.bluos_port
        html = await self._get_web_ui(ip, "/upgrade")
        if html is None:
            return UpgradeStatus(
                device_id=device_id,
                name=name,
                ip=host,
                port=port,
                current_fw=current_fw,
                update_available=False,
                message="Upgrade check failed",
                ok=False,
            )
        available, message = self._parse_upgrade_html(html)
        return UpgradeStatus(
            device_id=device_id,
            name=name,
            ip=host,
            port=port,
            current_fw=current_fw,
            update_available=available,
            message=message,
            ok=True,
        )

    def _parse_settings_page(
        self, raw: bytes, ip: str, page_id: str
    ) -> DeviceSettingsResponse | None:
        root = safe_parse_xml(raw, self.settings, ip)
        if root is None:
            return None
        settings: list[DeviceSetting] = []
        for node in root.iter("setting"):
            parsed = _parse_setting_node(node)
            if parsed is not None:
                settings.append(parsed)
        return DeviceSettingsResponse(page_id=page_id, settings=settings)

    async def get_device_settings(self, ip: str, page_id: str) -> DeviceSettingsResponse | None:
        """Read BluOS settings page (audio / player) via :11000/Settings."""
        page = (page_id or "").strip().lower()
        if page not in {"audio", "player"}:
            return None
        resolved = self._resolve_target(ip)
        cache_key = (
            format_endpoint(resolved[0], resolved[1]) if resolved else ip,
            page,
        )
        cached = self._settings_page_cache.get(cache_key)
        if cached is not None:
            cached_at, payload = cached
            if time.monotonic() - cached_at < self._settings_page_cache_ttl:
                return payload if isinstance(payload, DeviceSettingsResponse) else None
        raw = await self._get(ip, "/Settings", query=f"id={page}")
        if not raw:
            return None
        parsed = self._parse_settings_page(raw, ip, page)
        if parsed is not None:
            self._settings_page_cache[cache_key] = (time.monotonic(), parsed)
        return parsed

    def _invalidate_settings_cache(self, ip: str) -> None:
        resolved = self._resolve_target(ip)
        endpoint = format_endpoint(resolved[0], resolved[1]) if resolved else ip
        for page in ("audio", "player"):
            self._settings_page_cache.pop((endpoint, page), None)

    async def set_device_setting(
        self, ip: str, setting_id: str, value: str, *, control_path: str = ""
    ) -> bool:
        """Write a setting via its BluOS control path when known, else web UI POST."""
        sid = (setting_id or "").strip()
        if not sid:
            return False
        path = (control_path or "").strip()
        if not path:
            path = await self._resolve_setting_control_path(ip, sid)
        ok = False
        if path.startswith("/") and "://" not in path:
            path_only = path.split("?", 1)[0]
            if path_only.lower() == "/name":
                result = await self._control_get(ip, "/Name", query=f"name={quote(value)}")
            else:
                result = await self._control_get(
                    ip,
                    path_only,
                    query=f"{quote(sid, safe='-_.')}={quote(value, safe=',.-')}",
                )
            # A BluOS <error> is the player's answer. Do not also POST the web UI.
            if result.kind == "bluos_error":
                return self._ok(result)
            ok = self._ok(result)
        if not ok:
            ok = await self._post_web_ui(
                ip,
                "/settings",
                {"playnum": "1", "id": sid, "value": value},
            )
        if ok:
            self._invalidate_settings_cache(ip)
        return ok

    async def _resolve_setting_control_path(self, ip: str, setting_id: str) -> str:
        for page in ("audio", "player"):
            page_data = await self.get_device_settings(ip, page)
            if page_data is None:
                continue
            for setting in page_data.settings:
                if setting.id == setting_id:
                    return setting.control_path or ""
        return ""

