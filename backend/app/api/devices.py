"""Per-player REST endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Response

from app.api.common import (
    StateDep,
    begin_control,
    bluetooth_unsupported_by_model,
    require_device,
    run_control,
)
from app.api.errors import AppError
from app.models import (
    AudioInput,
    BluetoothRequest,
    BluetoothResponse,
    DeviceSettingsResponse,
    DevicesResponse,
    DiagnoseResponse,
    InputRequest,
    MuteRequest,
    PlayerStatus,
    Preset,
    QueueMoveRequest,
    QueueResponse,
    RepeatRequest,
    SeekRequest,
    SettingWriteRequest,
    ShuffleRequest,
    UpgradeStatus,
    VolumeAdjustRequest,
    VolumeRequest,
)
from app.services.sync import build_sync_state

router = APIRouter()

@router.get("/devices", response_model=DevicesResponse)
async def list_devices(state: StateDep) -> DevicesResponse:
    snapshot = state.discovery.snapshot
    return DevicesResponse(
        devices=snapshot.devices,
        discovered_at=snapshot.discovered_at,
        discovery_method=snapshot.method_used,
    )


@router.post("/devices/refresh", response_model=DevicesResponse)
async def refresh_devices(state: StateDep) -> DevicesResponse:
    snapshot = await state.discovery.refresh()
    await state.events.publish(
        "fleet",
        {
            "devices": [d.model_dump() for d in snapshot.devices],
            "discovered_at": snapshot.discovered_at,
            "sync": build_sync_state(snapshot.devices).model_dump(),
        },
    )
    return DevicesResponse(
        devices=snapshot.devices,
        discovered_at=snapshot.discovered_at,
        discovery_method=snapshot.method_used,
    )

@router.get("/devices/{device_id}")
async def get_device(device_id: str, state: StateDep) -> PlayerStatus:
    require_device(state, device_id)
    device = state.discovery.get_device(device_id)
    if device is None:
        # Refresh single if in grace
        refreshed = await state.poller.refresh_one(device_id)
        if refreshed is None:
            raise AppError(404, "device_not_found", "Device not found")
        return refreshed
    return device

@router.post("/devices/{device_id}/play", status_code=204)
async def play(device_id: str, state: StateDep) -> Response:
    return await run_control(state, device_id, "play", state.client.play)


@router.post("/devices/{device_id}/pause", status_code=204)
async def pause(device_id: str, state: StateDep) -> Response:
    return await run_control(state, device_id, "pause", state.client.pause)


@router.post("/devices/{device_id}/stop", status_code=204)
async def stop(device_id: str, state: StateDep) -> Response:
    return await run_control(state, device_id, "stop", state.client.stop)


@router.post("/devices/{device_id}/skip", status_code=204)
async def skip(device_id: str, state: StateDep) -> Response:
    return await run_control(state, device_id, "skip", state.client.skip)


@router.post("/devices/{device_id}/toggle", status_code=204)
async def toggle(device_id: str, state: StateDep) -> Response:
    ip = require_device(state, device_id)
    device = state.discovery.get_device(device_id)
    state_name = device.state if device else "stop"

    async def op(_: str) -> bool:
        return await state.client.toggle(ip, state=state_name)

    return await run_control(state, device_id, "toggle", op)


@router.post("/devices/{device_id}/volume/adjust", status_code=204)
async def volume_adjust(device_id: str, body: VolumeAdjustRequest, state: StateDep) -> Response:
    ip = require_device(state, device_id)
    # Prefer live SyncStatus volume — cached fleet snapshot can lag concurrent nudges.
    await begin_control(state, [device_id])
    live = await state.client.get_player_status(ip, device_id=device_id)
    cached = state.discovery.get_device(device_id)
    if live.status == "online":
        current = live.volume
    elif cached is not None:
        current = cached.volume
    else:
        raise AppError(502, "bluos_status_failed", "Failed to read player volume")

    async def op(_: str) -> bool:
        return await state.client.adjust_volume(ip, body.delta, current)

    return await run_control(state, device_id, "volume_adjust", op)


@router.get("/devices/{device_id}/diagnose", response_model=DiagnoseResponse)
async def diagnose(device_id: str, state: StateDep) -> DiagnoseResponse:
    ip = require_device(state, device_id)
    device = state.discovery.get_device(device_id)
    if device is None:
        refreshed = await state.poller.refresh_one(device_id)
        if refreshed is None:
            raise AppError(404, "device_not_found", "Device not found")
        device = refreshed
    diagnostics = await state.client.get_diagnostics(ip) or {}
    return DiagnoseResponse(
        device_id=device.id,
        ip=device.ip,
        port=device.port,
        name=device.name,
        model=device.model,
        full_model=device.full_model,
        device_class=device.device_class,
        mac=device.mac,
        fw=device.fw,
        state=device.state,
        service=device.service,
        volume=device.volume,
        muted=device.muted,
        db=device.db,
        sync_role=device.sync_role,
        master=device.master,
        group=device.group,
        quality=device.quality,
        stream_format=device.stream_format,
        uptime=diagnostics.get("uptime"),
        network_name=diagnostics.get("network_name"),
        signal_strength=diagnostics.get("signal_strength"),
        total_songs=diagnostics.get("total_songs"),
        web_ip=diagnostics.get("web_ip"),
        web_mac=diagnostics.get("web_mac"),
        web_fw=diagnostics.get("web_fw"),
    )


@router.get("/devices/{device_id}/settings/{page_id}", response_model=DeviceSettingsResponse)
async def get_device_settings(
    device_id: str,
    page_id: Annotated[str, Path(pattern="^(audio|player)$")],
    state: StateDep,
) -> DeviceSettingsResponse:
    ip = require_device(state, device_id)
    result = await state.client.get_device_settings(ip, page_id)
    if result is None:
        raise AppError(502, "bluos_settings_failed", "Failed to read device settings")
    return result


@router.post("/devices/{device_id}/settings", status_code=204)
async def set_device_setting(
    device_id: str, body: SettingWriteRequest, state: StateDep
) -> Response:
    ip = require_device(state, device_id)

    async def op(_: str) -> bool:
        return await state.client.set_device_setting(
            ip, body.id, body.value, control_path=body.control_path
        )

    return await run_control(state, device_id, "setting", op)


@router.get("/devices/{device_id}/upgrade", response_model=UpgradeStatus)
async def device_upgrade(device_id: str, state: StateDep) -> UpgradeStatus:
    ip = require_device(state, device_id)
    device = state.discovery.get_device(device_id)
    return await state.client.get_upgrade_status(
        ip,
        device_id=device_id,
        name=device.name if device else device_id,
        current_fw=device.fw if device else "",
    )


@router.post("/devices/{device_id}/reboot", status_code=204)
async def reboot(device_id: str, state: StateDep) -> Response:
    ip = require_device(state, device_id)

    async def op(_: str) -> bool:
        return await state.client.reboot(ip)

    return await run_control(state, device_id, "reboot", op)

@router.post("/devices/{device_id}/back", status_code=204)
async def back(device_id: str, state: StateDep) -> Response:
    return await run_control(state, device_id, "back", state.client.back)


@router.post("/devices/{device_id}/seek", status_code=204)
async def seek(device_id: str, body: SeekRequest, state: StateDep) -> Response:
    ip = require_device(state, device_id)

    async def op(_: str) -> bool:
        return await state.client.seek(ip, body.seconds)

    return await run_control(state, device_id, "seek", op)


@router.post("/devices/{device_id}/shuffle", status_code=204)
async def shuffle(device_id: str, body: ShuffleRequest, state: StateDep) -> Response:
    ip = require_device(state, device_id)

    async def op(_: str) -> bool:
        return await state.client.set_shuffle(ip, body.state)

    return await run_control(state, device_id, "shuffle", op)


@router.post("/devices/{device_id}/repeat", status_code=204)
async def repeat(device_id: str, body: RepeatRequest, state: StateDep) -> Response:
    ip = require_device(state, device_id)

    async def op(_: str) -> bool:
        return await state.client.set_repeat(ip, body.state)

    return await run_control(state, device_id, "repeat", op)


@router.post("/devices/{device_id}/volume", status_code=204)
async def volume(device_id: str, body: VolumeRequest, state: StateDep) -> Response:
    ip = require_device(state, device_id)

    async def op(_: str) -> bool:
        return await state.client.set_volume(ip, body.level)

    return await run_control(state, device_id, "volume", op)


@router.post("/devices/{device_id}/mute", status_code=204)
async def mute(device_id: str, body: MuteRequest, state: StateDep) -> Response:
    ip = require_device(state, device_id)

    async def op(_: str) -> bool:
        return await state.client.set_mute(ip, body.mute)

    return await run_control(state, device_id, "mute", op)


@router.get("/devices/{device_id}/queue")
async def queue(device_id: str, state: StateDep) -> QueueResponse:
    ip = require_device(state, device_id)
    result = await state.client.get_queue(ip)
    if result is None:
        raise AppError(502, "bluos_queue_failed", "Failed to read queue")
    return result


@router.post("/devices/{device_id}/queue/clear", status_code=204)
async def queue_clear(device_id: str, state: StateDep) -> Response:
    return await run_control(state, device_id, "queue_clear", state.client.clear_queue)


@router.post("/devices/{device_id}/queue/move", status_code=204)
async def queue_move(device_id: str, body: QueueMoveRequest, state: StateDep) -> Response:
    ip = require_device(state, device_id)

    async def op(_: str) -> bool:
        return await state.client.move_queue_item(ip, body.from_index, body.to_index)

    return await run_control(state, device_id, "queue_move", op)


@router.get("/devices/{device_id}/inputs")
async def inputs(device_id: str, state: StateDep) -> list[AudioInput]:
    ip = require_device(state, device_id)
    result = await state.client.get_inputs(ip)
    if result is None:
        raise AppError(502, "bluos_inputs_failed", "Failed to read inputs")
    return result


@router.post("/devices/{device_id}/input", status_code=204)
async def set_input(device_id: str, body: InputRequest, state: StateDep) -> Response:
    ip = require_device(state, device_id)

    async def op(_: str) -> bool:
        return await state.client.set_input(ip, body.input)

    return await run_control(state, device_id, "input", op)


@router.get("/devices/{device_id}/bluetooth")
async def bluetooth(device_id: str, state: StateDep) -> BluetoothResponse:
    ip = require_device(state, device_id)
    if bluetooth_unsupported_by_model(state, device_id):
        return BluetoothResponse(supported=False, mode=None)
    info = await state.client.get_bluetooth_info(ip)
    if info is None:
        # Probe hard-fail → treat as unsupported (matches UI / README soft path).
        return BluetoothResponse(supported=False, mode=None)
    return info


@router.post("/devices/{device_id}/bluetooth", status_code=204)
async def set_bluetooth(device_id: str, body: BluetoothRequest, state: StateDep) -> Response:
    ip = require_device(state, device_id)
    if bluetooth_unsupported_by_model(state, device_id):
        raise AppError(404, "bluetooth_unsupported", "This player does not support Bluetooth")
    await begin_control(state, [device_id])
    info = await state.client.get_bluetooth_info(ip)
    if info is None or not info.supported:
        raise AppError(404, "bluetooth_unsupported", "This player does not support Bluetooth")

    async def op(_: str) -> bool:
        return await state.client.set_bluetooth_mode(ip, body.mode)

    return await run_control(state, device_id, "bluetooth", op)


@router.get("/devices/{device_id}/presets")
async def presets(device_id: str, state: StateDep) -> list[Preset]:
    ip = require_device(state, device_id)
    result = await state.client.get_presets(ip)
    if result is None:
        raise AppError(502, "bluos_presets_failed", "Failed to read presets")
    return result


@router.post("/devices/{device_id}/presets/{preset_id}/play", status_code=204)
async def play_preset(
    device_id: str,
    preset_id: Annotated[int, Path(ge=1, le=10_000)],
    state: StateDep,
) -> Response:
    ip = require_device(state, device_id)

    async def op(_: str) -> bool:
        return await state.client.play_preset(ip, preset_id)

    return await run_control(state, device_id, "preset", op)
