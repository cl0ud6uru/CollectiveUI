# Prepared, checksummed context: scripts/build-personal-codex-stock.sh.
# Official prebuilt Linux x64 Codex, including its bundled bubblewrap; no Rust build.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
COPY inputs.sha256 codex.tgz ws.tgz /tmp/stock-inputs/
COPY debs /tmp/stock-inputs/debs
RUN cd /tmp/stock-inputs && sha256sum --check --strict inputs.sha256 \
 && apt-get --yes --no-install-recommends install /tmp/stock-inputs/debs/*.deb \
 && mkdir -p /opt/codex /opt/collective-codex/node_modules/ws \
 && tar -xzf codex.tgz --strip-components=3 -C /opt/codex package/vendor/x86_64-unknown-linux-musl \
 && tar -xzf ws.tgz --strip-components=1 -C /opt/collective-codex/node_modules/ws \
 && echo '68374c44c942514b480b21a14f666d75922633594c652f3a2052e3eca80ea947  /opt/codex/bin/codex' | sha256sum --check --strict \
 && echo '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c  /opt/codex/codex-resources/bwrap' | sha256sum --check --strict \
 && chmod -R a+rX /opt/codex /opt/collective-codex/node_modules \
 && ln -s /opt/codex/bin/codex /usr/local/bin/codex \
 && groupadd --gid 10001 codex && useradd --uid 10001 --gid 10001 --home-dir /codex-home codex \
 && mkdir -p /codex-home /home/agent/workspace /etc/codex /opt/collective-codex \
 && chown 10001:10001 /codex-home /home/agent/workspace && chmod 0700 /codex-home /home/agent/workspace \
 && rm -rf /tmp/stock-inputs
COPY requirements.toml /etc/codex/requirements.toml
COPY server.mjs bridge.mjs prepare-workspace.mjs /opt/collective-codex/
COPY stock-inputs.lock.json /opt/collective-codex/stock-inputs.lock.json
RUN chmod 0644 /etc/codex/requirements.toml /opt/collective-codex/*.mjs /opt/collective-codex/stock-inputs.lock.json
# No PATH bubblewrap: Codex resolves the exact bundled resource beside its binary.
ENV PATH=/usr/local/bin:/usr/bin:/bin
ENTRYPOINT []
USER 10001:10001
WORKDIR /home/agent/workspace
CMD ["node", "/opt/collective-codex/server.mjs"]
