"""Outcome of one BluOS or web-UI call, including why it failed."""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass

from app.bluos.xml import safe_parse_xml
from app.config import Settings

# Set by control calls so the API log can name the failure without changing
# every ``bool`` return. Concurrent fleet actions each run in their own task,
# which gets its own context copy.
_last_control_result: ContextVar[CallResult | None] = ContextVar(
    "bluos_last_control_result",
    default=None,
)

_DETAIL_LIMIT = 200


@dataclass(frozen=True)
class CallResult:
    """Transport and BluOS-document outcome for one control call."""

    ok: bool
    kind: str = ""
    detail: str = ""
    body: bytes | None = None

    def __bool__(self) -> bool:
        return self.ok

    @classmethod
    def success(cls, body: bytes | None = None) -> CallResult:
        return cls(True, body=body)

    @classmethod
    def failure(cls, kind: str, detail: str = "") -> CallResult:
        text = " ".join(detail.split())
        if len(text) > _DETAIL_LIMIT:
            text = text[:_DETAIL_LIMIT]
        return cls(False, kind, text)


def note_control_result(result: CallResult) -> None:
    _last_control_result.set(result)


def take_control_result() -> CallResult | None:
    """Return the result recorded in this task, then clear it."""
    result = _last_control_result.get()
    _last_control_result.set(None)
    return result


def _error_text(root: object) -> str:
    # ElementTree nodes. Imported lazily in the type sense: root is ET.Element.
    text = (getattr(root, "text", None) or "").strip()
    if text:
        return text
    find = getattr(root, "find", None)
    if find is None:
        return ""
    nested = find("error")
    if nested is None or not (nested.text or "").strip():
        return ""
    return nested.text.strip()


def classify_control_body(
    content: bytes | None,
    settings: Settings,
    context: str,
    *,
    allow_plain: bool = False,
    empty_ok: bool = False,
) -> CallResult:
    """Decide whether a transport-success body is a BluOS success.

    XML error documents are failures. Plain text such as ``ok`` is a success
    only for the device web UI, which does not always speak XML. An empty HTTP
    200 is a normal control acknowledgement when ``empty_ok`` is set. Sync
    status reads leave it off, because an empty document is not a group state.
    """
    if content is None or not content.strip():
        if empty_ok and content is not None:
            return CallResult.success(content)
        return CallResult.failure("empty")
    stripped = content.lstrip()
    if not stripped.startswith(b"<"):
        if allow_plain:
            return CallResult.success()
        return CallResult.failure("bluos_error", "unparsed")
    root = safe_parse_xml(content, settings, context)
    if root is None:
        return CallResult.failure("bluos_error", "unparsed")
    tag = root.tag.lower()
    if tag == "error" or tag.endswith("error") or root.find("error") is not None:
        return CallResult.failure("bluos_error", _error_text(root) or tag)
    return CallResult.success()
