"""Multi-room sync add/remove and orphan reparent-ungroup."""

from __future__ import annotations

import asyncio
import logging

from app.bluos.result import classify_control_body
from app.bluos.status import BluOSStatusMixin
from app.validators import format_endpoint

logger = logging.getLogger(__name__)


class BluOSSyncMixin(BluOSStatusMixin):
    # Orphan ungroup verification (BluOS may need a short settle after RemoveSlave).
    _ungroup_verify_attempts = 6
    _ungroup_verify_delay = 0.25

    def _bluos_response_ok(self, content: bytes | None, context: str = "") -> bool:
        """True when BluOS returned a non-error XML body (structure-capped parse)."""
        return classify_control_body(
            content,
            self.settings,
            context or "bluos",
        ).ok

    async def player_is_ungrouped(self, endpoint: str) -> bool | None:
        """Return True if standalone, False if still has a master, None if unreachable."""
        resolved = self._resolve_target(endpoint)
        if not resolved:
            return None
        ep = format_endpoint(*resolved)
        raw = await self._get(ep, "/SyncStatus")
        if not self._bluos_response_ok(raw, ep):
            return None
        assert raw is not None
        sync = self._parse_sync(raw, ep)
        return not bool(sync.get("master"))

    async def _wait_until_ungrouped(self, slave_ep: str) -> bool:
        attempts = max(1, self._ungroup_verify_attempts)
        delay = max(0.0, self._ungroup_verify_delay)
        for _ in range(attempts):
            state = await self.player_is_ungrouped(slave_ep)
            if state is True:
                return True
            if delay:
                await asyncio.sleep(delay)
        return (await self.player_is_ungrouped(slave_ep)) is True

    async def _ungroup_via_reparent(
        self,
        slave_ep: str,
        donor_endpoints: list[str],
    ) -> bool:
        """Clear orphaned ``master reconnecting`` by briefly attaching to a live donor."""
        slave = self._resolve_target(slave_ep)
        if not slave:
            return False
        slave_host, slave_port = slave
        slave_ep = format_endpoint(slave_host, slave_port)
        remove_query = f"slave={slave_host}&port={slave_port}"
        legacy_query = f"remove={slave_host}"

        for donor in donor_endpoints:
            donor_resolved = self._resolve_target(donor)
            if not donor_resolved:
                continue
            donor_ep = format_endpoint(*donor_resolved)
            if donor_ep == slave_ep:
                continue
            if not await self.add_sync_slave(donor_ep, slave_ep):
                continue
            for _ in range(3):
                res = await self._get(
                    donor_ep,
                    "/RemoveSlave",
                    query=remove_query,
                    control=True,
                )
                if self._bluos_response_ok(res, donor_ep) and await self._wait_until_ungrouped(
                    slave_ep
                ):
                    return True
            logger.error(
                "reparent_ungroup_failed slave=%s donor=%s",
                slave_ep,
                donor_ep,
            )
            # Best-effort leave this donor, verify clear, then try the next.
            await self._get(donor_ep, "/RemoveSlave", query=remove_query, control=True)
            await self._get(donor_ep, "/Sync", query=legacy_query, control=True)
            await self._wait_until_ungrouped(slave_ep)
            continue
        return False

    async def add_sync_slave(self, master_target: str, slave_target: str) -> bool:
        master = self._resolve_target(master_target)
        slave = self._resolve_target(slave_target)
        if not master or not slave:
            return False
        master_ip, master_port = master
        slave_ip, slave_port = slave
        master_ep = format_endpoint(master_ip, master_port)
        ok = await self._get(
            master_ep,
            "/AddSlave",
            query=f"slave={slave_ip}&port={slave_port}",
            control=True,
        )
        if self._bluos_response_ok(ok, master_ep):
            return True
        legacy = await self._get(master_ep, "/Sync", query=f"slave={slave_ip}", control=True)
        return self._bluos_response_ok(legacy, master_ep)

    async def remove_sync_slave(
        self,
        master_target: str,
        slave_target: str,
        *,
        donor_endpoints: list[str] | None = None,
    ) -> bool:
        """Remove slave from a sync group.

        Prefer ``RemoveSlave`` on the primary. If the primary is offline (orphaned
        reconnecting group), try the slave, then reparent onto a live donor and remove.
        """
        master = self._resolve_target(master_target)
        slave = self._resolve_target(slave_target)
        if not master or not slave:
            return False
        master_ip, master_port = master
        slave_ip, slave_port = slave
        master_ep = format_endpoint(master_ip, master_port)
        slave_ep = format_endpoint(slave_ip, slave_port)
        remove_query = f"slave={slave_ip}&port={slave_port}"
        legacy_query = f"remove={slave_ip}"

        async def _try_remove(on_ep: str) -> bool:
            for path, query in (("/RemoveSlave", remove_query), ("/Sync", legacy_query)):
                res = await self._get(on_ep, path, query=query, control=True)
                if self._bluos_response_ok(res, on_ep) and await self._wait_until_ungrouped(
                    slave_ep
                ):
                    return True
            return False

        if await _try_remove(master_ep) or await _try_remove(slave_ep):
            return True

        # Dead primary leaves slaves stuck with reconnecting=true; API self-unjoin
        # returns <error>no slave available as new master</error>.
        donors = list(donor_endpoints or [])
        if await self._ungroup_via_reparent(slave_ep, donors):
            return True
        return False
