from __future__ import annotations

import signal
import threading
from collections.abc import Iterator
from types import FrameType

import pytest

from app.exit_signals import on_exit_signal


@pytest.fixture
def exit_handlers() -> Iterator[None]:
    saved = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        yield
    finally:
        for sig, handler in saved.items():
            signal.signal(sig, handler)


@pytest.mark.usefixtures("exit_handlers")
def test_callback_runs_before_the_existing_handler_and_restore_undoes_it() -> None:
    calls: list[str] = []

    def server_handler(signum: int, frame: FrameType | None) -> None:
        calls.append(f"server:{signum}")

    signal.signal(signal.SIGINT, server_handler)
    signal.signal(signal.SIGTERM, server_handler)

    restore = on_exit_signal(lambda: calls.append("callback"))
    chained = signal.getsignal(signal.SIGTERM)
    assert callable(chained)
    chained(signal.SIGTERM, None)
    assert calls == ["callback", f"server:{signal.SIGTERM}"]

    restore()
    assert signal.getsignal(signal.SIGINT) is server_handler
    assert signal.getsignal(signal.SIGTERM) is server_handler


@pytest.mark.usefixtures("exit_handlers")
def test_server_handler_still_runs_when_the_callback_fails(
    caplog: pytest.LogCaptureFixture,
) -> None:
    stops: list[int] = []

    def server_handler(signum: int, frame: FrameType | None) -> None:
        stops.append(signum)

    def broken() -> None:
        raise RuntimeError("event loop is closed")

    signal.signal(signal.SIGTERM, server_handler)
    restore = on_exit_signal(broken)
    chained = signal.getsignal(signal.SIGTERM)
    assert callable(chained)
    with caplog.at_level("ERROR"):
        chained(signal.SIGTERM, None)
    assert stops == [signal.SIGTERM]
    assert any("exit_signal_callback_failed" in r.message for r in caplog.records)
    restore()


@pytest.mark.usefixtures("exit_handlers")
def test_os_level_handlers_are_left_alone() -> None:
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    restore = on_exit_signal(lambda: None)
    assert signal.getsignal(signal.SIGTERM) is signal.SIG_DFL
    restore()


@pytest.mark.usefixtures("exit_handlers")
def test_off_the_main_thread_it_does_nothing() -> None:
    before = signal.getsignal(signal.SIGINT)
    restores = []
    worker = threading.Thread(target=lambda: restores.append(on_exit_signal(lambda: None)))
    worker.start()
    worker.join()
    assert signal.getsignal(signal.SIGINT) is before
    restores[0]()
