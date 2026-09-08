CARGO := $(shell command -v cargo 2>/dev/null)
COMPOSE := $(shell if command -v podman-compose >/dev/null 2>&1; then echo "podman-compose"; elif command -v podman >/dev/null 2>&1; then echo "podman compose"; else echo "docker compose"; fi)

# `make` with no target shows the help.
.DEFAULT_GOAL := help

.PHONY: help all lint lint-specs format format-check typecheck test test-deployment test-integration \
        test-coverage test-python test-python-deps codegen clean services services-stop \
        dev dev-full dev-full-logged dev-cp dev-bff dev-dashboard dev-proxy \
        dev-worker dev-worker-2 dev-worker-stop

##@ Help

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "; printf "\nSardeenz v2 — make targets\n\nUsage:\n  make <target>\n"} /^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf "\nExamples:\n  make services      # start Redis + Postgres (once; keep running)\n  make dev-full      # whole stack + ONE worker (run 'make services' first)\n  make dev           # stack only (proxy, cp, dashboard, BFF) — pair with your own worker\n  make dev-worker    # a single worker on its own (mode/ports from .env)\n\nMost dev targets read config from the root .env (see .env.example).\n\n"

##@ Dev services (containers)

services: ## Start Redis + Postgres (Podman/Docker Compose)
	$(COMPOSE) up -d

services-stop: ## Stop Redis + Postgres
	$(COMPOSE) down

##@ Development (run from repo root; needs `make services` up)

dev: ## App stack, NO workers: proxy, control plane, dashboard, BFF (same as `npm run dev`)
	npm run dev

dev-full: ## App stack + ONE dev worker (proxy, cp, dashboard, BFF, worker)
	npx concurrently --names "proxy,cp,dashboard,bff,worker" --prefix-colors "yellow,magenta,green,cyan,blue" \
		"./scripts/dev-proxy.sh" \
		"npm run dev -w @sardeenz/control-plane" \
		"npm run dev -w @sardeenz/dashboard" \
		"npm run dev:server -w @sardeenz/dashboard" \
		"node --import tsx runners/dev-worker/src/index.ts"

dev-full-logged: ## App stack + ONE dev worker, each tee'd to logs/<service>.log
	npx concurrently --names "proxy,cp,dashboard,bff,worker" --prefix-colors "yellow,magenta,green,cyan,blue" \
		"./scripts/dev-proxy.sh --logged" \
		"npm run dev:logged -w @sardeenz/control-plane" \
		"npm run dev:logged -w @sardeenz/dashboard" \
		"npm run dev:server:logged -w @sardeenz/dashboard" \
		"mkdir -p logs && SARDEENZ_RUNNER_CATALOG_URL=$${SARDEENZ_RUNNER_CATALOG_URL:-./runners.yaml} node --import tsx runners/dev-worker/src/index.ts 2>&1 | tee logs/worker.log"

dev-cp: ## Control plane only (Fastify dev server, :3000)
	npm run dev -w @sardeenz/control-plane

dev-bff: ## Dashboard BFF server only (:4000) — the dashboard's /api backend
	npm run dev:server -w @sardeenz/dashboard

dev-dashboard: ## Dashboard Vite client only (:5173) — needs the BFF too (see dev-bff / dev)
	npm run dev -w @sardeenz/dashboard

dev-proxy: ## Routing proxy only (cargo watch; requires Rust)
	./scripts/dev-proxy.sh

dev-worker: ## A single dev worker (dev-worker-0, port 9100 unless overridden in .env)
	node --import tsx runners/dev-worker/src/index.ts

# SARDEENZ_MAX_RUNNERS=24 below: with the #160 4-port-per-runner block, 24 runners * 4 ports = 96,
# fitting each worker's 100-port block (9100s/9200s) without overlapping the next worker's range.
dev-worker-2: ## Two dev workers (ports 9100/9200) for multi-worker placement testing
	npx concurrently --names "w0,w1" --prefix-colors "blue,red" \
		"SARDEENZ_WORKER_ID=dev-worker-0 SARDEENZ_WORKER_PORT=9100 SARDEENZ_RUNNER_PORT_START=9101 SARDEENZ_MAX_RUNNERS=24 node --import tsx runners/dev-worker/src/index.ts" \
		"SARDEENZ_WORKER_ID=dev-worker-1 SARDEENZ_WORKER_PORT=9200 SARDEENZ_RUNNER_PORT_START=9201 SARDEENZ_MAX_RUNNERS=24 node --import tsx runners/dev-worker/src/index.ts"

dev-worker-stop: ## Stop all running dev workers
	@pkill -f "runners/dev-worker/src/index.ts" 2>/dev/null || echo "No dev workers running"

##@ Quality

all: typecheck lint ## Type-check and lint everything

lint: lint-specs ## ESLint (+ clippy if Rust available) + OpenAPI spec validation
	npm run lint
ifdef CARGO
	cd proxy && cargo clippy --all-targets -- -D warnings
endif

lint-specs: ## Validate OpenAPI specs (Redocly)
	npm run validate -w @sardeenz/contracts

format: ## Auto-format all files (Prettier + rustfmt)
	npx prettier --write .
ifdef CARGO
	cd proxy && cargo fmt
endif

format-check: ## Check formatting (CI-safe)
	npx prettier --check .
ifdef CARGO
	cd proxy && cargo fmt --check
endif

typecheck: ## tsc --build (+ cargo check if Rust available)
	npx tsc --build
	npm run typecheck:e2e -w @sardeenz/dashboard
ifdef CARGO
	cd proxy && cargo check
endif

test: test-deployment ## Run all test suites (Vitest + cargo test)
	npm test
ifdef CARGO
	cd proxy && cargo test
endif

test-deployment: ## Test deployment/publishing shell orchestration (no cluster required)
	./tests/deployment/test-build-sif.sh
	./tests/deployment/test-build-runner-sif.sh

test-integration: ## Integration tests (requires compose services)
	npm run test:integration -w @sardeenz/control-plane

test-coverage: ## Run tests with V8 coverage
	npm run test:coverage

# The Python runner shims (runners/vllm, runners/mlserver) and the shared engine-runner
# conformance suite (runners/conformance) run only fake engines — deps are fastapi/httpx/pytest,
# never vllm/torch/mlserver. `test-python` runs pytest only; run `test-python-deps` first (ideally
# in a venv) to install the shims editable with their [test] extras. Kept out of `make test` so a
# Rust/TS dev box needs no Python — CI runs both in a dedicated `python` job. The root pytest.ini
# supplies --import-mode=importlib so the single invocation below does not collide on the shims'
# duplicate tests/test_core.py basename (#161).
test-python-deps: ## Install the Python shims (editable, [test] extras) — run inside a venv
	pip install -e "runners/vllm[test]" -e "runners/mlserver[test]"

test-python: ## Run the Python shim + conformance suites (needs test-python-deps first)
	python3 -m pytest runners/vllm/tests runners/mlserver/tests runners/conformance

##@ Build / misc

codegen: ## Regenerate TypeScript types from OpenAPI specs
	npm run codegen -w @sardeenz/types

clean: ## Remove all build artifacts
	rm -rf node_modules dist build coverage
	rm -rf packages/types/dist packages/utils/dist
	rm -rf control-plane/dist dashboard/dist
ifdef CARGO
	cd proxy && cargo clean
endif
