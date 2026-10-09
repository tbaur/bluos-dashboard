"""Structured logging helpers."""

from __future__ import annotations

import json
import logging

from app.logging import JsonFormatter, configure_logging, request_id_var


def test_json_formatter_includes_extras_and_request_id() -> None:
    token = request_id_var.set("req-42")
    try:
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="hello",
            args=(),
            exc_info=None,
        )
        record.device_id = "player-1"  # type: ignore[attr-defined]
        record.op = "play"  # type: ignore[attr-defined]
        record.succeeded = 2  # type: ignore[attr-defined]
        record.role = "slave"  # type: ignore[attr-defined]
        record.target_count = 3  # type: ignore[attr-defined]
        record.scoped = True  # type: ignore[attr-defined]
        payload = json.loads(JsonFormatter().format(record))
        assert payload["msg"] == "hello"
        assert payload["request_id"] == "req-42"
        assert payload["device_id"] == "player-1"
        assert payload["op"] == "play"
        assert payload["succeeded"] == 2
        assert payload["role"] == "slave"
        assert payload["target_count"] == 3
        assert payload["scoped"] is True
    finally:
        request_id_var.reset(token)


def test_json_formatter_includes_exc_info() -> None:
    try:
        raise ValueError("boom")
    except ValueError:
        record = logging.LogRecord(
            name="test",
            level=logging.ERROR,
            pathname=__file__,
            lineno=1,
            msg="failed",
            args=(),
            exc_info=True,
        )
        # Attach current exception context
        import sys

        record.exc_info = sys.exc_info()
        payload = json.loads(JsonFormatter().format(record))
        assert "ValueError" in payload["exc_info"]


def test_configure_logging_sets_json_handler() -> None:
    configure_logging("DEBUG")
    root = logging.getLogger()
    assert root.level == logging.DEBUG
    assert any(isinstance(h.formatter, JsonFormatter) for h in root.handlers)


def test_get_request_id_helper() -> None:
    from app.api.errors import get_request_id
    from app.logging import request_id_var

    class Req:
        state = type("S", (), {"request_id": "from-state"})()

    assert get_request_id(Req()) == "from-state"  # type: ignore[arg-type]
    token = request_id_var.set("from-ctx")
    try:

        class Bare:
            state = type("S", (), {})()

        assert get_request_id(Bare()) == "from-ctx"  # type: ignore[arg-type]
    finally:
        request_id_var.reset(token)
