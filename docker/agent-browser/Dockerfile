# Isolated opt-in runtime. No Docker socket, host homes, network interface or public port.
# Build context: repository root. Independent package; parent owns root package integration.
ARG BASE_IMAGE=node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/collective
COPY src/agent-browserd/package.json ./src/agent-browserd/package.json
RUN cd src/agent-browserd && npm install --omit=dev --ignore-scripts
COPY src/agent-browserd ./src/agent-browserd
COPY src/lib/agent-browser/provider-contract.ts ./src/lib/agent-browser/provider-contract.ts
COPY src/sandboxd/protocol/auth.ts ./src/sandboxd/protocol/auth.ts
USER 1000:1000
CMD ["node", "src/agent-browserd/index.ts"]
