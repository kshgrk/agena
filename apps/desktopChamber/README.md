# Agena Chamber

Agena Chamber is the Electron renderer for Agena. It source-adapts
OpenChamber's visual language while keeping Agena's daemon, protocol, durable
events, Pi runtime, projects, sessions, subagents, approvals, terminal,
snapshots, browser, Fast Mode, and usage reporting.

## Development

```sh
pnpm --filter @agena/desktop-chamber app
```

The renderer uses port `5230` by default. A browser-only mock is available with:

```sh
pnpm --filter @agena/desktop-chamber dev
```

## Validation

```sh
pnpm --filter @agena/desktop-chamber typecheck
pnpm --filter @agena/desktop-chamber test
pnpm --filter @agena/desktop-chamber build
```

See `THIRD_PARTY_NOTICES.md` for the pinned OpenChamber source and MIT license.
