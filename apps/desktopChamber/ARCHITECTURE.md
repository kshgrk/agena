# Agena Desktop (v2) — Architecture & Build Contract

This is the coordination contract for building `apps/desktopNew`. Every builder agent MUST follow
it exactly. The old app at `apps/desktop` is READ-ONLY reference material — never modify it, but
read it freely: porting and improving its logic is encouraged (it is our code).

## What this app is

A brand-new renderer for the Agena harness with full feature parity with `apps/desktop` PLUS:
- MCP import/management and Skill import/management UIs (see `docs/contracts/mcp-skills.md`)
- A first-class diff viewer
- A direct browser WebSocket bridge (`WsBridge`) so the app runs without Electron
- A dramatically better visual design (see `docs/contracts/design.md`)

Three host modes, selected in `src/renderer/lib/bridge.ts`:
1. **Electron preload** (`window.agenaPreload`) — main-process glue in `electron/` (already copied, working)
2. **Direct WS** (`WsBridge` over `@agena/client`) — browser connects straight to a daemon URL
3. **Mock** (`src/renderer/mock/`, already copied) — demo world for dev/verification

## Non-negotiable invariants

- Renderer imports types ONLY from `@agena/protocol`, `../shared/bridge.ts`, and type-only
  `@agena/importer` shapes. Never Pi types, never `@agena/client` in components (only
  `lib/ws-bridge.ts` may import it).
- The `AgenaBridge` interface in `src/shared/bridge.ts` is FROZEN. Do not edit it.
- The `UiBatch` rules in `src/shared/bridge.ts` are binding: apply events → snapshots → frames;
  never drop/reorder durable events; coalesce deltas by concatenation (reset semantics for tool
  output). See `docs/contracts/bridge.md`.
- All colors/typography/spacing reference tokens from `src/renderer/styles/theme.css`. No raw hex
  values in components.
- No new npm dependencies except `qrcode`, added for the approved Conductor pairing QR. The dependency set in `package.json` is otherwise final (if
  `@git-diff-view/react@0.0.37` fails to resolve, the integration agent pins the nearest available
  version — nobody else touches package.json).
- Perf rules: transcript is virtualized (`@tanstack/react-virtual`); zustand reads use selectors
  (never subscribe to a whole store in a component); settled transcript blocks are memoized and
  keep stable object identity — only the in-flight tail re-renders during streaming; xterm writes
  go straight to the terminal, never through React state.
- Every non-trivial pure module (ingest, transcript projection, ws-bridge framing, command
  registry) ships a `*.test.ts` runnable via `node --experimental-strip-types --test`.

## Directory ownership (one owner per path — never edit outside your area)

| Path | Owner |
|---|---|
| `src/shared/bridge.ts`, `src/renderer/mock/`, `electron/`, `scripts/` | FROZEN (copied plumbing) |
| `src/renderer/styles/` | design agent (W1) |
| `src/renderer/ui/` (primitive kit) | foundation-ui |
| `index.html`, `src/renderer/main.tsx`, `vite.config.ts`, `tsconfig.json` | foundation-ui |
| `src/renderer/store/` (all slices, ingest, types) | foundation-store |
| `src/renderer/lib/` (ws-bridge.ts, bridge.ts selection, errors.ts, format.ts) | foundation-bridge |
| `src/renderer/app.tsx`, `src/renderer/shell/` (dockview layout, pane registry, statusbar) | shell agent |
| `src/renderer/features/transcript/`, `features/composer/` | feature: transcript |
| `src/renderer/features/diff/`, `features/files/`, `features/snapshots/` | feature: files |
| `src/renderer/features/sessions/`, `features/connect/` | feature: sessions |
| `src/renderer/features/terminal/` | feature: terminal |
| `src/renderer/features/approvals/`, `features/toasts/` | feature: approvals |
| `src/renderer/features/settings/` (tabs: profiles, models, MCP, skills, import) | feature: settings |
| `src/renderer/features/palette/`, `features/search/`, `features/timeline/`, `features/inspector/` | feature: tools |
| `docs/` | contract docs (W1) — read-only after W1 |

## Cross-feature contracts (how features compose without importing each other)

1. **Pane contract** — every feature directory exports from its `index.ts`:
   ```ts
   export const pane: PaneDefinition // { id, title, icon: LucideIcon, Component: React.FC }
   ```
   `PaneDefinition` is defined in `src/renderer/shell/panes.ts` (shell agent). The shell agent
   creates each feature dir with a stub `index.ts`; feature agents overwrite their own stub.
   The shell composes dockview panels from these definitions only.

2. **Command registry** — `src/renderer/store/commands.ts` (foundation-store) exposes
   `registerCommands(cmds: Command[])` and a `useCommands()` selector.
   `Command = { id, title, group, shortcut?, when?: () => boolean, run: () => void }`.
   Features register their commands at module init; the palette renders the registry; the shell
   binds shortcuts. Nobody imports a feature to invoke another feature.

3. **Bridge access** — components call `getBridge()` from `src/renderer/lib/bridge.ts`. Store
   actions that need the bridge live in the store slices; components mostly dispatch store actions.

4. **Toasts** — `store/ui.ts` exposes `pushToast({ kind, title, detail? })`. Features never render
   their own floating notifications.

## Layout (see docs/contracts/design.md for visuals)

- Left rail: sessions/projects sidebar (collapsible, `features/sessions`)
- Center: transcript + composer (`features/transcript`, `features/composer`)
- Right dock (dockview tabs): inspector, files, timeline, snapshots, diff
- Bottom dock: terminal(s)
- Overlays: command palette (cmdk), approvals banner/modal, settings window, toasts
- Statusbar: connection state, session status, model, thinking level, token usage

## Testing & verification

- `pnpm -C apps/desktopNew typecheck` must pass.
- `pnpm -C apps/desktopNew build` must pass.
- `pnpm -C apps/desktopNew dev` renders the app against the mock bridge with zero console errors:
  the mock world must show a streaming session, tool calls, an approval, terminal, files.
- Store/ingest tests pass via the `test` script.

## Reference documents (read before building)

- `docs/contracts/protocol.md` — wire protocol (events, frames, commands, HTTP)
- `docs/contracts/bridge.md` — AgenaBridge, UiBatch rules, PTY ports, persistence
- `docs/contracts/features.md` — old-app feature inventory + IMPROVE-ON notes
- `docs/contracts/mcp-skills.md` — MCP/skill/session-import feature spec
- `docs/contracts/oss-mining.md` + `docs/oss/` — vendored MIT/Apache source to adapt (keep
  attribution headers per `docs/oss/LICENSES.md`); never copy from AGPL sources
- `docs/contracts/design.md` + `src/renderer/styles/theme.css` — the design system
