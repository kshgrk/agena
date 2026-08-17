# docker/Dockerfile — Agena M1 daemon. No build step: runs TypeScript directly
# under Node's native type stripping. agent-browser 0.33.2 requires Node 24.
# Lockfile-first layers keep deps cached (§10.2).
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    AGENA_STATE_DIR=/var/lib/agena \
    AGENA_WORKSPACE_DIR=/workspace \
    AGENA_PORT=7777

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      g++ \
      git \
      less \
      make \
      poppler-utils \
      procps \
      python3 \
      python3-docx \
      python3-openpyxl \
      ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable
WORKDIR /app

# Manifests first → install → source, so the dependency layer only rebuilds when
# a package.json / lockfile changes, not on every source edit.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/cli/package.json apps/cli/
COPY apps/daemon/package.json apps/daemon/
COPY packages/client/package.json packages/client/
COPY packages/core/package.json packages/core/
COPY packages/importer/package.json packages/importer/
COPY packages/protocol/package.json packages/protocol/
COPY packages/runtime-pi/package.json packages/runtime-pi/
COPY packages/storage-sqlite/package.json packages/storage-sqlite/
COPY packages/tui/package.json packages/tui/
RUN pnpm install --frozen-lockfile --prod --filter @agena/daemon...

# Agent browser tool (opt-in at runtime via AGENA_BROWSER_TOOL=1; see
# docs/agent-browser.md). The binaries live in the image but are inert unless
# the env is set. Debian's system chromium is used directly via
# AGENT_BROWSER_EXECUTABLE_PATH, so agent-browser needs no Chrome-for-Testing
# download. Pi's extension loader supplies the pi peer-deps, so a global install
# of pi-agent-browser-native is enough. This layer is skippable for non-browser
# builds by deleting it — nothing else depends on it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --allow-scripts=agent-browser agent-browser@0.33.2 pi-agent-browser-native@0.3.0 \
    && agent-browser --version \
    && npm cache clean --force
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# Only the daemon and its runtime deps reach the image (no CLI/TUI source).
# Keep source after heavyweight dependency layers so ordinary edits rebuild fast.
COPY apps/daemon apps/daemon
COPY packages/protocol packages/protocol
COPY packages/core packages/core
COPY packages/importer packages/importer
COPY packages/runtime-pi packages/runtime-pi
COPY packages/storage-sqlite packages/storage-sqlite
COPY deploy/environment_manifest.py deploy/apt-recording-wrapper.sh /opt/agena/

# Runtime-only user environment. Keep this after all build-time package work so
# /home/agena stays empty and can be replaced by the persistent Modal Volume.
ENV HOME=/home/agena \
    XDG_CONFIG_HOME=/home/agena/.config \
    XDG_DATA_HOME=/home/agena/.local/share \
    XDG_CACHE_HOME=/tmp/agena-cache \
    NPM_CONFIG_PREFIX=/home/agena/.local \
    PNPM_HOME=/home/agena/.local/share/pnpm \
    PIPX_HOME=/home/agena/.local/share/pipx \
    PIPX_BIN_DIR=/home/agena/.local/bin \
    CARGO_HOME=/home/agena/.cargo \
    GOPATH=/home/agena/.local/share/go
ENV PATH=/home/agena/.local/bin:/home/agena/.local/share/pnpm:/home/agena/.cargo/bin:/home/agena/.local/share/go/bin:$PATH

# The base package set lets the runtime wrappers persist only packages the user
# explicitly added. The manifest is consumed as a cached image layer on deploy.
RUN apt-mark showmanual | sort -u > /opt/agena/base-manual-packages \
    && chmod 755 /opt/agena/environment_manifest.py /opt/agena/apt-recording-wrapper.sh \
    && ln -s /opt/agena/apt-recording-wrapper.sh /usr/local/bin/apt \
    && ln -s /opt/agena/apt-recording-wrapper.sh /usr/local/bin/apt-get

# Three roots, separate and never mixed (§3.3 / P1); state and home are 0700.
RUN mkdir -p /var/lib/agena /workspace /home/agena \
    && chown node:node /var/lib/agena /workspace /home/agena \
    && chmod 700 /var/lib/agena /home/agena

USER node
WORKDIR /workspace
# no VOLUME instruction: compose declares named volumes itself, and Modal's
# image builder rejects it (deploy/modal_app.py builds from this file)
EXPOSE 7777
CMD ["node", "/app/apps/daemon/src/main.ts"]
