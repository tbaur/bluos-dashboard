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
# The API runs discovery before it answers healthz, so allow for BSD_DISCOVERY_TIMEOUT.
HEALTH_WAIT_SECONDS := 30
# Its own port, so `make serve` can stay up while `make run` uses BSD_PORT.
SERVE_PORT ?= 8780

# Prints "host port" as the API resolves them: environment, then .env, then defaults.
API_BIND = cd backend && $(PY) -c 'from app.config import get_settings; s = get_settings(); print(s.host, s.port)'

.PHONY: help install build run serve lint test check clean distclean run-api run-ui

help: ## List targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z-]+:.*## / { printf "  make %-10s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

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

run: install ## Develop: API with reload, then the Vite UI once the API is healthy
	@$(MAKE) --no-print-directory -j2 run-api run-ui

run-api:
	@set -e; bind=$$($(API_BIND)); read -r host port <<< "$$bind"; \
	cd backend && exec $(PY) -m uvicorn app.main:app --reload --host "$$host" --port "$$port"

# A wildcard bind is not connectable, so probe and proxy over loopback.
run-ui:
	@set -e; bind=$$($(API_BIND)); read -r host port <<< "$$bind"; \
	case "$$host" in 0.0.0.0|::|localhost) host=127.0.0.1 ;; *:*) host="[$$host]" ;; esac; \
	url="http://$$host:$$port/api/v1/healthz"; \
	until curl -fsS -m 1 "$$url" >/dev/null 2>&1; do \
		if (( SECONDS >= $(HEALTH_WAIT_SECONDS) )); then echo "API not healthy at $$url" >&2; exit 1; fi; \
		sleep 0.25; \
	done; \
	cd frontend && BSD_PORT="$$port" exec npm run dev

serve: build $(VENV_STAMP) ## Build the UI, then serve UI and API from one process on SERVE_PORT
	cd backend && BSD_PORT=$(SERVE_PORT) BSD_STATIC_DIR=$(CURDIR)/$(DIST) exec $(PY) -m app.cli

lint: install ## Ruff and mypy (backend); ESLint and tsc (frontend)
	cd backend && $(PY) -m ruff check app tests && $(PY) -m mypy app
	cd frontend && npm run lint && npm run typecheck

test: install ## Backend and frontend tests with the CI coverage gates
	cd backend && $(PY) -m pytest --cov=app --cov-report= && $(PY) -m coverage report
	cd frontend && npm run test:coverage

check: lint test build ## Everything CI runs except the dependency audits

clean: ## Remove build output, coverage, and caches (keeps dependencies)
	rm -rf $(DIST) frontend/coverage frontend/*.tsbuildinfo
	rm -rf backend/.pytest_cache backend/.mypy_cache backend/.ruff_cache backend/htmlcov
	rm -rf backend/.coverage backend/coverage.xml backend/*.egg-info
	find backend/app backend/tests -name __pycache__ -type d -prune -exec rm -rf {} +

distclean: clean ## Also remove backend/.venv and frontend/node_modules
	rm -rf $(VENV) frontend/node_modules
