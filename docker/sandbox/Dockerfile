# syntax=docker/dockerfile:1
# The workspace sandbox image (P5): each person's container that bots run commands and edit files in.
# Build with `npm run sandbox:image` (see scripts/build-sandbox-image.sh). sandboxd uses the image by ID.
#
# No network at run time, no secrets, no AI CLIs yet (Codex and Claude Code arrive with their runtimes, P8/P9).
# The full Debian-based Node image already has git, python3, a C toolchain and procps, so the build needs no package
# downloads (reproducible, and it builds behind restrictive proxies).
ARG BASE_IMAGE=node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7
FROM ${BASE_IMAGE}

# The node image's "node" user owns uid 1000; the workspace user takes it. uid 1001 is reserved for the Claude Code
# runtime (P9): its home is private (0700), so workspace commands can't read it.
RUN set -eu; \
    userdel -r node; \
    groupadd -g 1000 agent && useradd -u 1000 -g 1000 -d /home/agent -s /bin/bash -M agent; \
    groupadd -g 1001 claude && useradd -u 1001 -g 1001 -d /home/claude -s /bin/bash -M claude; \
    mkdir -p /home/agent/workspace /home/claude; \
    chown -R 1000:1000 /home/agent && chmod 0750 /home/agent && chmod 0755 /home/agent/workspace; \
    chown 1001:1001 /home/claude && chmod 0700 /home/claude; \
    git config --system init.defaultBranch main; \
    git config --system advice.detachedHead false

COPY --chown=root:root --chmod=0755 run-agent kill-run fsops /opt/portal/

USER 1000:1000
WORKDIR /home/agent
# No entrypoint script: sandboxd runs "sleep infinity" and fixed helpers, nothing else.
ENTRYPOINT []
CMD ["sleep", "infinity"]
