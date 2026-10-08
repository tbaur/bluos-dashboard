"""Cross-platform mDNS discovery via python-zeroconf."""

from __future__ import annotations

import logging
import queue
import socket
import threading
import time

from zeroconf import ServiceBrowser, ServiceInfo, ServiceStateChange, Zeroconf

from app.validators import DEFAULT_BLUOS_PORT, format_endpoint, sanitize_ip, validate_bluos_port

logger = logging.getLogger(__name__)

# Primary BluOS players (_musc) + CI secondary zones (_musp), e.g. NAD CI S2.
BLUOS_MDNS_SERVICES = ("_musc._tcp.local.", "_musp._tcp.local.")


class MDNSDiscovery:
    def __init__(
        self,
        service_types: tuple[str, ...] | None = None,
        timeout: float = 5.0,
    ) -> None:
        self.service_types = service_types or BLUOS_MDNS_SERVICES
        self.timeout = timeout

    def discover(self) -> list[str]:
        """Return canonical ``ip:port`` endpoints from SRV records."""
        endpoints: set[str] = set()
        zc = Zeroconf()

        def on_service_state_change(
            zeroconf: Zeroconf,
            service_type: str,
            name: str,
            state_change: ServiceStateChange,
        ) -> None:
            if state_change not in (ServiceStateChange.Added, ServiceStateChange.Updated):
                return
            info = zeroconf.get_service_info(service_type, name, timeout=1000)
            if not info or not info.addresses:
                return
            port = int(info.port) if info.port else DEFAULT_BLUOS_PORT
            if not validate_bluos_port(port):
                port = DEFAULT_BLUOS_PORT
            for raw in info.addresses:
                try:
                    ip = socket.inet_ntoa(raw)
                except OSError:
                    continue
                sanitized = sanitize_ip(ip)
                if sanitized:
                    endpoints.add(format_endpoint(sanitized, port))

        browsers = [
            ServiceBrowser(zc, service_type, handlers=[on_service_state_change])
            for service_type in self.service_types
        ]
        try:
            time.sleep(self.timeout)
        finally:
            for browser in browsers:
                browser.cancel()
            zc.close()
        return sorted(endpoints)


def endpoint_from_service_info(info: ServiceInfo | None) -> str | None:
    """IPv4 SRV target. IPv6 addresses are ignored; BluOS on the LAN is IPv4."""
    if info is None or not info.addresses:
        return None
    port = int(info.port) if info.port else DEFAULT_BLUOS_PORT
    if not validate_bluos_port(port):
        port = DEFAULT_BLUOS_PORT
    for raw in info.addresses:
        try:
            ip = socket.inet_ntoa(raw)
        except OSError:
            continue
        sanitized = sanitize_ip(ip)
        if sanitized:
            return format_endpoint(sanitized, port)
    return None


class StandingMDNS:
    """One browser for the life of the process. Joins and leaves update membership.

    Service info is resolved off the zeroconf callback so a slow lookup cannot
    stall the listener.
    """

    def __init__(self) -> None:
        self._by_name: dict[str, str] = {}
        self._lock = threading.Lock()
        self._queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self._stop = threading.Event()
        self._zc: Zeroconf | None = None
        self._browsers: list[ServiceBrowser] = []
        self._thread: threading.Thread | None = None
        self.running = False

    def start(self) -> None:
        if self.running:
            return
        try:
            self._zc = Zeroconf()
        except Exception:
            logger.exception("mdns_browser_failed")
            self._zc = None
            return
        self.running = True
        self._thread = threading.Thread(target=self._resolve_loop, name="mdns-resolve", daemon=True)
        self._thread.start()
        zc = self._zc
        self._browsers = [
            ServiceBrowser(zc, service_type, handlers=[self._on_change])
            for service_type in BLUOS_MDNS_SERVICES
        ]

    def stop(self) -> None:
        self._stop.set()
        self.running = False
        for browser in self._browsers:
            browser.cancel()
        self._browsers.clear()
        if self._zc is not None:
            self._zc.close()
            self._zc = None
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None

    def endpoints(self) -> list[str]:
        with self._lock:
            return sorted(set(self._by_name.values()))

    def remember(self, name: str, endpoint: str) -> None:
        with self._lock:
            self._by_name[name] = endpoint

    def forget(self, name: str) -> None:
        with self._lock:
            self._by_name.pop(name, None)

    def _on_change(
        self,
        _zeroconf: Zeroconf,
        service_type: str,
        name: str,
        state_change: ServiceStateChange,
    ) -> None:
        if state_change == ServiceStateChange.Removed:
            self.forget(name)
            return
        if state_change in (ServiceStateChange.Added, ServiceStateChange.Updated):
            self._queue.put((service_type, name))

    def _resolve_loop(self) -> None:
        while not self._stop.is_set():
            try:
                service_type, name = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            zc = self._zc
            if zc is None:
                continue
            try:
                info = zc.get_service_info(service_type, name, timeout=1000)
            except Exception:
                logger.debug("mdns_resolve_failed name=%s", name, exc_info=True)
                continue
            endpoint = endpoint_from_service_info(info)
            if endpoint:
                self.remember(name, endpoint)
