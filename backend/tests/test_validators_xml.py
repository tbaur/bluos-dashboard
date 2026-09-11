from app.bluos.xml import attr, safe_parse_xml, text
from app.config import Settings
from app.validators import (
    format_endpoint,
    make_device_id,
    normalize_bluos_mac,
    parse_endpoint,
    sanitize_endpoint,
    sanitize_ip,
    validate_device_id,
)


def test_sanitize_ip_accepts_valid() -> None:
    assert sanitize_ip("192.168.1.10") == "192.168.1.10"


def test_sanitize_ip_rejects_path_injection() -> None:
    assert sanitize_ip("192.168.1.10/Status") is None
    assert sanitize_ip("127.0.0.1\n") is None


def test_device_id_validation() -> None:
    assert validate_device_id("player-abc123")
    assert not validate_device_id("../etc/passwd")
    assert not validate_device_id("a/b")


def test_make_device_id_stable() -> None:
    a = make_device_id("192.168.1.10", name="Kitchen")
    b = make_device_id("192.168.1.10", name="Kitchen")
    assert a == b
    assert a.startswith("player-")


def test_make_device_id_includes_port() -> None:
    primary = make_device_id("192.168.1.10", name="Zone", port=11000)
    secondary = make_device_id("192.168.1.10", name="Zone", port=11010)
    assert primary != secondary


def test_parse_endpoint_bare_and_ported() -> None:
    assert parse_endpoint("192.168.1.1") == ("192.168.1.1", 11000)
    assert parse_endpoint("192.168.1.1:11010") == ("192.168.1.1", 11010)
    assert sanitize_endpoint("192.168.1.1:11010") == "192.168.1.1:11010"
    assert format_endpoint("192.168.1.1", 11010) == "192.168.1.1:11010"


def test_make_device_id_prefers_node_id() -> None:
    assert make_device_id("192.168.1.10", node_id="node-ABC") == "node-ABC"


def test_safe_parse_xml_rejects_too_deep() -> None:
    settings = Settings(max_xml_depth=2, max_xml_elements=100)
    xml = b"<a><b><c><d>x</d></c></b></a>"
    assert safe_parse_xml(xml, settings, "test") is None


def test_safe_parse_xml_accepts_normal() -> None:
    settings = Settings()
    root = safe_parse_xml(b"<status><state>play</state></status>", settings, "test")
    assert root is not None
    assert root.findtext("state") == "play"


def test_safe_parse_xml_rejects_empty_and_invalid() -> None:
    settings = Settings()
    assert safe_parse_xml(b"", settings) is None
    assert safe_parse_xml(b"   ", settings) is None
    assert safe_parse_xml(b"<not-xml", settings) is None


def test_safe_parse_xml_rejects_too_large() -> None:
    settings = Settings(max_xml_size=1024)
    assert safe_parse_xml(b"<root>" + (b"x" * 1100) + b"</root>", settings) is None


def test_safe_parse_xml_rejects_too_many_elements() -> None:
    settings = Settings(max_xml_elements=100)
    kids = b"".join(b"<n/>" for _ in range(120))
    assert safe_parse_xml(b"<a>" + kids + b"</a>", settings) is None


def test_safe_parse_xml_rejects_entity_expansion() -> None:
    """Billion laughs must not expand. Needs libexpat >= 2.4.0 (see bluos/xml.py)."""
    bomb = (
        b'<?xml version="1.0"?><!DOCTYPE lolz [\n'
        b'<!ENTITY lol "lol">\n'
        b'<!ENTITY lol1 "' + b"&lol;" * 10 + b'">\n'
        b'<!ENTITY lol2 "' + b"&lol1;" * 10 + b'">\n'
        b'<!ENTITY lol3 "' + b"&lol2;" * 10 + b'">\n'
        b'<!ENTITY lol4 "' + b"&lol3;" * 10 + b'">\n'
        b'<!ENTITY lol5 "' + b"&lol4;" * 10 + b'">\n'
        b'<!ENTITY lol6 "' + b"&lol5;" * 10 + b'">\n'
        b'<!ENTITY lol7 "' + b"&lol6;" * 10 + b'">\n'
        b"]><lolz>&lol7;</lolz>"
    )
    assert safe_parse_xml(bomb, Settings()) is None


def test_safe_parse_xml_rejects_quadratic_blowup() -> None:
    payload = (
        b'<?xml version="1.0"?><!DOCTYPE b [<!ENTITY a "'
        + b"A" * 50_000
        + b'">]><b>'
        + b"&a;" * 2_000
        + b"</b>"
    )
    assert safe_parse_xml(payload, Settings(max_xml_size=10_485_760)) is None


def test_safe_parse_xml_rejects_deep_nesting() -> None:
    settings = Settings(max_xml_depth=10)
    deep = b"<a>" * 40 + b"x" + b"</a>" * 40
    assert safe_parse_xml(deep, settings) is None


def test_text_and_attr_helpers() -> None:
    settings = Settings()
    root = safe_parse_xml(b'<status vol="9"><state>play</state></status>', settings)
    assert root is not None
    assert text(root, "state") == "play"
    assert text(root, "missing", "fallback") == "fallback"
    assert text(None, "state", "x") == "x"
    assert attr(root, "vol") == "9"
    assert attr(None, "vol", "0") == "0"


def test_normalize_bluos_mac_strips_ci_zone_port() -> None:
    assert normalize_bluos_mac("90:56:82:16:61:B7:11010") == "90:56:82:16:61:B7"
    assert normalize_bluos_mac("90:56:82:16:61:b7") == "90:56:82:16:61:B7"
    assert normalize_bluos_mac("") == ""
    assert normalize_bluos_mac("not-a-mac") == "not-a-mac"
