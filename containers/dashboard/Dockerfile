FROM node:22-slim AS base

WORKDIR /app

FROM base AS deps

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY dashboard/package.json dashboard/

RUN npm ci --ignore-scripts

RUN mkdir -p packages/types/node_modules dashboard/node_modules

FROM base AS build

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
COPY --from=deps /app/dashboard/node_modules ./dashboard/node_modules
COPY --from=deps /app/package.json ./package.json

COPY tsconfig.base.json tsconfig.json ./
COPY packages/types/ packages/types/
COPY packages/contracts/ packages/contracts/
COPY dashboard/ dashboard/

# Build shared types first, then dashboard (frontend + BFF)
RUN npx tsc --build dashboard/tsconfig.json

# Build frontend static assets
RUN npm run build -w @sardeenz/dashboard

FROM base AS runtime

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 sardeenz && \
    adduser --system --uid 1001 --ingroup sardeenz sardeenz

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
COPY --from=deps /app/dashboard/node_modules ./dashboard/node_modules

# Shared types
COPY --from=build /app/packages/types/dist ./packages/types/dist
# Runtime images contain compiled shared types, not TypeScript source. Use the
# runtime manifest so Node resolves @sardeenz/types to dist/index.js.
COPY --from=build /app/packages/types/package.runtime.json ./packages/types/package.json

# BFF compiled server
COPY --from=build /app/dashboard/dist/server ./dashboard/dist/server
COPY --from=build /app/dashboard/package.json ./dashboard/

# Frontend static assets
COPY --from=build /app/dashboard/dist/client ./dashboard/dist/client

USER sardeenz

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:4000/healthz').then(r => { if (!r.ok) process.exit(1) })"

CMD ["node", "dashboard/dist/server/index.js"]
