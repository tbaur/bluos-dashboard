"""Stopping the real server while an SSE stream is open (uvicorn's own signal handling)."""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

BACKEND = Path(__file__).resolve().parents[1]
START_TIMEOUT_S = 20.0
STOP_TIMEOUT_S = 5.0

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture
def server() -> Iterator[tuple[subprocess.Popen[bytes], str]]:
    port = _free_port()
    env = {
        **os.environ,
        "BSD_HOST": "127.0.0.1",
        "BSD_PORT": str(port),
        "BSD_DISCOVERY_METHOD": "lsdp",
        "BSD_DISCOVERY_TIMEOUT": "1",
        "BSD_LOG_LEVEL": "WARNING",
        "BSD_API_TOKEN": "",
    }
    command = [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1"]
    proc = subprocess.Popen(
        [*command, "--port", str(port)],
        cwd=BACKEND,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + START_TIMEOUT_S
        while time.monotonic() < deadline:
            try:
                if httpx.get(f"{base}/api/v1/healthz", timeout=1).status_code == 200:
                    break
            except httpx.TransportError:
                pass
            if proc.poll() is not None:
                pytest.fail("server exited during startup")
            time.sleep(0.2)
        else:
            pytest.fail("server did not become healthy")
        yield proc, base
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT])
def test_server_stops_while_an_sse_stream_is_open(
    server: tuple[subprocess.Popen[bytes], str], sig: signal.Signals
) -> None:
    proc, base = server
    with httpx.stream("GET", f"{base}/api/v1/events", timeout=10) as stream:
        # Keep the iterator referenced: a discarded one closes the connection.
        lines = stream.iter_lines()
        assert next(lines).startswith("data:")
        proc.send_signal(sig)
        try:
            proc.wait(timeout=STOP_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            pytest.fail(f"server still running {STOP_TIMEOUT_S}s after {sig.name}")
    assert proc.returncode is not None
