# ADR-0002: Bun CLI Gate

Status: provisional keep, local M3 gate closed

## Context

`final_plan.md` keeps the daemon on Node and makes the compiled local CLI a Bun decision. M3 is the first milestone that exercises the riskiest client path: raw terminal mode, pi-tui suspend/restore, and a binary PTY WebSocket for `agena shell`.

## Decision

Keep Bun as the CLI compile target for the M3 implementation. The fallback remains Node/npm distribution if the cross-platform terminal matrix exposes an unfixable issue.

## Evidence on 2026-07-06

- `pnpm bun-gate` compiles `apps/cli/src/main.ts` with `bun build --compile`.
- The compiled binary starts and prints `agena --help`.
- The compiled binary size is checked under the 80 MB budget in §11.6.
- `corepack pnpm run ci` includes the Bun gate.

## Remaining Release Matrix

The full §11.6 matrix still needs manual execution before treating Bun as final for public release: Linux x64 glibc/musl, tmux, stock Linux terminal, reconnect storms, abnormal signal restoration, and macOS signing/notarization behavior. This is a release gate, not an M3 implementation blocker.
