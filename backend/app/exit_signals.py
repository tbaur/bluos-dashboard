"""Hear the server's stop signals so long-lived responses can end first."""

from __future__ import annotations

import signal
import threading
from collections.abc import Callable
from types import FrameType

SignalHandler = Callable[[int, FrameType | None], object]

_EXIT_SIGNALS = (signal.SIGINT, signal.SIGTERM)


def on_exit_signal(callback: Callable[[], object]) -> Callable[[], None]:
    """Run ``callback`` ahead of the current SIGINT/SIGTERM handlers. Returns an undo.

    Uvicorn waits for every open response to finish before lifespan shutdown and
    never tells the app that it is stopping. An SSE stream does not finish by
    itself, so one open browser tab would hold the process up indefinitely.

    Only Python-level handlers (uvicorn's, or the default SIGINT handler) are
    chained. Signals can only be handled on the main thread; elsewhere this does
    nothing.
    """
    if threading.current_thread() is not threading.main_thread():
        return lambda: None
    replaced: dict[int, SignalHandler] = {}
    for sig in _EXIT_SIGNALS:
        current = signal.getsignal(sig)
        if not callable(current):
            continue
        signal.signal(sig, _chain(callback, current))
        replaced[sig] = current

    def restore() -> None:
        for sig, handler in replaced.items():
            signal.signal(sig, handler)

    return restore


def _chain(callback: Callable[[], object], handler: SignalHandler) -> SignalHandler:
    def chained(signum: int, frame: FrameType | None) -> None:
        callback()
        handler(signum, frame)

    return chained
