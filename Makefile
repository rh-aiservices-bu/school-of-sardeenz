CARGO := $(shell command -v cargo 2>/dev/null)
COMPOSE := $(shell if command -v podman-compose >/dev/null 2>&1; then echo "podman-compose"; elif command -v podman >/dev/null 2>&1; then echo "podman compose"; else echo "docker compose"; fi)

.PHONY: all lint lint-specs format format-check typecheck test test-integration \
        test-coverage codegen clean dev-cp dev-dashboard dev-proxy dev-worker \
        dev-worker-2 dev-full dev-worker-stop services services-stop

all: typecheck lint

# --- Linting ---

lint: lint-specs
	npm run lint
ifdef CARGO
	cd proxy && cargo clippy --all-targets -- -D warnings
endif

lint-specs:
	npm run validate -w @sardeenz/contracts

# --- Formatting ---

format:
	npx prettier --write .
ifdef CARGO
	cd proxy && cargo fmt
endif

format-check:
	npx prettier --check .
ifdef CARGO
	cd proxy && cargo fmt --check
endif

# --- Type checking ---

typecheck:
	npx tsc --build
ifdef CARGO
	cd proxy && cargo check
endif

# --- Testing ---

test:
	npm test
ifdef CARGO
	cd proxy && cargo test
endif

test-integration: ## Run integration tests (requires compose services)
	npm run test:integration -w @sardeenz/control-plane

test-coverage:
	npm run test:coverage

# --- Code generation ---

codegen:
	npm run codegen -w @sardeenz/types

# --- Dev services ---

services:
	$(COMPOSE) up -d

services-stop:
	$(COMPOSE) down

# --- Development ---

dev-cp:
	npm run dev -w @sardeenz/control-plane

dev-dashboard:
	npm run dev -w @sardeenz/dashboard

dev-proxy:
	./scripts/dev-proxy.sh

dev-worker: ## Start a single dev worker (dev-worker-0 on port 9100)
	node --import tsx runners/dev-worker/src/index.ts

dev-worker-2: ## Start two dev workers
	concurrently --names "w0,w1" --prefix-colors "blue,red" \
		"SARDEENZ_WORKER_ID=dev-worker-0 SARDEENZ_WORKER_PORT=9100 SARDEENZ_RUNNER_PORT_START=9101 node --import tsx runners/dev-worker/src/index.ts" \
		"SARDEENZ_WORKER_ID=dev-worker-1 SARDEENZ_WORKER_PORT=9200 SARDEENZ_RUNNER_PORT_START=9201 node --import tsx runners/dev-worker/src/index.ts"

dev-full: services ## Start full dev stack: Redis, PostgreSQL, control plane, proxy, dashboard, and one dev worker
	concurrently --names "proxy,cp,dashboard,bff,worker" --prefix-colors "yellow,magenta,green,cyan,blue" \
		"./scripts/dev-proxy.sh" \
		"npm run dev -w @sardeenz/control-plane" \
		"npm run dev -w @sardeenz/dashboard" \
		"npm run dev:server -w @sardeenz/dashboard" \
		"node --import tsx runners/dev-worker/src/index.ts"

dev-worker-stop: ## Stop all running dev workers
	@pkill -f "runners/dev-worker/src/index.ts" 2>/dev/null || echo "No dev workers running"

# --- Cleanup ---

clean:
	rm -rf node_modules dist build coverage
	rm -rf packages/types/dist packages/utils/dist
	rm -rf control-plane/dist dashboard/dist
ifdef CARGO
	cd proxy && cargo clean
endif
