FROM node:22-slim AS base

WORKDIR /app

FROM base AS deps

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY control-plane/package.json control-plane/

RUN npm ci --ignore-scripts

FROM base AS build

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
COPY --from=deps /app/control-plane/node_modules ./control-plane/node_modules 2>/dev/null || true

COPY tsconfig.base.json tsconfig.json ./
COPY packages/types/ packages/types/
COPY packages/contracts/ packages/contracts/
COPY control-plane/ control-plane/

RUN npx tsc --build control-plane/tsconfig.json

FROM base AS runtime

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 sardeenz && \
    adduser --system --uid 1001 --ingroup sardeenz sardeenz

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules 2>/dev/null || true
COPY --from=deps /app/control-plane/node_modules ./control-plane/node_modules 2>/dev/null || true

COPY --from=build /app/packages/types/dist ./packages/types/dist
COPY --from=build /app/packages/types/package.json ./packages/types/
COPY --from=build /app/control-plane/dist ./control-plane/dist
COPY --from=build /app/control-plane/package.json ./control-plane/
COPY control-plane/migrations/ control-plane/migrations/

USER sardeenz

EXPOSE 3000

CMD ["node", "control-plane/dist/index.js"]
