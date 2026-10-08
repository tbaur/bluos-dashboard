"""Queue, capture inputs, Bluetooth, and presets."""

from __future__ import annotations

from urllib.parse import quote, urlparse

import httpx

from app.bluos.result import CallResult
from app.bluos.status import BluOSStatusMixin
from app.bluos.xml import safe_parse_xml, text
from app.models import AudioInput, BluetoothResponse, Preset, QueueItem, QueueResponse
from app.validators import sanitize_ip

_ART_SUFFIXES = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif")
_ART_HINTS = ("/artwork", "/images/", "/image/", "/var/data/")


def _is_artwork_path(path: str) -> bool:
    """Reject control verbs disguised as a cover URL. GET /Volume?level=0 is a command."""
    lowered = (path or "").lower()
    if any(hint in lowered for hint in _ART_HINTS):
        return True
    return lowered.endswith(_ART_SUFFIXES)


class BluOSMediaMixin(BluOSStatusMixin):
    _INPUT_HINTS = (
        ("hdmi arc", "arc"),
        ("earc", "earc"),
        ("optical", "spdif"),
        ("analog", "analog"),
        ("line in", "analog"),
        ("coax", "coax"),
        ("phono", "phono"),
        ("vinyl", "phono"),
        ("computer", "computer"),
        ("aes", "aesebu"),
        ("balanced", "balanced"),
        ("microphone", "microphone"),
        ("bluetooth", "bluetooth"),
    )
    _ICON_HINTS = (
        ("ic_optical", "spdif"),
        ("ic_analog", "analog"),
        ("ic_tv", "arc"),
        ("ic_hdmi", "arc"),
        ("ic_phono", "phono"),
        ("ic_coax", "coax"),
        ("ic_bluetooth", "bluetooth"),
    )
    _BT_MODE_MAP = {"0": "Manual", "1": "Automatic", "2": "Guest", "3": "Disabled"}

    @classmethod
    def _input_type_from_capture(cls, display_name: str, icon: str) -> str:
        """Map capture menu labels/icons to v1.7 inputTypeIndex type tokens."""
        name = (display_name or "").lower()
        for needle, type_name in cls._INPUT_HINTS:
            if needle in name:
                return type_name
        icon_l = (icon or "").lower()
        for needle, type_name in cls._ICON_HINTS:
            if needle in icon_l:
                return type_name
        return "analog"

    async def get_queue(self, ip: str) -> QueueResponse | None:
        """Play queue via BluOS v1.7 GET /Playlist."""
        raw = await self._get(ip, "/Playlist", query="start=0&end=500")
        if not raw:
            return None
        root = safe_parse_xml(raw, self.settings, ip)
        if root is None:
            return None
        items = [
            QueueItem(
                title=text(song, "title"),
                artist=text(song, "art") or text(song, "artist"),
                album=text(song, "alb") or text(song, "album"),
                image=text(song, "image"),
                service=text(song, "service"),
            )
            for song in root.findall("song")
        ]
        length_attr = root.attrib.get("length")
        length_el = root.findtext("length")
        try:
            count = int(
                length_attr
                if length_attr is not None
                else (length_el if length_el is not None else len(items))
            )
        except ValueError:
            count = len(items)
        return QueueResponse(items=items, count=count)

    async def clear_queue(self, ip: str) -> bool:
        """Clear play queue via BluOS v1.7 GET /Clear."""
        return self._ok(await self._control_get(ip, "/Clear"))

    async def move_queue_item(self, ip: str, from_index: int, to_index: int) -> bool:
        """Move queue track via BluOS v1.7 GET /Move?old=&new=."""
        return self._ok(
            await self._control_get(ip, "/Move", query=f"old={from_index}&new={to_index}")
        )

    async def get_inputs(self, ip: str) -> list[AudioInput] | None:
        """List capture inputs via BluOS v1.7 Settings?id=capture."""
        raw = await self._get(ip, "/Settings", query="id=capture&schemaVersion=32")
        if not raw:
            return None
        root = safe_parse_xml(raw, self.settings, ip)
        if root is None:
            return None

        active_type_index = ""
        active_input_id = ""
        active_name = ""
        status_raw = await self._get(ip, "/Status")
        if status_raw:
            status = self._parse_status(status_raw, ip)
            if status.get("service_id") == "Capture":
                active_type_index = str(status.get("input_type_index") or "")
                active_input_id = str(status.get("input_id") or "")
                active_name = str(status.get("track") or "")

        inputs: list[AudioInput] = []
        type_counts: dict[str, int] = {}
        for group in root.iter("menuGroup"):
            group_id = group.get("id", "")
            if not group_id.startswith("capture-") or group_id == "capture":
                continue
            if "bluetooth" in group_id.lower():
                continue
            name = group.get("displayName", "") or group_id
            icon = group.get("icon", "")
            type_name = self._input_type_from_capture(name, icon)
            type_counts[type_name] = type_counts.get(type_name, 0) + 1
            type_index = f"{type_name}-{type_counts[type_name]}"
            capture_key = group_id.removeprefix("capture-")
            selected = bool(
                (active_type_index and type_index == active_type_index)
                or (active_input_id and capture_key == active_input_id)
                or (active_name and name.lower() == active_name.lower())
            )
            inputs.append(
                AudioInput(
                    name=name,
                    type=type_name,
                    id=type_index,
                    selected=selected,
                )
            )
        return inputs

    async def set_input(self, ip: str, input_name: str) -> bool:
        """Select input by display name or inputTypeIndex (fw >= 4.2)."""
        target = (input_name or "").strip()
        if not target:
            return False
        type_index = target
        if "-" not in target or not any(ch.isdigit() for ch in target.split("-")[-1]):
            inputs = await self.get_inputs(ip) or []
            lowered = target.lower()
            match = next(
                (
                    inp
                    for inp in inputs
                    if inp.id.lower() == lowered
                    or inp.name.lower() == lowered
                    or inp.type.lower() == lowered
                ),
                None,
            )
            if match is None:
                return False
            type_index = match.id
        encoded = quote(type_index, safe="-")
        return self._ok(
            await self._control_get(ip, "/Play", query=f"inputTypeIndex={encoded}")
        )

    async def get_bluetooth_info(self, ip: str) -> BluetoothResponse | None:
        """Probe Bluetooth from capture settings (no /AudioModes GET in v1.7).

        Returns ``None`` on hard failure (unreachable / unparseable). When capture
        settings load but omit ``bluetoothAutoplay``, returns ``supported=False``
        (e.g. NAD CI S2 and other players without a Bluetooth radio).
        """
        raw = await self._get(ip, "/Settings", query="id=capture&schemaVersion=32")
        if not raw:
            return None
        root = safe_parse_xml(raw, self.settings, ip)
        if root is None:
            return None
        for setting in root.iter("setting"):
            setting_id = setting.get("id") or setting.get("name")
            if setting_id == "bluetoothAutoplay":
                mode = setting.get("value", "")
                return BluetoothResponse(
                    supported=True,
                    mode=self._BT_MODE_MAP.get(mode, "Unknown"),
                )
        return BluetoothResponse(supported=False, mode=None)

    async def get_bluetooth_mode(self, ip: str) -> str | None:
        """Read Bluetooth mode label, or ``None`` when unsupported / unreachable."""
        info = await self.get_bluetooth_info(ip)
        if info is None or not info.supported:
            return None
        return info.mode

    async def set_bluetooth_mode(self, ip: str, mode: int) -> bool:
        if mode not in (0, 1, 2, 3):
            return self._ok(CallResult.failure("rejected", "invalid bluetooth mode"))
        return self._ok(
            await self._control_get(ip, "/audiomodes", query=f"bluetoothAutoplay={mode}")
        )

    async def get_presets(self, ip: str) -> list[Preset] | None:
        # Read path: do not burn the control rate slot / single-attempt budget.
        raw = await self._get(ip, "/Presets", control=False)
        if not raw:
            return None
        root = safe_parse_xml(raw, self.settings, ip)
        if root is None:
            return None
        return [
            Preset(
                id=preset.get("id", ""),
                name=text(preset, "name"),
                image=text(preset, "image"),
            )
            for preset in root.findall("preset")
        ]

    async def play_preset(self, ip: str, preset_id: int) -> bool:
        if preset_id < 1:
            return self._ok(CallResult.failure("rejected", "invalid preset"))
        return self._ok(await self._control_get(ip, "/Preset", query=f"id={preset_id}"))

    async def fetch_artwork(self, endpoint: str, image_url: str) -> tuple[bytes, str] | None:
        """Fetch cover art from the player that owns it.

        The browser never opens the player URL. An image host that is not that
        player is refused, so a player-supplied URL cannot steer the page.
        """
        resolved = self._resolve_target(endpoint)
        if not resolved:
            return None
        ip, port = resolved
        if not self.settings.is_allowed_device_ip(ip):
            return None
        raw = (image_url or "").strip()
        if not raw or raw.startswith("data:"):
            return None
        if raw.startswith("/"):
            path = urlparse(raw).path
            url = f"http://{ip}:{port}{raw}"
        else:
            parsed = urlparse(raw)
            host = sanitize_ip(parsed.hostname or "")
            image_port = parsed.port or (443 if parsed.scheme == "https" else 80)
            if parsed.scheme not in {"http", "https"} or host != ip or image_port != port:
                return None
            path = parsed.path
            url = raw
        if not _is_artwork_path(path):
            return None
        try:
            async with self._sem:
                response = await self._follow_get(
                    ip,
                    url,
                    timeout=self.settings.device_http_timeout,
                )
        except (httpx.TimeoutException, httpx.TransportError, OSError):
            return None
        if response is None or response.status_code >= 400:
            return None
        body = response.content
        if not body or len(body) > self.settings.max_xml_size:
            return None
        media = response.headers.get("content-type", "image/jpeg").split(";", 1)[0].strip().lower()
        if not media.startswith("image/"):
            return None
        return body, media

