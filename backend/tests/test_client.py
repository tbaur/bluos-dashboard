from __future__ import annotations

from pathlib import Path

import httpx
import pytest
import respx

from app.bluos.client import BluOSClient
from app.bluos.webui import BluOSWebUIMixin
from app.config import Settings
from tests.fixtures.xml_samples import (
    CAPTURE_SETTINGS,
    CAPTURE_SETTINGS_NO_BLUETOOTH,
    PRESETS,
    QUEUE,
    STATUS,
    STATUS_CAPTURE_OPTICAL,
    STATUS_GROUP_VOLUME,
    STATUS_TIDAL_CONNECT,
    SYNC_STATUS,
    SYNC_STATUS_SLAVE,
)


@pytest.fixture
def settings() -> Settings:
    return Settings(allow_non_private_ips=True, device_http_timeout=1.0)


@pytest.mark.asyncio
@respx.mock
async def test_get_player_status_parses_sync_and_status(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/SyncStatus").mock(
        return_value=httpx.Response(200, content=SYNC_STATUS)
    )
    respx.get("http://192.168.1.20:11000/Status").mock(
        return_value=httpx.Response(200, content=STATUS)
    )
    client = BluOSClient(settings)
    try:
        player = await client.get_player_status("192.168.1.20", device_id="kitchen")
        assert player.status == "online"
        assert player.name == "Kitchen"
        assert player.state == "play"
        assert player.volume == 22
        assert player.track == "Song Title"
        assert player.slaves == ["192.168.1.21:11000"]
        assert player.sync_role.value == "primary"
        assert player.mac == "90:56:82:00:00:01"
        assert player.device_class == "streamer"
        assert player.stream_format == "Ogg Vorbis"
        assert player.image == "http://192.168.1.20:11000/images/album.png"
        assert player.secs == 30
        assert player.totlen == 240
        assert player.can_seek is True
        assert player.shuffle == 1
        assert player.repeat == 2
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_synced_slave_uses_syncstatus_volume_not_group_status(
    settings: Settings,
) -> None:
    """Synced players' /Status volume is group/primary — use SyncStatus instead."""
    respx.get("http://192.168.1.88:11000/SyncStatus").mock(
        return_value=httpx.Response(200, content=SYNC_STATUS_SLAVE)
    )
    respx.get("http://192.168.1.88:11000/Status").mock(
        return_value=httpx.Response(200, content=STATUS_GROUP_VOLUME)
    )
    client = BluOSClient(settings)
    try:
        player = await client.get_player_status("192.168.1.88", device_id="kitchen")
        assert player.sync_role.value == "synced"
        assert player.volume == 64
        assert player.state == "stream"
        assert player.track == "Track"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_prefers_service_name_over_service_id(settings: Settings) -> None:
    """BluOS service id is TidalConnect; serviceName is the display label."""
    respx.get("http://192.168.1.20:11000/SyncStatus").mock(
        return_value=httpx.Response(200, content=SYNC_STATUS)
    )
    respx.get("http://192.168.1.20:11000/Status").mock(
        return_value=httpx.Response(200, content=STATUS_TIDAL_CONNECT)
    )
    client = BluOSClient(settings)
    try:
        player = await client.get_player_status("192.168.1.20", device_id="kitchen")
        assert player.service == "TIDAL connect"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_blocks_non_private_by_default() -> None:
    settings = Settings(allow_non_private_ips=False)
    client = BluOSClient(settings)
    try:
        player = await client.get_player_status("8.8.8.8", device_id="x")
        assert player.status == "offline"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_get_queue(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/Playlist").mock(
        return_value=httpx.Response(200, content=QUEUE)
    )
    client = BluOSClient(settings)
    try:
        queue = await client.get_queue("192.168.1.20")
        assert queue is not None
        assert queue.count == 1
        assert queue.items[0].title == "Track A"
        assert queue.items[0].artist == "Artist A"
        assert queue.items[0].album == "Album A"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_get_inputs_and_bluetooth_from_capture_settings(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/Settings").mock(
        return_value=httpx.Response(200, content=CAPTURE_SETTINGS)
    )
    respx.get("http://192.168.1.20:11000/Status").mock(
        return_value=httpx.Response(200, content=STATUS)
    )
    client = BluOSClient(settings)
    try:
        inputs = await client.get_inputs("192.168.1.20")
        assert inputs is not None
        assert [(i.name, i.id, i.selected) for i in inputs] == [
            ("Analog Input", "analog-1", False),
            ("Optical Input", "spdif-1", False),
            ("HDMI ARC", "arc-1", False),
        ]
        info = await client.get_bluetooth_info("192.168.1.20")
        assert info is not None
        assert info.supported is True
        assert info.mode == "Disabled"
        assert await client.get_bluetooth_mode("192.168.1.20") == "Disabled"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_bluetooth_absent_from_capture_settings(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/Settings").mock(
        return_value=httpx.Response(200, content=CAPTURE_SETTINGS_NO_BLUETOOTH)
    )
    client = BluOSClient(settings)
    try:
        info = await client.get_bluetooth_info("192.168.1.20")
        assert info is not None
        assert info.supported is False
        assert info.mode is None
        assert await client.get_bluetooth_mode("192.168.1.20") is None
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_get_inputs_marks_active_capture_input(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/Settings").mock(
        return_value=httpx.Response(200, content=CAPTURE_SETTINGS)
    )
    respx.get("http://192.168.1.20:11000/Status").mock(
        return_value=httpx.Response(200, content=STATUS_CAPTURE_OPTICAL)
    )
    client = BluOSClient(settings)
    try:
        inputs = await client.get_inputs("192.168.1.20")
        assert inputs is not None
        selected = [i for i in inputs if i.selected]
        assert len(selected) == 1
        assert selected[0].id == "spdif-1"
        assert selected[0].name == "Optical Input"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_set_input_uses_input_type_index(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/Settings").mock(
        return_value=httpx.Response(200, content=CAPTURE_SETTINGS)
    )
    respx.get("http://192.168.1.20:11000/Status").mock(
        return_value=httpx.Response(200, content=STATUS)
    )
    route = respx.get("http://192.168.1.20:11000/Play").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    client = BluOSClient(settings)
    try:
        assert await client.set_input("192.168.1.20", "Optical Input") is True
        assert route.called
        assert "inputTypeIndex=spdif-1" in str(route.calls.last.request.url)
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_clear_and_move_queue_use_v17_paths(settings: Settings) -> None:
    clear_route = respx.get("http://192.168.1.20:11000/Clear").mock(
        return_value=httpx.Response(200, content=b"<playlist length=\"0\"/>")
    )
    move_route = respx.get("http://192.168.1.20:11000/Move").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    client = BluOSClient(settings)
    try:
        assert await client.clear_queue("192.168.1.20") is True
        assert await client.move_queue_item("192.168.1.20", 1, 0) is True
        assert clear_route.called
        assert "old=1" in str(move_route.calls.last.request.url)
        assert "new=0" in str(move_route.calls.last.request.url)
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_settings_follows_port_redirect(settings: Settings) -> None:
    """BluOS serves /Settings on :11001 and 301s from :11000."""
    respx.get("http://192.168.1.20:11000/Settings").mock(
        return_value=httpx.Response(
            301,
            headers={"Location": "http://192.168.1.20:11001/Settings?id=capture&schemaVersion=32"},
        )
    )
    respx.get("http://192.168.1.20:11001/Settings").mock(
        return_value=httpx.Response(200, content=CAPTURE_SETTINGS)
    )
    respx.get("http://192.168.1.20:11000/Status").mock(
        return_value=httpx.Response(200, content=STATUS)
    )
    client = BluOSClient(settings)
    try:
        inputs = await client.get_inputs("192.168.1.20")
        assert inputs is not None
        assert len(inputs) == 3
        assert await client.get_bluetooth_mode("192.168.1.20") == "Disabled"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_settings_blocks_cross_host_redirect(settings: Settings) -> None:
    """Redirects to a different host must not be followed (SSRF guard)."""
    respx.get("http://192.168.1.20:11000/Settings").mock(
        return_value=httpx.Response(
            301,
            headers={"Location": "http://169.254.169.254/latest/meta-data/"},
        )
    )
    client = BluOSClient(settings)
    try:
        inputs = await client.get_inputs("192.168.1.20")
        assert inputs is None
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_redirect_target_edge_cases(settings: Settings) -> None:
    client = BluOSClient(settings)
    try:
        assert (
            client._redirect_target_allowed(
                "192.168.1.20",
                "http://192.168.1.20:11000/Settings",
                "ftp://192.168.1.20/x",
            )
            is None
        )
        blocked = BluOSClient(Settings(allow_non_private_ips=False, device_http_timeout=1.0))
        try:
            assert (
                blocked._redirect_target_allowed(
                    "8.8.8.8",
                    "http://8.8.8.8:11000/Settings",
                    "http://8.8.8.8:11001/Settings",
                )
                is None
            )
        finally:
            await blocked.aclose()
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_redirect_without_location_returns_response(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/Settings").mock(
        return_value=httpx.Response(302, content=b"")
    )
    client = BluOSClient(settings)
    try:
        assert await client.get_inputs("192.168.1.20") is None
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_redirect_limit_exceeded(settings: Settings) -> None:
    def bounce(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            307,
            headers={"Location": str(request.url)},
        )

    respx.get(url__regex=r"http://192\.168\.1\.20:1100[01]/Settings.*").mock(side_effect=bounce)
    client = BluOSClient(settings)
    try:
        assert await client.get_inputs("192.168.1.20") is None
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_post_303_switches_to_get(settings: Settings) -> None:
    respx.post("http://192.168.1.20/reboot").mock(
        return_value=httpx.Response(
            303,
            headers={"Location": "http://192.168.1.20:8080/done"},
        )
    )
    respx.get("http://192.168.1.20:8080/done").mock(
        return_value=httpx.Response(200, content=b"ok")
    )
    client = BluOSClient(settings)
    try:
        assert await client.reboot("192.168.1.20") is True
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_toggle_reboot_presets_and_sync(settings: Settings) -> None:
    pause = respx.get("http://192.168.1.20:11000/Pause").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    play = respx.get("http://192.168.1.20:11000/Play").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    reboot = respx.post("http://192.168.1.20/reboot").mock(
        return_value=httpx.Response(200, text="ok")
    )
    respx.get("http://192.168.1.20:11000/Presets").mock(
        return_value=httpx.Response(200, content=PRESETS)
    )
    preset_play = respx.get("http://192.168.1.20:11000/Preset").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    bt = respx.get("http://192.168.1.20:11000/audiomodes").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    add = respx.get("http://192.168.1.20:11000/AddSlave").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    remove = respx.get("http://192.168.1.20:11000/RemoveSlave").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    respx.get("http://192.168.1.21:11000/SyncStatus").mock(
        return_value=httpx.Response(
            200,
            content=b"<SyncStatus id='192.168.1.21:11000' name='Patio'/>",
        )
    )
    volume = respx.get("http://192.168.1.20:11000/Volume").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    client = BluOSClient(settings)
    try:
        assert await client.toggle("192.168.1.20", state="play") is True
        assert pause.called
        assert await client.toggle("192.168.1.20", state="pause") is True
        assert play.called
        assert await client.reboot("192.168.1.20") is True
        assert reboot.called
        assert reboot.calls.last.request.url.host == "192.168.1.20"
        assert reboot.calls.last.request.url.port in (None, 80)
        assert "yes=1" in (reboot.calls.last.request.content or b"").decode()
        assert reboot.calls.last.request.url.path == "/reboot"
        presets = await client.get_presets("192.168.1.20")
        assert presets is not None
        assert presets[0].name == "Morning"
        assert await client.play_preset("192.168.1.20", 1) is True
        assert "id=1" in str(preset_play.calls.last.request.url)
        assert await client.play_preset("192.168.1.20", 0) is False
        assert await client.set_bluetooth_mode("192.168.1.20", 1) is True
        assert "bluetoothAutoplay=1" in str(bt.calls.last.request.url)
        assert await client.add_sync_slave("192.168.1.20", "192.168.1.21") is True
        assert add.called
        assert "slave=192.168.1.21" in str(add.calls.last.request.url)
        assert "port=11000" in str(add.calls.last.request.url)
        assert await client.remove_sync_slave("192.168.1.20", "192.168.1.21") is True
        assert remove.called
        assert await client.adjust_volume("192.168.1.20", 5, 10) is True
        assert "level=15" in str(volume.calls.last.request.url)
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_get_uptime_uses_port_80_diagnostics(settings: Settings) -> None:
    respx.get("http://192.168.1.20/diagnostics").mock(
        return_value=httpx.Response(
            200,
            text="<div>Uptime:</div><div>12h3m</div>",
        )
    )
    client = BluOSClient(settings)
    try:
        assert await client.get_uptime("192.168.1.20") == "12h3m"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_diagnostics_logs_when_uptime_markup_changes(
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    respx.get("http://192.168.1.20/diagnostics").mock(
        return_value=httpx.Response(200, text="<html>no uptime here</html>")
    )
    client = BluOSClient(settings)
    try:
        with caplog.at_level("WARNING"):
            parsed = await client.get_diagnostics("192.168.1.20")
        assert "uptime" not in (parsed or {})
        assert any("diagnostics_uptime_missing" in record.message for record in caplog.records)
    finally:
        await client.aclose()


def test_parse_ci_s2_diagnostics_html() -> None:
    html = (Path(__file__).parent / "fixtures" / "ci_diagnostics.html").read_text()
    parsed = BluOSWebUIMixin._parse_diagnostics_html(html)
    assert parsed["uptime"] == "37h13m24s"
    assert parsed["web_ip"] == "172.16.10.101"
    assert parsed["web_mac"] == "90:56:82:16:61:8c"
    assert parsed["web_fw"] == "4.16.6"
    assert parsed["total_songs"] == "0"
    assert "network_name" not in parsed
    assert "signal_strength" not in parsed


@pytest.mark.asyncio
@respx.mock
async def test_diagnostics_retries_connect_error(settings: Settings) -> None:
    respx.get("http://192.168.1.20/diagnostics").mock(
        side_effect=[
            httpx.ConnectError("boom"),
            httpx.Response(
                200,
                text=(
                    '<div class="ui-block-a">Uptime:</div>'
                    '<div class="ui-block-b">12h3m</div>'
                ),
            ),
        ]
    )
    client = BluOSClient(settings)
    try:
        assert await client.get_uptime("192.168.1.20") == "12h3m"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_uptime_fallbacks_and_errors(settings: Settings) -> None:
    respx.get("http://192.168.1.20/diagnostics").mock(
        return_value=httpx.Response(200, text="<p>Uptime: </p> 9d4h")
    )
    client = BluOSClient(settings)
    try:
        assert await client.get_uptime("192.168.1.20") == "9d4h"
        assert await client.get_uptime("not-an-ip") is None
    finally:
        await client.aclose()


def test_input_type_from_icon_hints() -> None:
    assert BluOSClient._input_type_from_capture("Mystery", "ic_optical.png") == "spdif"
    assert BluOSClient._input_type_from_capture("Unknown Port", "") == "analog"


@pytest.mark.asyncio
@respx.mock
async def test_settings_and_upgrade_web_ui(settings: Settings) -> None:
    from tests.fixtures.xml_samples import AUDIO_SETTINGS, PLAYER_SETTINGS

    def settings_response(request: httpx.Request) -> httpx.Response:
        if "id=audio" in str(request.url):
            return httpx.Response(200, content=AUDIO_SETTINGS)
        return httpx.Response(200, content=PLAYER_SETTINGS)

    respx.get(url__regex=r"http://192\.168\.1\.20:11000/Settings.*").mock(
        side_effect=settings_response
    )
    respx.get(url__regex=r"http://192\.168\.1\.20:11000/alsa_setting.*").mock(
        return_value=httpx.Response(200, content=b"")
    )
    respx.get(url__regex=r"http://192\.168\.1\.20:11000/audiomodes.*").mock(
        return_value=httpx.Response(200, content=b"")
    )
    respx.post("http://192.168.1.20/settings").mock(return_value=httpx.Response(200, text="ok"))
    respx.get("http://192.168.1.20/upgrade").mock(
        return_value=httpx.Response(
            200,
            text='<div data-role="content"><p>No update available.</p></div>',
        )
    )
    respx.get("http://192.168.1.20/diagnostics").mock(
        return_value=httpx.Response(
            200,
            text=(
                '<div class="ui-block-a">Signal Strength:</div>'
                '<div class="ui-block-b">-70 dBm</div>'
                '<div class="ui-block-a">Uptime:</div>'
                '<div class="ui-block-b">12h3m</div>'
            ),
        )
    )
    client = BluOSClient(settings)
    try:
        audio = await client.get_device_settings("192.168.1.20", "audio")
        assert audio is not None
        assert any(s.id == "eq-treble" for s in audio.settings)
        assert any(s.id == "replayGainMode" and len(s.options) == 2 for s in audio.settings)

        player = await client.get_device_settings("192.168.1.20", "player")
        assert player is not None
        assert all(s.id != "wifi" for s in player.settings)
        assert any(s.id == "ledbrightness" for s in player.settings)
        assert any(
            s.id == "amplifierStandby" and s.control_path == "/setting"
            for s in player.settings
        )

        assert await client.set_device_setting("192.168.1.20", "eq-treble", "3") is True
        assert (
            await client.set_device_setting(
                "192.168.1.20",
                "channelMode",
                "left",
                control_path="/audiomodes",
            )
            is True
        )
        # Omitting control_path still resolves /alsa_setting from Settings XML.
        alsa_calls = [
            call
            for call in respx.calls
            if "alsa_setting" in str(call.request.url) and "eq-treble=3" in str(call.request.url)
        ]
        assert alsa_calls

        upgrade = await client.get_upgrade_status(
            "192.168.1.20", device_id="p1", name="Kitchen", current_fw="4.16.6"
        )
        assert upgrade.ok is True
        assert upgrade.update_available is False
        diag = await client.get_diagnostics("192.168.1.20")
        assert diag is not None
        assert diag["uptime"] == "12h3m"
        assert diag["signal_strength"] == "-70 dBm"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_upgrade_available_and_settings_edge_cases(settings: Settings) -> None:
    respx.get("http://192.168.1.20/upgrade").mock(
        return_value=httpx.Response(
            200,
            text='<div data-role="content"><p>Update available.</p><a>I want it now</a></div>',
        )
    )
    respx.get("http://192.168.1.20/diagnostics").mock(return_value=httpx.Response(500))
    # Resolve finds no settings pages → empty control_path → web UI POST fails.
    respx.get(url__regex=r"http://192\.168\.1\.20:11000/Settings.*").mock(
        return_value=httpx.Response(404)
    )
    respx.post("http://192.168.1.20/settings").mock(return_value=httpx.Response(500))
    client = BluOSClient(settings)
    try:
        upgrade = await client.get_upgrade_status("192.168.1.20", current_fw="4.10.0")
        assert upgrade.update_available is True
        assert upgrade.ok is True
        assert await client.get_diagnostics("192.168.1.20") is None
        assert await client.get_device_settings("192.168.1.20", "library") is None
        assert await client.set_device_setting("192.168.1.20", "", "1") is False
        assert await client.set_device_setting("192.168.1.20", "eq-treble", "1") is False
    finally:
        await client.aclose()


def test_setting_write_request_validation() -> None:
    from pydantic import ValidationError

    from app.models import SettingWriteRequest

    ok = SettingWriteRequest(id="eq-treble", value="2")
    assert ok.id == "eq-treble"
    with pytest.raises(ValidationError):
        SettingWriteRequest(id="bad/id", value="1")
    with pytest.raises(ValidationError):
        SettingWriteRequest(id="eq!", value="1")
    with pytest.raises(ValidationError):
        SettingWriteRequest(id="eq-treble", value="x\ny")


@pytest.mark.asyncio
@respx.mock
async def test_web_ui_port_override(settings: Settings) -> None:
    settings.web_ui_port = 8080
    respx.get("http://192.168.1.20:8080/upgrade").mock(
        return_value=httpx.Response(
            200,
            text='<div data-role="content"><p>No update available.</p></div>',
        )
    )
    client = BluOSClient(settings)
    try:
        status = await client.get_upgrade_status("192.168.1.20")
        assert status.ok is True
        assert status.update_available is False
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_ci_secondary_zone_status_and_add_slave_port(settings: Settings) -> None:
    sync = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        b'<SyncStatus name="Zone B" modelName="CI S2" brand="NAD" '
        b'id="172.16.10.144:11010" volume="10" mac="90:56:82:16:61:B7:11010">'
        b"</SyncStatus>"
    )
    status = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<status><state>stop</state><volume>10</volume></status>
"""
    respx.get("http://172.16.10.144:11010/SyncStatus").mock(
        return_value=httpx.Response(200, content=sync)
    )
    respx.get("http://172.16.10.144:11010/Status").mock(
        return_value=httpx.Response(200, content=status)
    )
    add = respx.get("http://172.16.10.144:11000/AddSlave").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    client = BluOSClient(settings)
    try:
        player = await client.get_player_status(
            "172.16.10.144:11010",
            device_id="zone-b",
        )
        assert player.status == "online"
        assert player.port == 11010
        assert player.zone == 2
        assert player.endpoint == "172.16.10.144:11010"
        assert player.brand == "NAD"
        assert player.mac == "90:56:82:16:61:B7"
        assert await client.add_sync_slave(
            "172.16.10.144:11000",
            "172.16.10.144:11010",
        )
        assert "slave=172.16.10.144" in str(add.calls.last.request.url)
        assert "port=11010" in str(add.calls.last.request.url)
    finally:
        await client.aclose()
