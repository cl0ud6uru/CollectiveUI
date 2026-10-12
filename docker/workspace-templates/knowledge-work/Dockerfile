# syntax=docker/dockerfile:1
# Build from the repository root so the tested sandbox helpers remain the single source of truth.
ARG BASE_IMAGE=node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7
FROM ${BASE_IMAGE}

ARG SOURCE_DATE_EPOCH=0
LABEL org.opencontainers.image.title="Knowledge Work" \
      org.opencontainers.image.description="Offline headless document and spreadsheet workspace" \
      org.opencontainers.image.source="https://github.com/cl0ud6uru/CollectiveUI"

COPY docker/sandbox/office-requirements.txt /opt/portal/office-requirements.txt
RUN sed -i -e 's|http://deb.debian.org/debian-security|https://security.debian.org/debian-security|g' \
      -e 's|http://deb.debian.org/debian|https://ftp.debian.org/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      python3-venv libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu-core fonts-liberation2 \
    && python3 -m venv /opt/office \
    && /opt/office/bin/pip install --no-cache-dir -r /opt/portal/office-requirements.txt \
    && rm -rf /var/lib/apt/lists/*

# sandboxd requires uid/gid 1000 and supplies its own bounded sleep command.
RUN set -eu; \
    userdel -r node; \
    groupadd -g 1000 agent && useradd -u 1000 -g 1000 -d /home/agent -s /bin/bash -M agent; \
    mkdir -p /home/agent/workspace /opt/workspace-template/starter; \
    chown -R 1000:1000 /home/agent; \
    chmod 0750 /home/agent; \
    chmod 0755 /home/agent/workspace

COPY --chown=root:root --chmod=0755 docker/sandbox/run-agent docker/sandbox/kill-run docker/sandbox/fsops /opt/portal/
COPY --chown=root:root --chmod=0755 docker/sandbox/office-check docker/sandbox/office-convert /opt/portal/
COPY docker/workspace-templates/manifest.json /opt/workspace-template/manifest.json

# Materialize only the reviewed seed files for this immutable profile.
RUN node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const manifest = JSON.parse(fs.readFileSync('/opt/workspace-template/manifest.json', 'utf8'));
const profile = manifest.profiles.find((entry) => entry.key === 'knowledge-work');
if (!profile || profile.networkPolicy !== 'none' || profile.capabilities.officeHeadless !== true) {
  throw new Error('Knowledge Work manifest entry is missing or has an invalid capability set');
}
const root = '/opt/workspace-template/starter';
for (const file of profile.seedBundle.files) {
  const destination = path.resolve(root, file.path);
  if (!destination.startsWith(root + path.sep) || typeof file.content !== 'string') {
    throw new Error('Invalid Knowledge Work seed entry');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, file.content, { flag: 'wx', mode: 0o444 });
}
NODE

# A fresh persistent home receives the seeds once; existing files always win on restart or reassignment.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -eu' \
      'mkdir -p /home/agent/workspace' \
      'cp -Rn /opt/workspace-template/starter/. /home/agent/workspace/' \
      'exec "$@"' \
      > /usr/local/bin/workspace-template-init \
    && chmod 0755 /usr/local/bin/workspace-template-init

ENV HOME=/home/agent
USER 1000:1000
WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/workspace-template-init"]
CMD ["sleep", "infinity"]
HEALTHCHECK --interval=1m --timeout=15s --start-period=30s --retries=3 CMD /opt/portal/office-check >/dev/null
