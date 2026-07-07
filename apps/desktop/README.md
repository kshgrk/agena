# @agena/desktop

The Agena Desktop app (docs/desktop_plan.md): a Vite + React renderer plus the
real Electron main/preload bridge. The renderer talks to the daemon exclusively
through the `AgenaBridge` contract on `window.agena`.

## Ownership

- `src/renderer/` + `src/shared/` — built here. The renderer imports only
  `@agena/protocol` and `src/shared/bridge.ts`; never `@agena/client` or
  `electron`.
- `src/main/` + `src/preload/` — the Electron side, owned by the user per
  docs/desktop_plan.md §5. Preload implements `AgenaBridge` against
  `@agena/client`.

## Running

```sh
pnpm dev        # Vite renderer on http://localhost:5199
pnpm app        # Electron app; requires pnpm dev already running
```

In a bare browser `window.agena` is absent, so bootstrap dynamically imports
`src/renderer/mock/install.ts` and installs a fixture-backed mock bridge —
the full UI runs with fake sessions, streaming, and terminals. Inside
Electron the preload installs the real bridge first and the mock never loads.

## Other commands

```sh
pnpm typecheck  # tsc --noEmit (strict, verbatimModuleSyntax)
pnpm build      # vite build → dist/renderer
pnpm preview    # serve the production build
```
