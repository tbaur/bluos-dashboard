"""LSDP packet parsing and discover() against a fake socket and clock."""

from __future__ import annotations

import ctypes
import errno
import ipaddress
import socket
import struct
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.discovery import lsdp
from app.discovery.lsdp import (
    CLASS_BLUOS_PLAYER,
    CLASS_BLUOS_PLAYER_SECONDARY,
    LSDP_MAGIC,
    LSDP_VERSION,
    MSG_ANNOUNCE,
    LSDPDiscovery,
)

HEADER = struct.pack("!B", 6) + LSDP_MAGIC + struct.pack("!B", LSDP_VERSION)
BROADCAST = "192.0.2.255"
CHASSIS = bytes.fromhex("0200000000a1")
# Same text as CHASSIS once bytes >= 0x80 are dropped by a lossy decode.
OTHER_CHASSIS = bytes.fromhex("0200000000b2")

Record = tuple[int, dict[str, str]]


def _announce(
    node_id: str | bytes,
    ip: str,
    *records: Record,
    embed_ip: bool = True,
) -> bytes:
    node = node_id if isinstance(node_id, bytes) else node_id.encode()
    address = socket.inet_aton(ip) if embed_ip else b""
    body = bytearray([0, MSG_ANNOUNCE, len(node), *node, len(address), *address])
    entries = records or ((CLASS_BLUOS_PLAYER, {}),)
    body.append(len(entries))
    for class_id, txt in entries:
        body.extend(struct.pack("!HB", class_id, len(txt)))
        for key, value in txt.items():
            for part in (key.encode(), value.encode()):
                body.append(len(part))
                body.extend(part)
    body[0] = len(body)
    return HEADER + bytes(body)


def _cut_tail(packet: bytes, size: int) -> bytes:
    """Drop the last bytes of the only message and shrink its length byte to match."""
    cut = bytearray(packet[:-size])
    cut[len(HEADER)] -= size
    return bytes(cut)


def _ports(*ports: str) -> list[Record]:
    classes = (CLASS_BLUOS_PLAYER, CLASS_BLUOS_PLAYER_SECONDARY)
    return [(cls, {"port": port}) for cls, port in zip(classes, ports, strict=False)]


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


@dataclass
class FakeSocket:
    """Each recvfrom returns or raises the next event. With none left it times out."""

    events: list[bytes | Exception]
    clock: FakeClock
    source_ip: str = "192.168.1.70"
    bind_error: OSError | None = None
    send_error: OSError | None = None
    bound: tuple[str, int] | None = None
    sent: list[tuple[str, int]] = field(default_factory=list)
    closed: bool = False
    _timeout: float = 0.0

    def setsockopt(self, *_args: object) -> None:
        return None

    def bind(self, address: tuple[str, int]) -> None:
        if self.bind_error:
            raise self.bind_error
        self.bound = address

    def sendto(self, _packet: bytes, destination: tuple[str, int]) -> int:
        if self.send_error:
            raise self.send_error
        self.sent.append(destination)
        return 1

    def settimeout(self, timeout: float) -> None:
        self._timeout = timeout

    def recvfrom(self, _size: int) -> tuple[bytes, tuple[str, int]]:
        if not self.events:
            self.clock.now += self._timeout
            raise TimeoutError
        event = self.events.pop(0)
        if isinstance(event, Exception):
            raise event
        return event, (self.source_ip, lsdp.LSDP_PORT)

    def close(self) -> None:
        self.closed = True


FakeNetwork = Callable[..., FakeSocket]


@pytest.fixture
def fake_network(monkeypatch: pytest.MonkeyPatch) -> FakeNetwork:
    clock = FakeClock()
    monkeypatch.setattr(lsdp, "time", SimpleNamespace(monotonic=clock))
    monkeypatch.setattr(lsdp, "ipv4_broadcast_addresses", lambda: [BROADCAST])

    def install(events: list[bytes | Exception] | None = None, **options: object) -> FakeSocket:
        sock = FakeSocket(list(events or []), clock, **options)
        monkeypatch.setattr(lsdp.socket, "socket", lambda *_a, **_k: sock)
        return sock

    return install


def test_parse_announce_keeps_node_id_as_hex() -> None:
    discovery = LSDPDiscovery()
    discovery._parse_packet(_announce(CHASSIS, "192.168.1.50"), "192.168.1.50")
    [device] = discovery.discovered_devices.values()
    assert (device.node_id, device.ip, device.port) == ("0200000000a1", "192.168.1.50", None)


