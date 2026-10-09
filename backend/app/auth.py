"""API token and session cookie values."""

from __future__ import annotations

import hashlib
import hmac

SESSION_COOKIE = "bsd_session"
_SESSION_LABEL = b"bluos-dashboard session v1"


def session_cookie_value(token: bytes) -> bytes:
    """Cookie value for a session opened with ``token``.

    Derived rather than the token itself, so cookie storage never holds the
    credential. Changing BSD_API_TOKEN invalidates every cookie.
    """
    return hmac.new(token, _SESSION_LABEL, hashlib.sha256).hexdigest().encode("ascii")
