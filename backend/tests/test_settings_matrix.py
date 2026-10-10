"""Settings parse + write matrix — every control path Kitchen exposes."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
import respx

from app.bluos.client import BluOSClient
from app.config import Settings

FIXTURES = Path(__file__).parent / "fixtures"
AUDIO_XML = (FIXTURES / "settings_audio.xml").read_bytes()
PLAYER_XML = (FIXTURES / "settings_player.xml").read_bytes()

# Live-verified write matrix for NODE/Kitchen-style Settings pages.
# control_path empty => reverse-engineered POST :80/settings.
WRITE_CASES = [
    ("eq-switch", "ON", "/alsa_setting", "alsa_setting"),
    ("eq-treble", "1", "/alsa_setting", "alsa_setting"),
    ("eq-bass", "-1", "/alsa_setting", "alsa_setting"),
    ("subwoofer", "withsub", "/audiomodes", "audiomodes"),
    ("eq-crossover", "90", "/alsa_setting", "alsa_setting"),
    ("replayGainMode", "track", "/audiomodes", "audiomodes"),
    ("channelMode", "left", "/audiomodes", "audiomodes"),
    ("mqaDisable", "ON", "/audiomodes", "audiomodes"),
    ("fixedVolume", "ON", "", "web_ui"),
    ("volumeLimits", "-90,-10", "", "web_ui"),
    ("enableClockTrim", "OFF", "/audiomodes", "audiomodes"),
    ("reset", "1", "/alsa_setting", "alsa_setting"),
    ("ledbrightness", "dim", "/setting", "setting"),
    ("nodename", "Zone C", "/Name", "Name"),
    ("amplifierStandby", "OFF", "/setting", "setting"),
]


@pytest.fixture
def settings() -> Settings:
    return Settings(
        discovery_cache_ttl=0,
        poll_interval=60,
        device_http_timeout=2.0,
        control_rate_limit_seconds=0,
    )


def _settings_route(request: httpx.Request) -> httpx.Response:
    url = str(request.url)
    if "id=audio" in url:
        return httpx.Response(200, content=AUDIO_XML)
    if "id=player" in url:
        return httpx.Response(200, content=PLAYER_XML)
    return httpx.Response(404, content=b"missing")


@pytest.mark.asyncio
@respx.mock
async def test_parse_kitchen_audio_and_player_fixtures(settings: Settings) -> None:
    respx.get(url__regex=r".*/Settings.*").mock(side_effect=_settings_route)
    client = BluOSClient(settings)
    try:
        audio = await client.get_device_settings("192.168.1.20", "audio")
        player = await client.get_device_settings("192.168.1.20", "player")
        assert audio is not None
        assert player is not None

        by_id = {s.id: s for s in audio.settings}
        assert by_id["eq-switch"].kind == "boolean"
        assert by_id["eq-switch"].control_path == "/alsa_setting"
        assert by_id["subwoofer"].options[0].name == "default"
        assert by_id["subwoofer"].options[0].display_name == "Off"
        assert by_id["subwoofer"].options[1].name == "withsub"
        assert by_id["channelMode"].options[0].display_name == "Stereo"
        assert by_id["channelMode"].value == "default"
        assert by_id["volumeLimits"].kind == "dual-range"
        assert by_id["volumeLimits"].control_path == ""
        assert by_id["fixedVolume"].control_path == ""
        assert by_id["fixedVolume"].depends_on == "mqaDisable"
        assert [(dep.name, dep.value) for dep in by_id["mqaDisable"].dependencies] == [
            ("replayGainMode", "none"),
            ("fixedVolume", "ON"),
            ("eq-switch", "OFF"),
        ]
        assert by_id["volumeLimits"].min_value == -90
        assert by_id["volumeLimits"].min_range == 30
        assert by_id["eq-switch"].hide_if_disabled is True
        assert by_id["reset"].kind == "button"

        player_by_id = {s.id: s for s in player.settings}
        assert "wifi" not in player_by_id  # webview-only skipped
        assert player_by_id["ledbrightness"].control_path == "/setting"
        assert player_by_id["nodename"].control_path == "/Name"
        assert player_by_id["nodename"].disabled is True
        assert player_by_id["nodename"].pattern == ".{1,255}"
        assert player_by_id["nodename"].refresh_after_write is True
        audio_ids = {case[0] for case in WRITE_CASES} - {
            "ledbrightness",
            "nodename",
            "amplifierStandby",
        }
        assert {s.id for s in audio.settings} >= audio_ids
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
@pytest.mark.parametrize(
    ("setting_id", "value", "control_path", "expected"),
    WRITE_CASES,
    ids=[case[0] for case in WRITE_CASES],
)
async def test_write_matrix_hits_expected_endpoint(
    settings: Settings,
    setting_id: str,
    value: str,
    control_path: str,
    expected: str,
) -> None:
    respx.get(url__regex=r".*/Settings.*").mock(side_effect=_settings_route)
    empty = httpx.Response(200, content=b"")
    alsa = respx.get(url__regex=r".*/alsa_setting.*").mock(return_value=empty)
    audio = respx.get(url__regex=r".*/audiomodes.*").mock(return_value=empty)
    setting = respx.get(url__regex=r"http://192\.168\.1\.20:11000/setting\?.*").mock(
        return_value=empty
    )
    name = respx.get(url__regex=r".*/Name\?.*").mock(return_value=empty)
    web = respx.post("http://192.168.1.20/settings").mock(
        return_value=httpx.Response(200, text="ok")
    )

    client = BluOSClient(settings)
    try:
        ok = await client.set_device_setting(
            "192.168.1.20",
            setting_id,
            value,
            control_path=control_path,
        )
        assert ok is True
        if expected == "alsa_setting":
            assert alsa.called
            assert setting_id in str(alsa.calls.last.request.url)
            assert value in str(alsa.calls.last.request.url)
            assert not web.called
        elif expected == "audiomodes":
            assert audio.called
            assert setting_id in str(audio.calls.last.request.url)
            assert value in str(audio.calls.last.request.url)
            assert not web.called
        elif expected == "setting":
            assert setting.called
            assert f"{setting_id}={value}" in str(setting.calls.last.request.url)
            assert not web.called
        elif expected == "Name":
            assert name.called
            assert "name=" in str(name.calls.last.request.url)
            assert not web.called
        elif expected == "web_ui":
            assert web.called
            assert web.calls.last.request.content is not None
            body = web.calls.last.request.content.decode()
            assert f"id={setting_id}" in body
            assert f"value={value}" in body or f"value={value.replace(',', '%2C')}" in body
            assert not alsa.called
            assert not audio.called
        else:
            raise AssertionError(expected)
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_write_resolves_control_path_when_omitted(settings: Settings) -> None:
    """API clients that omit control_path still hit /audiomodes for channelMode."""
    respx.get(url__regex=r".*/Settings.*").mock(side_effect=_settings_route)
    audio = respx.get(url__regex=r".*/audiomodes.*").mock(
        return_value=httpx.Response(200, content=b"")
    )
    web = respx.post("http://192.168.1.20/settings").mock(
        return_value=httpx.Response(400, text="No such setting")
    )
    client = BluOSClient(settings)
    try:
        ok = await client.set_device_setting("192.168.1.20", "channelMode", "left")
        assert ok is True
        assert audio.called
        assert "channelMode=left" in str(audio.calls.last.request.url)
        assert not web.called
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_web_ui_fallback_when_bluos_path_fails(settings: Settings) -> None:
    respx.get(url__regex=r".*/audiomodes.*").mock(return_value=httpx.Response(500))
    web = respx.post("http://192.168.1.20/settings").mock(
        return_value=httpx.Response(200, text="ok")
    )
    client = BluOSClient(settings)
    try:
        ok = await client.set_device_setting(
            "192.168.1.20",
            "channelMode",
            "left",
            control_path="/audiomodes",
        )
        assert ok is True
        assert web.called
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_channel_mode_web_ui_alone_is_not_enough(settings: Settings) -> None:
    """Regression: POST :80/settings rejects channelMode with 'No such setting'."""
    # Settings pages unavailable → resolve cannot find /audiomodes.
    respx.get(url__regex=r".*/Settings.*").mock(return_value=httpx.Response(404))
    web = respx.post("http://192.168.1.20/settings").mock(
        return_value=httpx.Response(400, text="No such setting")
    )
    client = BluOSClient(settings)
    try:
        ok = await client.set_device_setting("192.168.1.20", "channelMode", "left")
        assert ok is False
        assert web.called
    finally:
        await client.aclose()
