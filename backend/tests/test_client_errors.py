"""BluOS client error and edge-path coverage."""

from __future__ import annotations

import httpx
import pytest
import respx

from app.bluos.client import BluOSClient
from app.bluos.result import take_control_result
from app.config import Settings
from tests.fixtures.xml_samples import QUEUE, STATUS, SYNC_STATUS


@pytest.fixture
def settings() -> Settings:
    return Settings(
        allow_non_private_ips=True,
        device_http_timeout=1.0,
        control_rate_limit_seconds=0,
        max_xml_size=1024,
    )


@pytest.mark.asyncio
async def test_get_rejects_invalid_and_blocked_ips() -> None:
    settings = Settings(allow_non_private_ips=False, control_rate_limit_seconds=0)
    client = BluOSClient(settings)
    try:
        assert await client._get("not-an-ip", "/Status") is None
        assert await client._get("8.8.8.8", "/Status") is None
        assert await client._post("bad", "/Reboot") is False
        assert await client._post("8.8.8.8", "/Reboot") is False
        assert await client.add_sync_slave("bad", "192.168.1.2") is False
        assert await client.remove_sync_slave("192.168.1.1", "bad") is False
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_get_http_error_and_payload_too_large(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/Status").mock(
        return_value=httpx.Response(500, content=b"err")
    )
    respx.get("http://192.168.1.20:11000/SyncStatus").mock(
        return_value=httpx.Response(200, content=b"x" * 2000)
    )
    client = BluOSClient(settings)
    try:
        assert await client._get("192.168.1.20", "/Status") is None
        assert await client._get("192.168.1.20", "/SyncStatus") is None
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_get_retries_then_succeeds(settings: Settings) -> None:
    route = respx.get("http://192.168.1.20:11000/Status").mock(
        side_effect=[
            httpx.ConnectError("down"),
            httpx.ConnectError("down"),
            httpx.Response(200, content=STATUS),
        ]
    )
    client = BluOSClient(settings)
    try:
        raw = await client._get("192.168.1.20", "/Status", retries=3)
        assert raw is not None
        assert route.call_count == 3
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_get_retries_exhausted(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/Status").mock(side_effect=httpx.ConnectError("down"))
    client = BluOSClient(settings)
    try:
        assert await client._get("192.168.1.20", "/Status", retries=2) is None
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_post_transport_error(settings: Settings) -> None:
    respx.post("http://192.168.1.20/reboot").mock(side_effect=httpx.ConnectError("x"))
    client = BluOSClient(settings)
    try:
        assert await client.reboot("192.168.1.20") is False
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_artwork_stays_on_the_player_host(settings: Settings) -> None:
    art = respx.get("http://192.168.1.20:11000/Artwork").mock(
        return_value=httpx.Response(
            200,
            content=b"\xff\xd8\xff",
            headers={"content-type": "image/jpeg"},
        )
    )
    client = BluOSClient(settings)
    try:
        fetched = await client.fetch_artwork("192.168.1.20:11000", "/Artwork")
        assert fetched is not None
        assert fetched[1] == "image/jpeg"
        assert art.called
        assert (
            await client.fetch_artwork("192.168.1.20:11000", "http://10.1.1.1:11000/art")
            is None
        )
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_play_rejects_bluos_error_document(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/Play").mock(
        return_value=httpx.Response(
            200,
            content=b"<error>no slave available as new master</error>",
        )
    )
    client = BluOSClient(settings)
    try:
        assert await client.play("192.168.1.20") is False
        failure = take_control_result()
        assert failure is not None
        assert failure.kind == "bluos_error"
        assert "no slave" in failure.detail
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_play_timeout_is_named(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/Play").mock(side_effect=httpx.ConnectTimeout("slow"))
    client = BluOSClient(settings)
    try:
        assert await client.play("192.168.1.20") is False
        failure = take_control_result()
        assert failure is not None
        assert failure.kind == "timeout"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_volume_xml_still_succeeds(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/Volume").mock(
        return_value=httpx.Response(200, content=b"<volume>20</volume>")
    )
    client = BluOSClient(settings)
    try:
        assert await client.set_volume("192.168.1.20", 20) is True
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_player_status_offline_and_xml_error(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/SyncStatus").mock(
        return_value=httpx.Response(200, content=b"<not-xml")
    )
    respx.get("http://192.168.1.20:11000/Status").mock(
        return_value=httpx.Response(200, content=b"<not-xml")
    )
    client = BluOSClient(settings)
    try:
        player = await client.get_player_status("192.168.1.20", device_id="p1")
        assert player.status in {"xml_error", "offline"}
        offline = await client.get_player_status("bad-ip")
        assert offline.status == "invalid"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_queue_and_inputs_none_on_empty(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/Playlist").mock(
        return_value=httpx.Response(500, content=b"")
    )
    respx.get("http://192.168.1.20:11000/Settings").mock(
        return_value=httpx.Response(500, content=b"")
    )
    respx.get("http://192.168.1.20:11000/Presets").mock(
        return_value=httpx.Response(500, content=b"")
    )
    client = BluOSClient(settings)
    try:
        assert await client.get_queue("192.168.1.20") is None
        assert await client.get_inputs("192.168.1.20") is None
        assert await client.get_presets("192.168.1.20") is None
        assert await client.set_input("192.168.1.20", "") is False
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_set_input_by_type_index_and_unknown_name(settings: Settings) -> None:
    from tests.fixtures.xml_samples import CAPTURE_SETTINGS

    respx.get("http://192.168.1.20:11000/Settings").mock(
        return_value=httpx.Response(200, content=CAPTURE_SETTINGS)
    )
    respx.get("http://192.168.1.20:11000/Status").mock(
        return_value=httpx.Response(200, content=STATUS)
    )
    play = respx.get("http://192.168.1.20:11000/Play").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    client = BluOSClient(settings)
    try:
        assert await client.set_input("192.168.1.20", "spdif-1") is True
        assert "inputTypeIndex=spdif-1" in str(play.calls.last.request.url)
        assert await client.set_input("192.168.1.20", "No Such Input") is False
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_sync_fallback_paths(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/AddSlave").mock(
        return_value=httpx.Response(500, content=b"")
    )
    sync_add = respx.get("http://192.168.1.20:11000/Sync").mock(
        return_value=httpx.Response(200, content=b"<ok/>")
    )
    respx.get("http://192.168.1.20:11000/RemoveSlave").mock(
        return_value=httpx.Response(500, content=b"")
    )
    respx.get("http://192.168.1.21:11000/SyncStatus").mock(
        return_value=httpx.Response(
            200,
            content=b"<SyncStatus id='192.168.1.21:11000' name='Patio'/>",
        )
    )
    client = BluOSClient(settings)
    try:
        assert await client.add_sync_slave("192.168.1.20", "192.168.1.21") is True
        assert "slave=192.168.1.21" in str(sync_add.calls[0].request.url)
        assert await client.remove_sync_slave("192.168.1.20", "192.168.1.21") is True
        assert "remove=192.168.1.21" in str(sync_add.calls[-1].request.url)
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_get_text_and_absolute_media(settings: Settings) -> None:
    respx.get("http://192.168.1.20:11000/SyncStatus").mock(
        return_value=httpx.Response(200, content=SYNC_STATUS)
    )
    respx.get("http://192.168.1.20:11000/Status").mock(
        return_value=httpx.Response(200, content=STATUS)
    )
    client = BluOSClient(settings)
    try:
        text = await client._get_text("192.168.1.20", "/Status")
        assert text is not None
        assert client._absolute_media_url("192.168.1.20", "http://cdn/x.png") == "http://cdn/x.png"
        assert client._absolute_media_url("192.168.1.20", "") == ""
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_bluetooth_modes_and_queue_parse(settings: Settings) -> None:
    # max_xml_size bumped for QUEUE fixture path via separate client
    roomy = Settings(allow_non_private_ips=True, control_rate_limit_seconds=0)
    respx.get("http://192.168.1.20:11000/Playlist").mock(
        return_value=httpx.Response(200, content=QUEUE)
    )
    respx.get("http://192.168.1.20:11000/Settings").mock(
        return_value=httpx.Response(
            200,
            content=b"""<?xml version="1.0"?><settings>
              <setting id="bluetoothAutoplay" value="1"/>
            </settings>""",
        )
    )
    client = BluOSClient(roomy)
    try:
        queue = await client.get_queue("192.168.1.20")
        assert queue is not None and queue.count == 1
        assert await client.get_bluetooth_mode("192.168.1.20") == "Automatic"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_uptime_http_error(settings: Settings) -> None:
    respx.get("http://192.168.1.20/diagnostics").mock(
        return_value=httpx.Response(404, text="missing")
    )
    client = BluOSClient(settings)
    try:
        assert await client.get_uptime("192.168.1.20") is None
        blocked = BluOSClient(Settings(allow_non_private_ips=False))
        try:
            assert await blocked.get_uptime("8.8.8.8") is None
        finally:
            await blocked.aclose()
    finally:
        await client.aclose()
