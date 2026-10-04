# syntax=docker/dockerfile:1
# Targets:
#   web    – the Next.js app (standalone output)
#   worker – background worker (every chat and routine reply, memory extraction) + migrations, runs from source with tsx
#   test   – writable, non-root unit-test harness with Python/native fixtures; never a production image
#   sandboxd – the workspace daemon (docker-compose.sandbox.yml): plain Node, no npm dependencies, only src/sandboxd

FROM node:22-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS runtime-deps
COPY package.json package-lock.json ./
# Next's optional Playwright peer is marked devOptional, so npm still installs it with --omit=dev.
# The worker never uses Next's experimental browser-test integration; remove its tools and bin links.
RUN npm ci --omit=dev \
    && rm -rf node_modules/@playwright/test node_modules/playwright node_modules/playwright-core \
              node_modules/.bin/playwright node_modules/.bin/playwright-core \
    && npm cache clean --force

FROM deps AS build
COPY . .
# public/ holds optional static files and isn't in the repo while it's empty (git keeps no empty folders); the web
# stage copies it, so make sure it exists.
RUN mkdir -p public && npm run build

# ---------------------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd -r app && useradd -r -g app app && mkdir -p /data/uploads && chown -R app:app /data
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
ENV STORAGE_DIR=/data/uploads
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

# ---------------------------------------------------------------------------
FROM runtime-deps AS worker
ENV NODE_ENV=production
COPY src ./src
COPY assets/pets ./assets/pets
COPY tsconfig.json ./
# The documented offline local-account bootstrap/recovery command also runs in this image.
COPY scripts/local-account.ts ./scripts/local-account.ts
RUN chmod -R a+rX /app && groupadd -r app && useradd -r -g app app && mkdir -p /data/uploads && chown -R app:app /data
USER app
ENV STORAGE_DIR=/data/uploads
# The explicit legacy-enrollment import is an operator command in the worker image.
COPY --chmod=0644 scripts/migrate-docker-hermes-enrollment.ts ./scripts/migrate-docker-hermes-enrollment.ts
# exec: node replaces the shell, so SIGTERM (docker stop) reaches the worker, which then saves running replies as
# interrupted before it exits (see src/worker/index.ts). `npx tsx` would put a CLI process in between.
CMD ["sh", "-c", "node --import tsx src/db/migrate.ts && exec node --import tsx src/worker/index.ts"]

# ---------------------------------------------------------------------------
# Full Debian Node includes /usr/bin/python3, git and procps for the synthetic native-process fixtures.
# Pin the same fixture base as docker/sandbox/Dockerfile; no apt/pip downloads or real Hermes installation.
FROM node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7 AS test
ENV NODE_ENV=test NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY --chown=node:node . .
CMD ["npm", "test", "--", "--project", "unit"]

# ---------------------------------------------------------------------------
# Only its own sources: sandboxd imports node:* and relative files, and never sees the app, its deps or .env.
FROM node:22-slim AS sandboxd
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=root:root src/sandboxd ./src/sandboxd
USER node
EXPOSE 4200
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "-e", "require('node:net').connect(4200, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"]
CMD ["node", "src/sandboxd/index.ts"]
