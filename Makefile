# BluOS Dashboard developer tasks. Run `make` with no target to list them.
# Written for GNU Make 3.81 (the macOS default), so no .ONESHELL or .SHELLFLAGS.

SHELL := bash
.DEFAULT_GOAL := help

PYTHON ?= python3
VENV := backend/.venv
PY := $(CURDIR)/$(VENV)/bin/python
DIST := frontend/dist
VENV_STAMP := $(VENV)/.installed
NODE_STAMP := frontend/node_modules/.installed
# The API runs discovery before it answers healthz. The UI waits for
# BSD_DISCOVERY_TIMEOUT plus this margin before it gives up.
HEALTH_WAIT_MARGIN_SECONDS := 30
# Must match server.port in frontend/vite.config.ts.
UI_PORT := 8765
# Its own port, so `make serve` can stay up while `make run` uses BSD_PORT.
SERVE_PORT ?= 8780

# Prints "host port discovery_timeout" as the API resolves them: environment, then .env, then defaults.
API_SETTINGS = cd backend && $(PY) -c 'from app.config import get_settings; s = get_settings(); print(s.host, s.port, int(s.discovery_timeout))'

# Shell that sets bind_host, port, host and wait_s: where the API binds, where to
# reach it (a wildcard bind is not connectable, so loopback), and how long it may take.
API_PROBE = settings=$$($(API_SETTINGS)); read -r bind_host port discovery <<< "$$settings"; \
	case "$$bind_host" in 0.0.0.0|::|localhost) host=127.0.0.1 ;; *) host=$$bind_host ;; esac; \
	wait_s=$$(( discovery + $(HEALTH_WAIT_MARGIN_SECONDS) ))

.PHONY: help install build run serve lint lint-backend lint-frontend test test-backend \
	test-frontend check clean distclean run-api run-ui

help: ## List targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z-]+:.*## / { printf "  make %-14s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: $(VENV_STAMP) $(NODE_STAMP) ## Install backend and frontend dependencies (skips what is current)

$(VENV_STAMP): backend/pyproject.toml
	test -x $(PY) || $(PYTHON) -m venv $(VENV)
	$(PY) -m pip install --quiet --upgrade pip
	cd backend && $(PY) -m pip install --quiet -e '.[dev]'
	touch $@

$(NODE_STAMP): frontend/package.json frontend/package-lock.json
	cd frontend && npm ci
	touch $@

build: $(NODE_STAMP) ## Build the production UI into frontend/dist
	cd frontend && npm run build

# A busy port must stop here: otherwise the UI's health probe finds the old API
# and Vite starts against it while the new uvicorn exits.
run: install ## Develop: API with reload, then the Vite UI once the API is healthy
	@set -e; $(API_PROBE); \
	for target in "$$host/$$port" "127.0.0.1/$(UI_PORT)"; do \
		if (exec 3<>"/dev/tcp/$$target") 2>/dev/null; then \
			echo "Port $${target#*/} on $${target%/*} is already in use. Stop that process first." >&2; \
			exit 1; \
		fi; \
	done
	@$(MAKE) --no-print-directory -j2 run-api run-ui

run-api:
	@set -e; $(API_PROBE); \
	cd backend && exec $(PY) -m uvicorn app.main:app --reload --host "$$bind_host" --port "$$port"

run-ui:
	@set -e; $(API_PROBE); \
	case "$$host" in *:*) url="http://[$$host]:$$port/api/v1/healthz" ;; \
		*) url="http://$$host:$$port/api/v1/healthz" ;; esac; \
	until curl -fsS -m 1 "$$url" >/dev/null 2>&1; do \
		if (( SECONDS >= wait_s )); then echo "API not healthy at $$url after $${wait_s}s" >&2; exit 1; fi; \
		sleep 0.25; \
	done; \
	cd frontend && BSD_PORT="$$port" exec npm run dev

serve: build $(VENV_STAMP) ## Build the UI, then serve UI and API from one process on SERVE_PORT
	cd backend && BSD_PORT=$(SERVE_PORT) BSD_STATIC_DIR=$(CURDIR)/$(DIST) exec $(PY) -m app.cli

lint: lint-backend lint-frontend ## Lint and type-check both sides

lint-backend: $(VENV_STAMP) ## Ruff and mypy
	cd backend && $(PY) -m ruff check app tests && $(PY) -m mypy app

lint-frontend: $(NODE_STAMP) ## ESLint and tsc
	cd frontend && npm run lint && npm run typecheck

test: test-backend test-frontend ## Test both sides with the CI coverage gates

test-backend: $(VENV_STAMP) ## pytest, then the fail_under gate in pyproject.toml
	cd backend && $(PY) -m pytest --cov=app --cov-report= && $(PY) -m coverage report

test-frontend: $(NODE_STAMP) ## Vitest with the thresholds in vite.config.ts
	cd frontend && npm run test:coverage

check: lint test build ## Everything CI runs except the dependency audits

clean: ## Remove build output, coverage, and caches (keeps dependencies)
	rm -rf $(DIST) frontend/coverage frontend/*.tsbuildinfo
	rm -rf backend/.pytest_cache backend/.mypy_cache backend/.ruff_cache backend/htmlcov
	rm -rf backend/.coverage backend/coverage.xml backend/*.egg-info
	find backend/app backend/tests -name __pycache__ -type d -prune -exec rm -rf {} +

distclean: clean ## Also remove backend/.venv and frontend/node_modules
	rm -rf $(VENV) frontend/node_modules
