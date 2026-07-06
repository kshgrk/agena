# Agena

Session-first coding agent harness: a daemon in Docker owns durable session
state; the local `agena` CLI/TUI connects over WebSocket. The single source of
truth for the design is [final_plan.md](./final_plan.md).

## Status: M1 — Walking Skeleton

In-memory event store only: history survives TUI restarts but **not** daemon
restarts, by design (final_plan.md §14). SQLite persistence, shell attach,
approvals, snapshots, and imports land in M2+.

## Quickstart

Requirements: Docker, Node >= 22.6, pnpm 10 (`corepack enable`).

```sh
pnpm install

# 1. Start the daemon in Docker
export AGENA_TOKEN=$(openssl rand -hex 32)   # daemon bearer token
export ANTHROPIC_API_KEY=sk-ant-...          # passed through to the runtime
docker compose -f docker/compose.yml up --build -d
curl -s http://127.0.0.1:7700/health

# 2. Connect the TUI (same shell, so it sees AGENA_TOKEN)
node apps/cli/src/main.ts

# 3. Checks and tests
pnpm ci   # lint + boundary check + typecheck + vitest
```

`AGENA_HOST_PORT` (default `7700`) selects the loopback host port; in-container
the daemon always listens on `7777`.

## Layout

- `apps/daemon` — Node daemon: HTTP + multiplexed WS, in-memory event store
- `apps/cli` — the `agena` terminal client
- `packages/{protocol,core,runtime-pi,client,tui}` — see final_plan.md §4.1
- `docker/` — image + compose; two named volumes, separate roots (`/workspace`
  for user files, `/var/lib/agena` for daemon state — final_plan.md §3.3)
