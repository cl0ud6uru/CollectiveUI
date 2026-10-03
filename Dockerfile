# syntax=docker/dockerfile:1
# Targets:
#   web    – the Next.js app (standalone output)
#   worker – background worker (every chat and routine reply, memory extraction) + migrations, runs from source with tsx
#   sandboxd – the workspace daemon (docker-compose.sandbox.yml): plain Node, no npm dependencies, only src/sandboxd

FROM node:22-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

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
FROM deps AS worker
ENV NODE_ENV=production
COPY . .
RUN groupadd -r app && useradd -r -g app app && mkdir -p /data/uploads && chown -R app:app /data
USER app
ENV STORAGE_DIR=/data/uploads
# exec: node replaces the shell, so SIGTERM (docker stop) reaches the worker, which then saves running replies as
# interrupted before it exits (see src/worker/index.ts). `npx tsx` would put a CLI process in between.
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && exec node --import tsx src/worker/index.ts"]

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
