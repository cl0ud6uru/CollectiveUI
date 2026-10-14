# Build with BASE_IMAGE set to an operator-reviewed personal Codex image digest.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE

# The stock image ends as uid 10001; install desktop packages as root, then restore
# the same unprivileged user and workspace used by its native app-server runtime.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium fluxbox imagemagick python3 x11-utils xauth xdotool xvfb \
 && rm -rf /var/lib/apt/lists/*

RUN case "$BASE_IMAGE" in *@sha256:*) digest="${BASE_IMAGE##*@sha256:}"; \
      test "${#digest}" -eq 64 && case "$digest" in *[!a-f0-9]*|'') exit 1;; esac ;; \
    *) exit 1 ;; esac

COPY docker/computer/control.py /opt/collective-computer/control.py
COPY docker/computer/start.py /opt/collective-computer/start.py
COPY docker/computer/app-server.mjs /opt/collective-computer/app-server.mjs
COPY docker/computer/bridge.mjs /opt/collective-codex/bridge.mjs
COPY docker/computer/patch-requirements.py /opt/collective-computer/patch-requirements.py
RUN chmod 0555 /opt/collective-computer/control.py /opt/collective-computer/start.py \
 && chmod 0644 /opt/collective-computer/app-server.mjs /opt/collective-codex/bridge.mjs \
 && python3 /opt/collective-computer/patch-requirements.py /etc/codex/requirements.toml

ENV DISPLAY=:99
ENV XAUTHORITY=/tmp/collective-computer.Xauthority
ENV COMPUTER_PROFILE=/home/agent/workspace/.computer-profile
USER 10001:10001
WORKDIR /home/agent/workspace
ENTRYPOINT ["python3", "/opt/collective-computer/start.py"]
