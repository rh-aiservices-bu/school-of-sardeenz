FROM node:22-slim AS base

WORKDIR /app

FROM base AS deps

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY control-plane/package.json control-plane/

RUN npm ci --ignore-scripts

# Ensure workspace-local node_modules dirs exist even when npm hoists everything.
# COPY requires the source to exist; this guarantees it.
RUN mkdir -p packages/types/node_modules control-plane/node_modules

FROM base AS build

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
COPY --from=deps /app/control-plane/node_modules ./control-plane/node_modules

COPY tsconfig.base.json tsconfig.json ./
COPY packages/types/ packages/types/
COPY packages/contracts/ packages/contracts/
COPY control-plane/ control-plane/

RUN npx tsc --build control-plane/tsconfig.json

FROM base AS runtime

ENV NODE_ENV=production

# Apptainer CLI for runner-catalog signature verification. The control plane streams the ORAS SIF
# layer itself, then runs `apptainer verify`; verification needs no setuid/fuse/userns, so the
# unprivileged package suffices. Skip this layer if you only ever run the 'stub' importer. Pinned;
# bump deliberately, and update APPTAINER_DEB_SHA256 to match (sha256 of the .deb release asset).
ARG APPTAINER_VERSION=1.3.6
ARG APPTAINER_DEB_SHA256=2723b2928cfc30edf687723c49556ec4e013f0bf7cdb43a5a76bca7bd3c70792
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates wget && \
    wget -q "https://github.com/apptainer/apptainer/releases/download/v${APPTAINER_VERSION}/apptainer_${APPTAINER_VERSION}_amd64.deb" -O /tmp/apptainer.deb && \
    echo "${APPTAINER_DEB_SHA256}  /tmp/apptainer.deb" | sha256sum -c - && \
    apt-get install -y --no-install-recommends /tmp/apptainer.deb && \
    rm -f /tmp/apptainer.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 sardeenz && \
    adduser --system --uid 1001 --ingroup sardeenz sardeenz

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
COPY --from=deps /app/control-plane/node_modules ./control-plane/node_modules

COPY --from=build /app/packages/types/dist ./packages/types/dist
# Runtime images contain compiled shared types, not TypeScript source. Use the
# runtime manifest so Node resolves @sardeenz/types to dist/index.js.
COPY --from=build /app/packages/types/package.runtime.json ./packages/types/package.json
COPY --from=build /app/control-plane/dist ./control-plane/dist
COPY --from=build /app/control-plane/package.json ./control-plane/
COPY control-plane/migrations/ control-plane/migrations/

USER sardeenz

EXPOSE 3000

CMD ["node", "control-plane/dist/index.js"]
