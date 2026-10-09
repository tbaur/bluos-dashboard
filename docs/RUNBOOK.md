# Runbook

## Start (development)

```bash
make run
```

That installs dependencies if needed, starts the API with reload, waits for `GET /api/v1/healthz`, then starts the UI (so Vite never proxies to a dead API). Uvicorn or Vite exits with an error if its port is already in use. Ctrl-C stops both.

The API bind comes from `BSD_HOST` / `BSD_PORT`, resolved by the backend's own settings loader: environment first, then the repo-root `.env`, else `127.0.0.1:8000`. The Vite dev proxy follows the port. The UI stays on `127.0.0.1:8765`.

Or two terminals (start UI only after healthz returns 200):

```bash
# Terminal 1 — API (Python package lives in backend/)
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
# or: bluos-dashboard

# Terminal 2 — UI
cd frontend
npm ci
npm run dev
```

Open http://127.0.0.1:8765/

## Start (production-ish single process)

```bash
make serve
```

That builds `frontend/dist` and runs `bluos-dashboard` (the backend console entrypoint) with `BSD_STATIC_DIR` pointing at it. Open http://127.0.0.1:8780/. It listens on `SERVE_PORT` (default `8780`), not `BSD_PORT`, so it can stay up while `make run` uses `8000` and `8765`. Change it with `make serve SERVE_PORT=9000`. `BSD_HOST` and every other `BSD_` setting still apply. The manual equivalent:

```bash
make build
cd backend && BSD_STATIC_DIR=../frontend/dist .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Environment variables: [CONFIGURATION.md](CONFIGURATION.md). Network exposure notes are in that doc's **Network exposure** section.

## Health

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/healthz` | Liveness — process up; `status: degraded` when the poller is stopped |
| `GET /api/v1/readyz` | Readiness — 503 when poller is not running; includes `sse_dropped_events`, subscriber count, and `last_error_kind` (exception class only; the message goes to logs, since this endpoint needs no token) |
| `GET /api/v1/version` | Release version |
| `GET /api/v1/fleet/health` | In-memory poller drop history (this process; 24h window; resets on restart). Also included on SSE `fleet` events |
| `GET /health` | Redirects to `/api/v1/healthz` (so SPA catch-all never serves HTML for `/health`) |

## Ports (local)

| Service | URL |
|---------|-----|
| UI (Vite, `make run`) | http://127.0.0.1:8765/ |
| API (`make run`) | http://127.0.0.1:8000/ |
| UI and API (`make serve`) | http://127.0.0.1:8780/ |

Under `make run`, Vite proxies `/api` → the API. CORS defaults allow both `http://127.0.0.1:8765` and `http://localhost:8765`.

## Common failures

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Empty fleet | Discovery blocked (VPN/firewall) or no players | Wait for empty-fleet rediscovery (`BSD_EMPTY_FLEET_REDISCOVERY_SECONDS`); Rescan; try `BSD_DISCOVERY_METHOD=lsdp` |
| Missing CI secondary zones | LSDP-only discovery (chassis/primary port) | Use `mdns` or `both` so `_musp` SRV ports (`11010+`) are found |
| CI zones too loud/quiet vs Nodes when using one slider | Different amp volume scales | Use **NAD CI S2** for the CI chassis and **Bluesound** for Nodes/Pulse — they are separate. Bluesound chips are 20 / 48 / 60; CI S2 chips are 42 / 50 / 60 / 70 |
| NAD C658 jumps to 0 when house volume is 20 | C658 analog floor is ~40; it is not a bluesound.com device | Set C658 volume on its player row; Bluesound slider is Pulse/Node only |
| `device_not_found` on control | Player dropped off discovery (grace expired) | Rescan network; check `BSD_DISCOVERED_GRACE_TTL` |
| Rooms stuck “synced” / reconnecting after primary power-off | Orphan group (primary offline) | **Ungroup** / **Ungroup all** / House **Break all groups** — backend reparents onto a live donor then removes |
| Add rooms disabled on “Offline primary” | Expected — membership changes need a live primary | Ungroup orphans, then form a new group under an online lead |
| One player stuck offline | Circuit slow-poll after consecutive long-poll/connect failures | Power-cycle the player; wait for `BSD_CIRCUIT_SLOW_POLL_SECONDS` |
| House Health empty after restart | Drop history is process-local (not on disk) | Expected — first online in this process starts the 12h presence bar |
| `Request timed out` on Skip or a queue move from a player page | The browser allows six HTTP/1.1 connections per host. Diagnostics, upgrade checks, and SSE can hold those slots | Leave the page; those scrapes abort. The queue loads when the page opens. Inputs, presets, and settings load when Advanced is opened |
| Player still “online” after power-off | Hung TCP on a Status long-poll | Connect failures fail in `BSD_DEVICE_HTTP_TIMEOUT` (~3s). A stuck read can wait until `BSD_STATUS_LONG_POLL_SECONDS` + slack |
| Bluetooth section missing | Model/probe reports unsupported | Normal for many CI zones and players without BT |
| SSE reconnecting / stale UI | Proxy buffering, backend restart, or SSE backpressure | Check backend logs for `sse_drop_subscriber`; UI uses exponential reconnect, then after 8 failures shows **Offline**, keeps REST polling every 5s, and retries SSE every 60s until live again (empty fleet uses `BSD_EMPTY_FLEET_REDISCOVERY_SECONDS` cache — not a full discovery each poll) |
| `make run` fails with `address already in use` or `Port 8765 is in use` | Something already listens on the API/UI port | Stop that process (`lsof -nP -iTCP:8000 -sTCP:LISTEN`), or set a different `BSD_PORT` |
| `bad interpreter` from a `backend/.venv/bin/` tool after moving the checkout | `backend/.venv` records its original path | `make distclean install` |
| Every control returns `401` from a LAN bind, or logs show `insecure_bind` | `BSD_HOST` is not loopback and `BSD_API_TOKEN` is empty or mismatched | Set `BSD_API_TOKEN` and the matching `VITE_API_TOKEN` in `frontend/.env`; see [CONFIGURATION.md](CONFIGURATION.md) **Network exposure** |
| Page says **Can’t reach the dashboard** | The UI loaded but `/api/v1` is not answering (API starting, restarting, or a proxy in front of it is down) | It retries every few seconds. Check `/api/v1/healthz` and the API logs. The token form appears only on a real `401` |
| `401 unauthorized` from API | `BSD_API_TOKEN` set without matching UI token | Put the same value in `frontend/.env` as `VITE_API_TOKEN` (Vite does not read repo-root `.env`) |
| Vite `ECONNREFUSED` / proxy errors to `:8000` | UI started before API was healthy | Use `make run` (waits for healthz); or start API first and confirm healthz before `npm run dev` |

