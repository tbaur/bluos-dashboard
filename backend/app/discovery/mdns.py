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
        self._generation: dict[str, int] = {}
        self._retry_after: dict[str, float] = {}
        self._retry_item: dict[str, tuple[str, int]] = {}
        self._retry_attempts: dict[str, int] = {}
        self._lock = threading.Lock()
        self._queue: queue.Queue[tuple[str, str, int]] = queue.Queue()
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
        with self._lock:
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
        zeroconf: Zeroconf,
        service_type: str,
        name: str,
        state_change: ServiceStateChange,
    ) -> None:
        # Zeroconf calls this with keyword arguments. The first parameter has
        # to be named zeroconf or every browse dies with TypeError.
        del zeroconf
        if state_change == ServiceStateChange.Removed:
            self._bump(name)
            self.forget(name)
            return
        if state_change in (ServiceStateChange.Added, ServiceStateChange.Updated):
            with self._lock:
                generation = self._generation.get(name, 0)
            self._queue.put((service_type, name, generation))

    def _bump(self, name: str) -> None:
        with self._lock:
            self._generation[name] = self._generation.get(name, 0) + 1
            self._clear_retry(name)

    def _clear_retry(self, name: str) -> None:
        self._retry_after.pop(name, None)
        self._retry_item.pop(name, None)
        self._retry_attempts.pop(name, None)

    def _note_retry(self, service_type: str, name: str, generation: int) -> None:
        """Queue another lookup. Zeroconf does not repeat Added after a miss."""
        with self._lock:
            if not self.running or self._generation.get(name, 0) != generation:
                return
            attempts = self._retry_attempts.get(name, 0) + 1
            self._retry_attempts[name] = attempts
            delay = min(30.0, float(attempts))
            self._retry_after[name] = time.monotonic() + delay
            self._retry_item[name] = (service_type, generation)

    def _due_retries(self) -> list[tuple[str, str, int]]:
        now = time.monotonic()
        due: list[tuple[str, str, int]] = []
        with self._lock:
            ready = [name for name, when in self._retry_after.items() if when <= now]
            for name in ready:
                self._retry_after.pop(name, None)
                item = self._retry_item.pop(name, None)
                if item is None or not self.running:
                    continue
                service_type, generation = item
                if self._generation.get(name, 0) != generation:
                    self._retry_attempts.pop(name, None)
                    continue
                due.append((service_type, name, generation))
        return due

    def _apply_resolved(self, name: str, endpoint: str, generation: int) -> None:
        """Ignore a lookup that finished after the service left."""
        with self._lock:
            if not self.running or self._generation.get(name, 0) != generation:
                return
            self._clear_retry(name)
            self._by_name[name] = endpoint

    def _resolve_loop(self) -> None:
        while not self._stop.is_set():
            for service_type, name, generation in self._due_retries():
                self._queue.put((service_type, name, generation))
            try:
                service_type, name, generation = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            zc = self._zc
            if zc is None or not self.running:
                continue
            try:
                info = zc.get_service_info(service_type, name, timeout=1000)
            except Exception:
                logger.debug("mdns_resolve_failed name=%s", name, exc_info=True)
                self._note_retry(service_type, name, generation)
                continue
            endpoint = endpoint_from_service_info(info)
            if endpoint:
                self._apply_resolved(name, endpoint, generation)
            else:
                self._note_retry(service_type, name, generation)
