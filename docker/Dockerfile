# docker/Dockerfile — Agena M1 daemon. No build step: runs TypeScript directly
# under Node 22 type stripping. Lockfile-first layers keep deps cached (§10.2).
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    AGENA_STATE_DIR=/var/lib/agena \
    AGENA_WORKSPACE_DIR=/workspace \
    AGENA_PORT=7777

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      g++ \
      git \
      less \
      make \
      procps \
      python3 \
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

# Only the daemon and its runtime deps reach the image (no CLI/TUI source).
COPY apps/daemon apps/daemon
COPY packages/protocol packages/protocol
COPY packages/core packages/core
COPY packages/importer packages/importer
COPY packages/runtime-pi packages/runtime-pi
COPY packages/storage-sqlite packages/storage-sqlite

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
    && npm install -g agent-browser pi-agent-browser-native \
    && npm cache clean --force
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# Two roots, separate and never mixed (§3.3 / P1); state is 0700.
RUN mkdir -p /var/lib/agena /workspace \
    && chown node:node /var/lib/agena /workspace \
    && chmod 700 /var/lib/agena

USER node
WORKDIR /workspace
# no VOLUME instruction: compose declares named volumes itself, and Modal's
# image builder rejects it (deploy/modal_app.py builds from this file)
EXPOSE 7777
CMD ["node", "/app/apps/daemon/src/main.ts"]
