CARGO := $(shell command -v cargo 2>/dev/null)

.PHONY: all lint format format-check typecheck test codegen clean \
        dev-cp dev-dashboard dev-proxy

all: typecheck lint

# --- Linting ---

lint:
	npm run lint
ifdef CARGO
	cd proxy && cargo clippy --all-targets -- -D warnings
endif

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

# --- Code generation ---

codegen:
	npm run codegen -w @sardeenz/types

# --- Development ---

dev-cp:
	npm run dev -w @sardeenz/control-plane

dev-dashboard:
	npm run dev -w @sardeenz/dashboard

dev-proxy:
ifdef CARGO
	cd proxy && cargo watch -x run
else
	$(error Rust toolchain not installed — see docs/development/setup.md)
endif

# --- Cleanup ---

clean:
	rm -rf node_modules dist build coverage
	rm -rf packages/types/dist packages/utils/dist
	rm -rf control-plane/dist dashboard/dist
ifdef CARGO
	cd proxy && cargo clean
endif
