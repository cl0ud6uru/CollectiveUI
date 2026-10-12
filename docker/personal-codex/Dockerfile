# Install/review separately. The provisioner accepts an immutable digest, never this tag.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
RUN npm install --global @openai/codex@0.163.0-alpha.2 \
 && apt-get update && apt-get install --no-install-recommends -y git python3 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 codex && useradd --uid 10001 --gid 10001 --home-dir /codex-home codex \
 && mkdir -p /codex-home /home/agent/workspace /etc/codex /opt/collective-codex \
 && chown 10001:10001 /codex-home /home/agent/workspace && chmod 0700 /codex-home /home/agent/workspace
WORKDIR /opt/collective-codex
RUN npm install --omit=dev --no-package-lock ws@8.22.0
COPY docker/personal-codex/requirements.toml /etc/codex/requirements.toml
COPY docker/personal-codex/server.mjs docker/personal-codex/bridge.mjs /opt/collective-codex/
RUN chmod 0644 /etc/codex/requirements.toml /opt/collective-codex/server.mjs /opt/collective-codex/bridge.mjs
# Clear inherited image environment; driver verifies the exact effective environment.
ENV PATH=/usr/local/bin:/usr/bin:/bin
ENTRYPOINT []
USER 10001:10001
WORKDIR /home/agent/workspace
CMD ["node", "/opt/collective-codex/server.mjs"]