Variable names and defaults: [CONFIGURATION.md](CONFIGURATION.md).

## Multi-room sync notes

- Ungrouping always targets the **primary** with `RemoveSlave` (or legacy `/Sync?remove=`).
- If the primary is offline, the API tries the slave, then **reparent-ungroup**: briefly `AddSlave` onto another **free/standalone** online player (never a member of another group), then `RemoveSlave` there, and verifies standalone via `/SyncStatus`.
- After a successful leave, freed players are **stopped** so leftover AirPlay/capture sessions clear (primary only when it has no remaining followers).
- The lead often reports no slaves before the follower drops `master`. The snapshot and fleet row treat that leftover claim as standalone so the row does not stay SYNCED after the group is gone.
- Orphan groups appear in the Sync panel with lead name **Offline primary** and an `offline` role chip; you can ungroup followers but cannot add rooms until a live primary exists.
- **Group all free rooms** / `POST /api/v1/sync/enable` attaches only standalones — existing groups are left alone.
- **Ungroup all** / `POST /api/v1/sync/break` returns succeeded/failed counts; HTTP 502 only when every link removal fails.

## Process

Run one process. More than one uvicorn worker splits the fleet across processes that do not share discovery or the long-polls.

On SIGINT or SIGTERM the app ends every open SSE stream first, so an open browser tab does not hold up a stop or a `--reload` restart. Browsers reconnect when the server is back.

A crash should start that same process again. Example:

```ini
[Service]
WorkingDirectory=/opt/bluos-dashboard/backend
EnvironmentFile=/opt/bluos-dashboard/.env
ExecStart=/opt/bluos-dashboard/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
Restart=on-failure
```

After a restart the health log is empty, discovery runs again, and rooms stay stale or offline until the first successful long-poll. Readiness (`/api/v1/readyz`) reports `discovery_age_seconds`, `stale_count`, and `slow_poll_count`. It returns 503 when the poller task has stopped ticking. It does not include player names or addresses.

## Logs

Stdout JSON logs include `request_id`. Every HTTP request (except SSE stream) emits `http_request` with method, path, status, and `duration_ms`. Control paths emit `control_op` / `control_failed` / `control_during_grace` with `op`, `device_id`, and `device_ip`. Fleet-wide actions log per-device results plus `fleet_action_complete` (`action`, `succeeded`, `failed`). Scoped fleet volume also logs `fleet_volume_targets` with `target_count` / `scoped`. Stop-after-ungroup warnings include `role` (`slave` / `primary`). Poller misses log `poll_device_error` / `device_watch_failed` / `poller_cycle_failed`. Correlate UI toast request IDs with log lines.

## See also

- [CONFIGURATION.md](CONFIGURATION.md) — all `BSD_` variables
- [SECURITY.md](../SECURITY.md) — supported versions and vulnerability reporting
- [README.md](../README.md) — project overview
- [CONTRIBUTING.md](../CONTRIBUTING.md) — setup and checks
