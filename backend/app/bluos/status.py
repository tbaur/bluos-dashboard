"""SyncStatus / Status parsing and player snapshot."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

from app.bluos.transport import BluOSTransport
from app.bluos.xml import attr, safe_parse_xml, text
from app.capabilities import infer_zone
from app.models import PlayerStatus, SyncRole
from app.validators import (
    format_endpoint,
    make_device_id,
    normalize_bluos_mac,
    parse_bluos_endpoint,
)


@dataclass(frozen=True)
class PlayerSnapshot:
    """Player view plus opaque BluOS etags used for Status long-poll."""

    player: PlayerStatus
    status_etag: str = ""
    sync_stat: str = ""
    # True when this snapshot read /SyncStatus rather than reusing the last one.
    sync_read: bool = False


class BluOSStatusMixin(BluOSTransport):
    def parse_sync_role(self, master: str, slaves: list[str], endpoint: str) -> SyncRole:
        if slaves:
            return SyncRole.PRIMARY
        if master and master != endpoint:
            return SyncRole.SYNCED
        return SyncRole.STANDALONE

    def _parse_sync(self, sync_xml: bytes, endpoint: str) -> dict[str, Any]:
        root = safe_parse_xml(sync_xml, self.settings, endpoint)
        if root is None:
            return {}
        default_port = self.settings.bluos_port
        master_attr = attr(root, "master")
        master_elem = root.find("master")
        if master_elem is not None:
            raw_master = (master_elem.text or "").strip()
            port_attr = master_elem.attrib.get("port")
            if raw_master and port_attr and ":" not in raw_master:
                raw_master = f"{raw_master}:{port_attr.strip()}"
            master = parse_bluos_endpoint(raw_master, default_port=default_port)
        else:
            master = parse_bluos_endpoint(master_attr, default_port=default_port)
        group = attr(root, "group") or text(root, "group")
        slaves: list[str] = []
        for slave_elem in root.findall("slave"):
            raw_id = slave_elem.attrib.get("id") or slave_elem.text or ""
            port_attr = slave_elem.attrib.get("port")
            if raw_id and port_attr and ":" not in raw_id.strip():
                raw_id = f"{raw_id.strip()}:{port_attr.strip()}"
            slave_ep = parse_bluos_endpoint(raw_id, default_port=default_port)
            if slave_ep and slave_ep not in slaves:
                slaves.append(slave_ep)
        battery_elem = root.find("battery")
        battery = battery_elem.attrib.get("level") if battery_elem is not None else None
        # Per-player volume lives on SyncStatus. For synced secondaries, /Status
        # volume is the group/primary level and must not be trusted.
        volume: int | None = None
        volume_raw = attr(root, "volume")
        if volume_raw not in ("", None):
            try:
                volume = max(0, min(100, int(volume_raw)))
            except ValueError:
                volume = None
        mute_raw = attr(root, "mute")
        muted: bool | None = None
        if mute_raw not in ("", None):
            muted = mute_raw in {"1", "true", "True"}
        return {
            "name": attr(root, "name") or "Unknown",
            "model": attr(root, "modelName") or attr(root, "brand") or "",
            "model_code": attr(root, "model"),
            "brand": attr(root, "brand"),
            "device_class": attr(root, "class"),
            "mac": normalize_bluos_mac(attr(root, "mac")),
            "db": attr(root, "db"),
            "fw": attr(root, "version"),
            "master": master,
            "group": group,
            "slaves": slaves,
            "battery": battery,
            "volume": volume,
            "muted": muted,
            "etag": attr(root, "etag"),
            "sync_stat": attr(root, "syncStat") or text(root, "syncStat"),
        }

    def _absolute_media_url(self, ip: str, path: str, *, port: int | None = None) -> str:
        value = (path or "").strip()
        if not value:
            return ""
        if value.startswith(("http://", "https://")):
            return value
        if value.startswith("/"):
            api_port = self.settings.bluos_port if port is None else port
            return f"http://{ip}:{api_port}{value}"
        return value

    @staticmethod
    def _parse_int(raw: str, default: int = 0) -> int:
        try:
            return int(float(raw))
        except (TypeError, ValueError):
            return default

    def _parse_status(
        self,
        status_xml: bytes,
        ip: str,
        *,
        port: int | None = None,
    ) -> dict[str, Any]:
        root = safe_parse_xml(status_xml, self.settings, ip)
        if root is None:
            return {}
        api_port = self.settings.bluos_port if port is None else port
        service = text(root, "service")
        service_name = text(root, "serviceName")
        if service == "Raat":
            service = "Roon"
        # Prefer BluOS display name (e.g. TidalConnect → "TIDAL connect").
        display_service = service_name or service
        volume_raw = text(root, "volume", "0")
        try:
            volume = int(volume_raw)
        except ValueError:
            volume = 0
        mute_raw = text(root, "mute", "0")
        image = text(root, "image") or text(root, "currentImage")
        group_volume_raw = text(root, "groupVolume")
        group_volume: int | None = None
        if group_volume_raw:
            try:
                group_volume = max(0, min(100, int(group_volume_raw)))
            except ValueError:
                group_volume = None
        return {
            "volume": max(0, min(100, volume)),
            "muted": mute_raw in {"1", "true", "True"},
            "state": text(root, "state", "stop") or "stop",
            "service": display_service,
            "service_id": service,
            "track": text(root, "title1") or text(root, "title"),
            "artist": text(root, "artist") or text(root, "title2"),
            "album": text(root, "album") or text(root, "title3"),
            "quality": text(root, "quality"),
            "stream_format": text(root, "streamFormat"),
            "image": self._absolute_media_url(ip, image, port=api_port),
            "secs": self._parse_int(text(root, "secs")),
            "totlen": self._parse_int(text(root, "totlen")),
            "can_seek": text(root, "canSeek") in {"1", "true", "True"},
            "shuffle": max(0, min(1, self._parse_int(text(root, "shuffle"), 0))),
            "repeat": max(0, min(2, self._parse_int(text(root, "repeat"), 0))),
            "input_type_index": text(root, "inputTypeIndex"),
            "input_id": text(root, "inputId"),
            "group_name": text(root, "groupName"),
            "group_volume": group_volume,
            "db": text(root, "db"),
            "etag": attr(root, "etag"),
            "sync_stat": text(root, "syncStat") or attr(root, "syncStat"),
        }

    def _apply_sync_fields(
        self,
        player: PlayerStatus,
        sync: dict[str, Any],
        *,
        endpoint: str,
        sanitized: str,
        node_id: str,
        port: int,
        device_id: str | None,
    ) -> None:
        player.name = sync["name"]
        player.model = sync["model"]
        player.brand = sync["brand"]
        player.device_class = sync.get("device_class", "")
        player.mac = sync.get("mac", "")
        player.db = sync["db"]
        player.fw = sync["fw"]
        player.master = sync["master"]
        player.group = sync["group"]
        player.slaves = sync["slaves"]
        player.battery = sync["battery"]
        player.sync_role = self.parse_sync_role(player.master, player.slaves, endpoint)
        if sync.get("volume") is not None:
            player.volume = sync["volume"]
        if sync.get("muted") is not None:
            player.muted = sync["muted"]
        if not device_id:
            player.id = make_device_id(sanitized, player.name, node_id, port=port)

    def _apply_status_fields(
        self,
        player: PlayerStatus,
        status: dict[str, Any],
        *,
        overlay_volume: bool,
    ) -> None:
        if overlay_volume:
            player.volume = status.get("volume", player.volume)
            player.muted = status.get("muted", player.muted)
        player.state = status.get("state", "stop")
        player.service = status.get("service", "")
        player.service_id = status.get("service_id", "")
        player.track = status.get("track", "")
        player.artist = status.get("artist", "")
        player.album = status.get("album", "")
        player.quality = status.get("quality", "")
        player.stream_format = status.get("stream_format", "")
        player.image = status.get("image", "")
        player.secs = status.get("secs", 0)
        player.totlen = status.get("totlen", 0)
        player.can_seek = status.get("can_seek", False)
        player.shuffle = status.get("shuffle", 0)
        player.repeat = status.get("repeat", 0)
        player.input_type_index = status.get("input_type_index", "")
        if status.get("group_name") and not player.group:
            player.group = status["group_name"]
        if status.get("group_volume") is not None:
            player.group_volume = status["group_volume"]
        if status.get("db"):
            player.db = status["db"]

    def _finalize_player(self, player: PlayerStatus) -> None:
        if player.brand and player.brand not in player.model:
            player.full_model = f"{player.brand} {player.model}".strip()
        else:
            player.full_model = player.model
        player.zone = infer_zone(
            player.port,
            model=player.model,
            brand=player.brand,
            full_model=player.full_model,
        )
        player.status = "online"
        player.last_seen = time.time()

    def _shell_player(
        self,
        sanitized: str,
        port: int,
        device_id: str | None,
        node_id: str,
    ) -> PlayerStatus:
        return PlayerStatus(
            id=device_id or make_device_id(sanitized, node_id=node_id, port=port),
            ip=sanitized,
            port=port,
        )

    @staticmethod
    def _tags_from_parsed(status: dict[str, Any], sync: dict[str, Any]) -> tuple[str, str]:
        etag = str(status.get("etag") or "")
        sync_stat = str(status.get("sync_stat") or sync.get("sync_stat") or "")
        return etag, sync_stat

    async def _fetch_status_xml(self, endpoint: str, *, etag: str, wait: float) -> bytes | None:
        query = urlencode({"timeout": str(int(wait)), "etag": etag})
        connect = self.settings.device_http_timeout
        timeout = httpx.Timeout(
            connect=connect,
            read=wait + self.settings.long_poll_read_slack_seconds,
            write=connect,
            pool=connect,
        )
        return await self._get(
            endpoint,
            "/Status",
            query=query,
            retries=1,
            timeout=timeout,
            hold_slot=False,
        )

    def _snapshot_from_xml(
        self,
        *,
        sanitized: str,
        port: int,
        device_id: str | None,
        node_id: str,
        endpoint: str,
        sync_xml: bytes | None,
        status_xml: bytes | None,
        previous: PlayerStatus | None = None,
        reuse_sync: bool = False,
    ) -> PlayerSnapshot:
        player = (
            previous.model_copy(deep=True)
            if reuse_sync and previous is not None
            else self._shell_player(sanitized, port, device_id, node_id)
        )
        # SyncStatus alone is not a live player. A missed /Status used to look
        # healthy, clear the failure count, and hide the outage.
        if not status_xml and not reuse_sync:
            player.status = "offline"
            return PlayerSnapshot(player)

        sync: dict[str, Any] = {}
        if sync_xml and not reuse_sync:
            sync = self._parse_sync(sync_xml, endpoint)
            if not sync:
                player.status = "xml_error"
                return PlayerSnapshot(player)
            self._apply_sync_fields(
                player,
                sync,
                endpoint=endpoint,
                sanitized=sanitized,
                node_id=node_id,
                port=port,
                device_id=device_id,
            )

        status: dict[str, Any] = {}
        if status_xml:
            status = self._parse_status(status_xml, sanitized, port=port)
            if not status and player.status == "offline":
                player.status = "xml_error"
                return PlayerSnapshot(player)
            if status:
                overlay = sync.get("volume") is None
                if reuse_sync and previous is not None:
                    overlay = previous.sync_role != SyncRole.SYNCED
                self._apply_status_fields(player, status, overlay_volume=overlay)

        self._finalize_player(player)
        etag, sync_stat = self._tags_from_parsed(status, sync)
        return PlayerSnapshot(
            player, status_etag=etag, sync_stat=sync_stat, sync_read=bool(sync)
        )

    async def load_player(
        self,
        target: str,
        *,
        device_id: str | None = None,
        node_id: str = "",
        status_etag: str | None = None,
        sync_stat: str | None = None,
        previous: PlayerStatus | None = None,
        long_poll_seconds: float | None = None,
    ) -> PlayerSnapshot:
        resolved = self._resolve_target(target)
        if not resolved:
            invalid = PlayerStatus(id="invalid", ip=target or "", status="invalid")
            return PlayerSnapshot(invalid)
        sanitized, port = resolved
        endpoint = format_endpoint(sanitized, port)
        if long_poll_seconds is not None and status_etag:
            return await self._load_long_poll(
                endpoint,
                sanitized,
                port,
                device_id,
                node_id,
                status_etag=status_etag,
                sync_stat=sync_stat,
                previous=previous,
                wait=long_poll_seconds,
            )
        sync_xml, status_xml = await asyncio.gather(
            self._get(endpoint, "/SyncStatus"),
            self._get(endpoint, "/Status"),
        )
        return self._snapshot_from_xml(
            sanitized=sanitized,
            port=port,
            device_id=device_id,
            node_id=node_id,
            endpoint=endpoint,
            sync_xml=sync_xml,
            status_xml=status_xml,
        )

    async def _load_long_poll(
        self,
        endpoint: str,
        sanitized: str,
        port: int,
        device_id: str | None,
        node_id: str,
        *,
        status_etag: str,
        sync_stat: str | None,
        previous: PlayerStatus | None,
        wait: float,
    ) -> PlayerSnapshot:
        status_xml = await self._fetch_status_xml(endpoint, etag=status_etag, wait=wait)
        if not status_xml:
            player = self._shell_player(sanitized, port, device_id, node_id)
            player.status = "offline"
            return PlayerSnapshot(player)
        status = self._parse_status(status_xml, sanitized, port=port)
        if not status:
            player = self._shell_player(sanitized, port, device_id, node_id)
            player.status = "xml_error"
            return PlayerSnapshot(player)
        new_sync = str(status.get("sync_stat") or "")
        reuse = previous is not None and bool(new_sync) and new_sync == (sync_stat or "")
        sync_xml = None if reuse else await self._get(endpoint, "/SyncStatus")
        return self._snapshot_from_xml(
            sanitized=sanitized,
            port=port,
            device_id=device_id,
            node_id=node_id,
            endpoint=endpoint,
            sync_xml=sync_xml,
            status_xml=status_xml,
            previous=previous,
            reuse_sync=reuse,
        )

    async def get_player_status(
        self,
        target: str,
        *,
        device_id: str | None = None,
        node_id: str = "",
    ) -> PlayerStatus:
        return (await self.load_player(target, device_id=device_id, node_id=node_id)).player
