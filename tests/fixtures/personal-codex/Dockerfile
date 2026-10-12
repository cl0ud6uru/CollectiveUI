# Offline protocol fixture: exact native package and the production policy/wrapper, without live credentials.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
COPY vendor /opt/codex
RUN chmod -R a+rX /opt/codex && chmod 0755 /opt/codex/bin/codex && ln -s /opt/codex/bin/codex /usr/local/bin/codex \
 && groupadd --gid 10001 codex && useradd --uid 10001 --gid 10001 --home-dir /codex-home codex \
 && mkdir -p /codex-home /home/agent/workspace && chown 10001:10001 /codex-home /home/agent/workspace && chmod 0700 /codex-home /home/agent/workspace
COPY requirements.toml /etc/codex/requirements.toml
COPY server.mjs bridge.mjs /opt/collective-codex/
COPY node_modules /opt/collective-codex/node_modules
RUN chmod 0644 /etc/codex/requirements.toml /opt/collective-codex/server.mjs /opt/collective-codex/bridge.mjs
ENV PATH=/usr/local/bin:/usr/bin:/bin
ENTRYPOINT []
USER 10001:10001
WORKDIR /home/agent/workspace
CMD ["node", "/opt/collective-codex/server.mjs"]
