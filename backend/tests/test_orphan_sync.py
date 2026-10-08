"""Orphan sync break when the primary is offline (reparent ungroup)."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import httpx
import pytest
import respx
from httpx import ASGITransport, AsyncClient

from app.bluos.client import BluOSClient
from app.config import Settings, get_settings
from app.discovery.service import DiscoveryService
from app.main import create_app
from app.models import PlayerStatus, SyncRole
from app.services.events import EventBus
from app.services.poller import StatusPoller
from app.services.sync import build_sync_state, orphan_primary_id
from app.state import AppState


@pytest.fixture
def settings() -> Settings:
    get_settings.cache_clear()
    return Settings(
        discovery_cache_ttl=0,
        poll_interval=60,
        allow_non_private_ips=True,
        control_rate_limit_seconds=0,
        cors_origins="http://127.0.0.1:8765,http://localhost:8765",
    )


def _seed_devices(discovery: DiscoveryService, devices: list[PlayerStatus]) -> None:
    discovery._snapshot.devices = devices
    discovery._snapshot.endpoints_by_id = {p.id: p.endpoint for p in devices}
    discovery._snapshot.ids_by_endpoint = {p.endpoint: p.id for p in devices}
    discovery._snapshot.discovered_at = 1.0


def test_build_sync_state_includes_orphan_group() -> None:
    orphan = PlayerStatus(
        id="roaming",
        ip="172.16.10.166",
        name="Roaming",
        status="online",
        master="172.16.10.174:11000",
        sync_role=SyncRole.SYNCED,
    )
    donor = PlayerStatus(
        id="donor",
        ip="172.16.10.144",
        name="Donor",
        status="online",
        sync_role=SyncRole.STANDALONE,
    )
    state = build_sync_state([orphan, donor])
    assert len(state.groups) == 1
    group = state.groups[0]
    assert group.primary_id == orphan_primary_id("172.16.10.174:11000")
    assert group.primary_name == "Offline primary"
    assert group.primary_endpoint == "172.16.10.174:11000"
    assert group.slave_ids == ["roaming"]
    assert state.standalone_ids == ["donor"]


@pytest.mark.asyncio
@respx.mock
async def test_remove_sync_slave_reparents_orphan(settings: Settings) -> None:
    """Dead primary → AddSlave on donor → RemoveSlave on donor → standalone."""
    dead_master = "172.16.10.174:11000"
    slave = "172.16.10.166:11000"
    donor = "172.16.10.144:11000"

    down = httpx.ConnectError("primary offline")
    respx.get(f"http://{dead_master}/RemoveSlave").mock(side_effect=down)
    respx.get(url__regex=r"http://172\.16\.10\.174:11000/Sync\?.*").mock(side_effect=down)
    respx.get(f"http://{slave}/RemoveSlave").mock(
        return_value=httpx.Response(
            200,
            content=b"<error>no slave available as new master</error>",
        )
    )
    respx.get(url__regex=r"http://172\.16\.10\.166:11000/Sync\?.*").mock(
        return_value=httpx.Response(
            200,
            content=b"<error>no slave available as new master</error>",
        )
    )
    respx.get(f"http://{donor}/AddSlave").mock(
        return_value=httpx.Response(
            200,
            content=b'<addSlave><slave id="172.16.10.166" port="11000"/></addSlave>',
        )
    )
    respx.get(f"http://{donor}/RemoveSlave").mock(
        return_value=httpx.Response(200, content=b"<SyncStatus/>")
    )
    respx.get(f"http://{slave}/SyncStatus").mock(
        return_value=httpx.Response(
            200,
            content=b"<SyncStatus id='172.16.10.166:11000' name='Roaming'/>",
        )
    )

    client = BluOSClient(settings)
    client._ungroup_verify_attempts = 2
    client._ungroup_verify_delay = 0
    try:
        ok = await client.remove_sync_slave(
            dead_master,
            slave,
            donor_endpoints=[donor, slave],
        )
        assert ok is True
        assert respx.calls.call_count >= 4
        urls = [str(c.request.url) for c in respx.calls]
        assert any("/AddSlave" in u and "172.16.10.144" in u for u in urls)
        assert any("/RemoveSlave" in u and "172.16.10.144" in u for u in urls)
    finally:
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_remove_sync_slave_rejects_error_xml(settings: Settings) -> None:
    down = httpx.ConnectError("primary offline")
    respx.get("http://172.16.10.174:11000/RemoveSlave").mock(side_effect=down)
    respx.get(url__regex=r"http://172\.16\.10\.174:11000/Sync\?.*").mock(side_effect=down)
    respx.get("http://172.16.10.166:11000/RemoveSlave").mock(
        return_value=httpx.Response(
            200,
            content=b"<error>no slave available as new master</error>",
        )
    )
    respx.get(url__regex=r"http://172\.16\.10\.166:11000/Sync\?.*").mock(
        return_value=httpx.Response(
            200,
            content=b"<error>no slave available as new master</error>",
        )
    )

    client = BluOSClient(settings)
    client._ungroup_verify_attempts = 1
    client._ungroup_verify_delay = 0
    try:
        ok = await client.remove_sync_slave(
            "172.16.10.174:11000",
            "172.16.10.166:11000",
            donor_endpoints=[],
        )
        assert ok is False
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_sync_break_orphans_via_reparent(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def seeded(self: DiscoveryService, *args, **kwargs):
        return self._snapshot

    monkeypatch.setattr(DiscoveryService, "refresh", seeded)
    monkeypatch.setattr(DiscoveryService, "get_devices", seeded)

    app = create_app()
    client = BluOSClient(settings)
    events = EventBus()
    discovery = DiscoveryService(settings, client)
    orphan = PlayerStatus(
        id="roaming",
        ip="172.16.10.166",
        name="Roaming",
        status="online",
        master="172.16.10.174:11000",
        sync_role=SyncRole.SYNCED,
    )
    donor = PlayerStatus(
        id="donor",
        ip="172.16.10.144",
        name="Donor",
        status="online",
        sync_role=SyncRole.STANDALONE,
    )
    _seed_devices(discovery, [orphan, donor])
    discovery._grace_endpoints["gone"] = "172.16.10.174:11000"
    discovery._grace_until["gone"] = time.time() + 60
    poller = StatusPoller(settings, discovery, client, events)
    poller.refresh_one = AsyncMock(return_value=None)  # type: ignore[method-assign]
    client.remove_sync_slave = AsyncMock(return_value=True)  # type: ignore[method-assign]
    client.stop = AsyncMock(return_value=True)  # type: ignore[method-assign]
    app.state.app_state = AppState(
        settings=settings,
        client=client,
        discovery=discovery,
        events=events,
        poller=poller,
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post("/api/v1/sync/break")
    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "sync_break"
    assert body["succeeded"] == 1
    assert body["failed"] == 0
    client.remove_sync_slave.assert_awaited_once()
    args = client.remove_sync_slave.await_args
    assert args is not None
    assert args.args[0] == "172.16.10.174:11000"
    assert args.args[1] == "172.16.10.166:11000"
    assert "172.16.10.144:11000" in args.kwargs["donor_endpoints"]
    # Offline primary must not be stopped / refreshed.
    stopped = [call.args[0] for call in client.stop.await_args_list]
    assert stopped == ["172.16.10.166:11000"]
    poller.refresh_one.assert_awaited_once_with("roaming")


@pytest.mark.asyncio
async def test_sync_break_donors_exclude_other_group_members(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def seeded(self: DiscoveryService, *args, **kwargs):
        return self._snapshot

    monkeypatch.setattr(DiscoveryService, "refresh", seeded)
    monkeypatch.setattr(DiscoveryService, "get_devices", seeded)

    app = create_app()
    client = BluOSClient(settings)
    events = EventBus()
    discovery = DiscoveryService(settings, client)
    orphan = PlayerStatus(
        id="roaming",
        ip="172.16.10.166",
        name="Roaming",
        status="online",
        master="172.16.10.174:11000",
        sync_role=SyncRole.SYNCED,
    )
    other_primary = PlayerStatus(
        id="other-primary",
        ip="172.16.10.150",
        name="OtherLead",
        status="online",
        sync_role=SyncRole.PRIMARY,
        slaves=["172.16.10.151:11000"],
    )
    other_slave = PlayerStatus(
        id="other-slave",
        ip="172.16.10.151",
        name="OtherFollower",
        status="online",
        sync_role=SyncRole.SYNCED,
        master="172.16.10.150:11000",
    )
    free = PlayerStatus(
        id="free",
        ip="172.16.10.144",
        name="Free",
        status="online",
        sync_role=SyncRole.STANDALONE,
    )
    _seed_devices(discovery, [orphan, other_primary, other_slave, free])
    discovery._grace_endpoints["gone"] = "172.16.10.174:11000"
    discovery._grace_until["gone"] = time.time() + 60
    poller = StatusPoller(settings, discovery, client, events)
    poller.refresh_one = AsyncMock(return_value=None)  # type: ignore[method-assign]
    client.remove_sync_slave = AsyncMock(return_value=True)  # type: ignore[method-assign]
    client.stop = AsyncMock(return_value=True)  # type: ignore[method-assign]
    app.state.app_state = AppState(
        settings=settings,
        client=client,
        discovery=discovery,
        events=events,
        poller=poller,
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post("/api/v1/sync/break")
    assert response.status_code == 200
    args = client.remove_sync_slave.await_args
    assert args is not None
    donors = args.kwargs["donor_endpoints"]
    assert donors == ["172.16.10.144:11000"]


@pytest.mark.asyncio
@respx.mock
async def test_remove_sync_slave_tries_second_donor_after_first_fails(
    settings: Settings,
) -> None:
    """AddSlave on donor1 succeeds but Remove fails → try donor2."""
    dead_master = "172.16.10.174:11000"
    slave = "172.16.10.166:11000"
    donor1 = "172.16.10.144:11000"
    donor2 = "172.16.10.150:11000"
    down = httpx.ConnectError("primary offline")
    err = b"<error>no slave available as new master</error>"

    respx.get(f"http://{dead_master}/RemoveSlave").mock(side_effect=down)
    respx.get(url__regex=r"http://172\.16\.10\.174:11000/Sync\?.*").mock(side_effect=down)
    respx.get(f"http://{slave}/RemoveSlave").mock(
        return_value=httpx.Response(200, content=err)
    )
    respx.get(url__regex=r"http://172\.16\.10\.166:11000/Sync\?.*").mock(
        return_value=httpx.Response(200, content=err)
    )

    # Donor1: AddSlave ok, RemoveSlave never verifies as ungrouped.
    respx.get(f"http://{donor1}/AddSlave").mock(
        return_value=httpx.Response(
            200,
            content=b'<addSlave><slave id="172.16.10.166" port="11000"/></addSlave>',
        )
    )
    respx.get(f"http://{donor1}/RemoveSlave").mock(
        return_value=httpx.Response(200, content=err)
    )
    respx.get(url__regex=r"http://172\.16\.10\.144:11000/Sync\?.*").mock(
        return_value=httpx.Response(200, content=err)
    )

    # Donor2 succeeds.
    respx.get(f"http://{donor2}/AddSlave").mock(
        return_value=httpx.Response(
            200,
            content=b'<addSlave><slave id="172.16.10.166" port="11000"/></addSlave>',
        )
    )
    respx.get(f"http://{donor2}/RemoveSlave").mock(
        return_value=httpx.Response(200, content=b"<SyncStatus/>")
    )
    respx.get(f"http://{slave}/SyncStatus").mock(
        return_value=httpx.Response(
            200,
            content=b"<SyncStatus id='172.16.10.166:11000' name='Roaming'/>",
        )
    )

    client = BluOSClient(settings)
    client._ungroup_verify_attempts = 1
    client._ungroup_verify_delay = 0
    try:
        ok = await client.remove_sync_slave(
            dead_master,
            slave,
            donor_endpoints=[donor1, donor2],
        )
        assert ok is True
        urls = [str(c.request.url) for c in respx.calls]
        assert any("/AddSlave" in u and "172.16.10.144" in u for u in urls)
        assert any("/AddSlave" in u and "172.16.10.150" in u for u in urls)
        assert any("/RemoveSlave" in u and "172.16.10.150" in u for u in urls)
    finally:
        await client.aclose()
