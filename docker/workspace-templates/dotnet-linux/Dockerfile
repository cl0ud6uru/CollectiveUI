# syntax=docker/dockerfile:1
# Build from the repository root. The base is pinned and the .NET SDK package is installed at one exact version.
ARG BASE_IMAGE=node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7
FROM ${BASE_IMAGE}

ARG SOURCE_DATE_EPOCH=0
ARG DOTNET_SDK_PACKAGE_VERSION=10.0.112-1
ARG MICROSOFT_REPO_DEB_SHA256=8434dcb8c346dc95fbd63dbece056c343704590b58b6a5c323d39acf52bf0b48
LABEL org.opencontainers.image.title=".NET Linux" \
      org.opencontainers.image.description="Offline-ready .NET 10 Linux starter workspace" \
      org.opencontainers.image.source="https://github.com/cl0ud6uru/CollectiveUI" \
      com.microsoft.dotnet.sdk.package-version="${DOTNET_SDK_PACKAGE_VERSION}"

RUN set -eux; \
    curl --fail --silent --show-error --location https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb \
      --output /tmp/packages-microsoft-prod.deb; \
    echo "${MICROSOFT_REPO_DEB_SHA256}  /tmp/packages-microsoft-prod.deb" | sha256sum --check --status; \
    dpkg -i /tmp/packages-microsoft-prod.deb; \
    rm /tmp/packages-microsoft-prod.deb; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      "dotnet-sdk-10.0=${DOTNET_SDK_PACKAGE_VERSION}" git python3; \
    rm -rf /var/lib/apt/lists/*; \
    test -x /usr/share/dotnet/dotnet; \
    dotnet --list-sdks | grep -Fxq '10.0.112 [/usr/share/dotnet/sdk]'; \
    dotnet --list-runtimes | grep -Fxq 'Microsoft.NETCore.App 10.0.12 [/usr/share/dotnet/shared/Microsoft.NETCore.App]'; \
    test -d /usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/10.0.12; \
    test -d /usr/share/dotnet/packs/Microsoft.NETCore.App.Host.linux-x64/10.0.12; \
    ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet

RUN set -eu; \
    userdel -r node; \
    groupadd -g 1000 agent && useradd -u 1000 -g 1000 -d /home/agent -s /bin/bash -M agent; \
    mkdir -p /home/agent/workspace /home/agent/.dotnet /home/agent/.nuget/packages \
      /opt/portal /opt/workspace-template/starter /opt/workspace-template/nuget; \
    chown -R 1000:1000 /home/agent; \
    chmod 0750 /home/agent; \
    chmod 0755 /home/agent/workspace

COPY --chown=root:root --chmod=0755 docker/sandbox/run-agent docker/sandbox/kill-run docker/sandbox/fsops /opt/portal/
COPY --chown=root:root docker/workspace-templates/dotnet-linux/starter/ /opt/workspace-template/starter/
COPY --chown=1000:1000 docker/workspace-templates/dotnet-linux/starter/ /home/agent/workspace/

ENV HOME=/home/agent \
    DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_CLI_HOME=/home/agent/.dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=1 \
    NUGET_PACKAGES=/home/agent/.nuget/packages

USER 1000:1000
WORKDIR /home/agent/workspace

# Restore is the only NuGet network step. The lock file and exact feed are checked during image build.
RUN dotnet restore Starter.csproj --locked-mode --source https://api.nuget.org/v3/index.json \
    && dotnet build Starter.csproj --no-restore --configuration Release

USER root
# Store the exact locked cache and generated restore metadata in the image. Startup copies them only when missing.
RUN cp -a /home/agent/workspace/obj/. /opt/workspace-template/starter/obj/ \
    && cp -a /home/agent/.nuget/packages/. /opt/workspace-template/nuget/ \
    && chown -R root:root /opt/workspace-template

RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -eu' \
      'mkdir -p /home/agent/workspace /home/agent/.dotnet /home/agent/.nuget/packages' \
      'cp -Rn /opt/workspace-template/starter/. /home/agent/workspace/' \
      'cp -Rn /opt/workspace-template/nuget/. /home/agent/.nuget/packages/' \
      'exec "$@"' \
      > /usr/local/bin/workspace-template-init \
    && chmod 0755 /usr/local/bin/workspace-template-init

USER 1000:1000
WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/workspace-template-init"]
CMD ["sleep", "infinity"]
HEALTHCHECK --interval=1m --timeout=15s --start-period=30s --retries=3 CMD dotnet --list-sdks | grep -Fxq '10.0.112 [/usr/share/dotnet/sdk]' && dotnet --list-runtimes | grep -Fxq 'Microsoft.NETCore.App 10.0.12 [/usr/share/dotnet/shared/Microsoft.NETCore.App]'