def test_parse_announce_reads_every_record_in_one_message() -> None:
    discovery = LSDPDiscovery()
    discovery._parse_packet(_announce(CHASSIS, "192.168.1.70", *_ports("11000", "11010")), "x")
    ports = sorted(d.port or 0 for d in discovery.discovered_devices.values())
    assert ports == [11000, 11010]


def test_parse_announce_falls_back_to_source_ip() -> None:
    discovery = LSDPDiscovery()
    packet = _announce("hub", "0.0.0.0", (8, {"name": "Patio"}), embed_ip=False)
    discovery._parse_packet(packet, "10.0.0.7")
    [device] = discovery.discovered_devices.values()
    assert (device.ip, device.class_id, device.txt_records) == ("10.0.0.7", 8, {"name": "Patio"})


@pytest.mark.parametrize(
    "packet",
    [
        b"short",
        b"\x06XXXX\x01",
        HEADER[:5] + b"\x63",
        HEADER + b"\xff\x41",
        HEADER + b"\x00\x41",
        b"\x00" + LSDP_MAGIC + struct.pack("!B", LSDP_VERSION),
        _cut_tail(_announce("node", "192.168.1.1", (1, {"port": "11000"})), 3),
        _cut_tail(_announce("node", "192.168.1.1"), 3),
    ],
    ids=[
        "short",
        "bad-magic",
        "bad-version",
        "length-past-end",
        "zero-length-message",
        "zero-length-header",
        "truncated-txt",
        "truncated-record",
    ],
)
def test_parse_packet_ignores_malformed_input(packet: bytes) -> None:
    discovery = LSDPDiscovery()
    discovery._parse_packet(packet, "192.168.1.1")
    assert discovery.discovered_devices == {}


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("11010", 11010),
        ("", None),
        ("abc", None),
        ("80", None),
        ("\u0661\u0661\u0660\u0660\u0660", None),
    ],
    ids=["zone", "empty", "text", "below-1024", "non-ascii-digits"],
)
def test_announced_port(raw: str, expected: int | None) -> None:
    assert lsdp._announced_port({"port": raw}) == expected


def test_default_query_asks_for_players_zones_and_hubs() -> None:
    packet = LSDPDiscovery()._build_query_packet(list(lsdp.QUERIED_CLASSES))
    assert packet == HEADER + bytes.fromhex("09 51 03 0001 0003 0008")


def test_discover_binds_lsdp_port_and_sends_every_query(fake_network: FakeNetwork) -> None:
    sock = fake_network()
    assert LSDPDiscovery(timeout=5.0).discover() == []
    assert sock.bound == ("0.0.0.0", lsdp.LSDP_PORT)
    assert sock.sent == [(BROADCAST, lsdp.LSDP_PORT)] * len(lsdp._QUERY_OFFSETS)
    assert sock.closed


def test_discover_sends_only_queries_inside_the_window(fake_network: FakeNetwork) -> None:
    sock = fake_network()
    LSDPDiscovery(timeout=0.5).discover()
    assert len(sock.sent) == 3


