# syntax=docker/dockerfile:1

# =============================================================================
# Stage 1: dependency cache
# Pre-fetch and compile all dependencies before copying application source.
# This layer is invalidated only when Cargo.toml or Cargo.lock changes.
# =============================================================================
# Keep this aligned with Cargo.toml's rust-version. CI verifies the locked
# dependency graph with this exact MSRV before the image build.
FROM rust:1.86-bookworm AS deps

# Install musl toolchain and build-time dependencies for aws-lc-sys (rustls/reqwest)
RUN apt-get update && apt-get install -y --no-install-recommends \
        musl-tools \
        cmake \
        clang \
        libclang-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add x86_64-unknown-linux-musl

WORKDIR /build

# Copy only the manifest files first to maximise cache reuse
COPY Cargo.toml Cargo.lock ./

# Create a stub main so cargo can resolve and compile all dependencies without
# the real application source.  The stub is replaced in the next stage.
RUN mkdir -p src \
    && printf 'fn main() {}' > src/main.rs \
    && cargo build \
        --release \
        --target x86_64-unknown-linux-musl \
    && rm -rf src

# =============================================================================
# Stage 2: application build
# Copies real sources on top of the pre-warmed dependency cache.
# =============================================================================
FROM deps AS builder

COPY src ./src

# Touch main.rs so cargo detects the change (stub was compiled in deps stage)
RUN touch src/main.rs \
    && cargo build \
        --release \
        --target x86_64-unknown-linux-musl \
        --bin sardeenz-proxy

# Verify the binary is statically linked and strip debug symbols
RUN file target/x86_64-unknown-linux-musl/release/sardeenz-proxy \
    && strip target/x86_64-unknown-linux-musl/release/sardeenz-proxy

# =============================================================================
# Stage 3: runtime image
# Distroless "static" image: no shell, no libc, no package manager.
# The only files added are the proxy binary and a non-root user identity.
# =============================================================================
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

# Copy the statically-linked binary
COPY --from=builder \
    /build/target/x86_64-unknown-linux-musl/release/sardeenz-proxy \
    /usr/local/bin/sardeenz-proxy

# Proxy listens on 8080; admin/metrics endpoint on 9099
EXPOSE 8080 9099

# distroless/static:nonroot already sets USER 65532 (nonroot).
# Declare it explicitly for clarity and tooling compatibility.
USER 65532:65532

# Health check:
# The /healthz endpoint is served on the admin port (9099).
# distroless/static has no shell, curl, or wget, so exec-form CMD cannot
# perform an HTTP request without an extra binary.
#
# In production this is handled at the orchestrator level:
#   Kubernetes liveness probe (httpGet) does not need a shell or curl:
#
#     livenessProbe:
#       httpGet:
#         path: /healthz
#         port: 9099
#       initialDelaySeconds: 10
#       periodSeconds: 30
#       timeoutSeconds: 5
#       failureThreshold: 3
#
# For local docker run testing, override with:
#   docker run --health-cmd='...' or use a sidecar prober.
#
# HEALTHCHECK is intentionally omitted here; rely on the orchestrator probe.

ENTRYPOINT ["/usr/local/bin/sardeenz-proxy"]
