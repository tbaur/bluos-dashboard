"""XXE/DoS-hardened XML parsing for BluOS responses.

Entity-expansion attacks (billion laughs, quadratic blowup) are rejected by
libexpat's own amplification limit, which needs libexpat >= 2.4.0. The caps
below run after the parse and bound tree *shape*, not expansion, so
``test_validators_xml`` pins the expat behaviour rather than trusting it
silently. ElementTree never resolves external entities, so XXE is not reachable.
"""

from __future__ import annotations

import logging
import xml.etree.ElementTree as ET

from app.config import Settings

logger = logging.getLogger(__name__)


def safe_parse_xml(xml_data: bytes, settings: Settings, context: str = "") -> ET.Element | None:
    if not xml_data or not xml_data.strip():
        return None
    if len(xml_data) > settings.max_xml_size:
        logger.warning("xml_too_large", extra={"device_ip": context, "outcome": "reject"})
        return None
    try:
        root = ET.fromstring(xml_data)
    except ET.ParseError:
        logger.debug("xml_parse_error context=%s", context)
        return None
    except RecursionError:
        logger.warning("xml_recursion context=%s", context)
        return None

    element_count = 0

    def walk(elem: ET.Element, depth: int) -> bool:
        nonlocal element_count
        if depth > settings.max_xml_depth:
            return False
        element_count += 1
        if element_count > settings.max_xml_elements:
            return False
        if len(elem.attrib) > 200:
            return False
        for child in elem:
            if not walk(child, depth + 1):
                return False
        return True

    if not walk(root, 0):
        logger.warning("xml_structure_invalid context=%s", context)
        return None
    return root


def text(elem: ET.Element | None, tag: str, default: str = "") -> str:
    if elem is None:
        return default
    value = elem.findtext(tag)
    return (value or default).strip()


def attr(elem: ET.Element | None, name: str, default: str = "") -> str:
    if elem is None:
        return default
    return (elem.attrib.get(name) or default).strip()