def test_discover_falls_back_to_broadcast_without_interfaces(
    fake_network: FakeNetwork,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sock = fake_network()
    monkeypatch.setattr(lsdp, "ipv4_broadcast_addresses", lambda: [])
    LSDPDiscovery(timeout=0.1).discover()
    assert sock.sent == [("<broadcast>", lsdp.LSDP_PORT)]


def test_discover_keeps_each_zone_port(fake_network: FakeNetwork) -> None:
    fake_network(
        [
            _announce(CHASSIS, "192.168.1.70", *_ports("11000")),
            _announce(CHASSIS, "192.168.1.70", (CLASS_BLUOS_PLAYER_SECONDARY, {"port": "11010"})),
            _announce("other", "192.168.1.70", (CLASS_BLUOS_PLAYER_SECONDARY, {"name": "x"})),
        ]
    )
    devices = LSDPDiscovery().discover()
    assert [(d.port, d.class_id) for d in devices] == [
        (11000, CLASS_BLUOS_PLAYER),
        (11010, CLASS_BLUOS_PLAYER_SECONDARY),
    ]


def test_discover_keeps_chassis_whose_mac_differs_only_in_high_bytes(
    fake_network: FakeNetwork,
) -> None:
    fake_network(
        [
            _announce(CHASSIS, "192.168.1.70", *_ports("11000", "11010")),
            _announce(OTHER_CHASSIS, "192.168.1.71", *_ports("11000", "11010")),
        ]
    )
    devices = LSDPDiscovery().discover()
    assert [(d.ip, d.port, d.node_id) for d in devices] == [
        ("192.168.1.70", 11000, "0200000000a1"),
        ("192.168.1.70", 11010, "0200000000a1"),
        ("192.168.1.71", 11000, "0200000000b2"),
        ("192.168.1.71", 11010, "0200000000b2"),
    ]


def test_discover_ignores_classes_it_did_not_query(fake_network: FakeNetwork) -> None:
    fake_network(
        [
            _announce("lab", "192.168.1.70", (0x0004, {"port": "11431"})),
            _announce("pair", "192.168.1.72", (0x0006, {"port": "11000"})),
            _announce("node", "192.168.1.71", (CLASS_BLUOS_PLAYER, {"port": "11000"})),
        ]
    )
    devices = LSDPDiscovery().discover()
    assert [(d.ip, d.class_id) for d in devices] == [("192.168.1.71", CLASS_BLUOS_PLAYER)]


def test_discover_keeps_one_device_per_endpoint(fake_network: FakeNetwork) -> None:
    sock = fake_network(
        [_announce("a", "192.168.1.70"), _announce("b", "192.168.1.70")],
        send_error=OSError("send failed"),
    )
    devices = LSDPDiscovery().discover()
    assert [(d.ip, d.node_id) for d in devices] == [("192.168.1.70", b"a".hex())]
    assert sock.sent == []


def test_discover_keeps_listening_after_refused_broadcast(fake_network: FakeNetwork) -> None:
    fake_network(
        [
            ConnectionRefusedError(errno.ECONNREFUSED, "refused"),
            _announce("node", "192.168.1.71", (CLASS_BLUOS_PLAYER, {"port": "11000"})),
        ]
    )
    assert [d.port for d in LSDPDiscovery().discover()] == [11000]


def test_discover_stops_on_recv_error(fake_network: FakeNetwork) -> None:
    sock = fake_network([OSError("recv failed"), _announce("late", "192.168.1.71")])
    assert LSDPDiscovery().discover() == []
    assert sock.closed


def test_discover_closes_socket_when_bind_fails(fake_network: FakeNetwork) -> None:
    sock = fake_network(bind_error=OSError(errno.EADDRINUSE, "in use"))
    assert LSDPDiscovery().discover() == []
    assert sock.closed and sock.sent == []


def test_discover_socket_create_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lsdp.socket, "socket", MagicMock(side_effect=OSError("no udp")))
    assert LSDPDiscovery(timeout=0.05).discover() == []


def test_addressable_devices_skip_unusable_ip() -> None:
    discovery = LSDPDiscovery()
    discovery._parse_packet(_announce("node", "0.0.0.0", embed_ip=False), "not-an-ip")
    assert discovery.discovered_devices
    assert discovery._addressable_devices() == []


def _sockaddr_in(ip: str, family: int = socket.AF_INET) -> ctypes.Array[ctypes.c_char]:
    raw = bytearray(16)
    if sys.platform == "darwin":
        raw[0], raw[1] = 16, family
    else:
        struct.pack_into("=H", raw, 0, family)
    raw[4:8] = socket.inet_aton(ip)
    return ctypes.create_string_buffer(bytes(raw), len(raw))


def test_ipv4_at_reads_sockaddr() -> None:
    assert lsdp._ipv4_at(ctypes.addressof(_sockaddr_in("192.168.1.255"))) == "192.168.1.255"
    assert lsdp._ipv4_at(ctypes.addressof(_sockaddr_in("127.0.0.1"))) is None
    assert lsdp._ipv4_at(ctypes.addressof(_sockaddr_in("10.0.0.1", socket.AF_INET6))) is None
    assert lsdp._ipv4_at(None) is None


def test_ipv4_broadcast_addresses_returns_ipv4() -> None:
    for address in lsdp.ipv4_broadcast_addresses():
        assert isinstance(ipaddress.ip_address(address), ipaddress.IPv4Address)


def test_ipv4_broadcast_addresses_without_libc(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lsdp.ctypes.util, "find_library", lambda _name: None)
    assert lsdp.ipv4_broadcast_addresses() == []


def test_ipv4_broadcast_addresses_when_libc_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lsdp.ctypes, "CDLL", MagicMock(side_effect=OSError("no libc")))
    assert lsdp.ipv4_broadcast_addresses() == []
