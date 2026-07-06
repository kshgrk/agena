# AGENTS.md — operating contract for agents working in Agena

Read this before touching anything. It is short on purpose; the detail lives in the spec.

## 0. The one rule that overrides the rest: discuss first, change only on approval

Do **not** edit code, config, or docs on your first move. For any non-trivial request:

1. Read the relevant part of the codebase and `final_plan.md`.
2. Tell the user **what needs to be done** — the change, the files it touches, the trade-offs, and the lazier alternative if there is one.
3. **Wait for explicit approval.** Only then make the change.

Approval for one change is not approval for the next. When in doubt, describe and ask. Trivial, obviously-safe, explicitly-requested edits (e.g. "fix this typo", "rename this variable") can skip the discussion — but anything that adds a dependency, changes a boundary, alters the protocol, or spans multiple files gets discussed first.

## 1. `final_plan.md` is the product spec — treat it as authoritative

`final_plan.md` is the single source of truth for what Agena is and how it is built: architecture, invariants, folder structure, wire protocol, event catalog, DB schema, Pi integration, milestones, and the problem register. Before proposing or writing anything:

- Find the relevant section (it is numbered §1–§18) and read it fully.
- If code disagrees with the plan, **the code is wrong** — flag it, don't cargo-cult it.
- If a request conflicts with the plan, say so and surface the conflict before proceeding.
- If the plan is genuinely silent or ambiguous, ask the user; do not invent a design and bury it in code.

The plan supersedes `claude_plan.md` and `codex_plan.md` (kept only as history — do not follow them).

## 2. Use the ponytail skill to review and write code

Every coding task — writing, refactoring, fixing, reviewing, choosing a dependency — runs through **ponytail** (`ponytail:ponytail`, default `full`). It is a lazy-senior-dev discipline: the shortest code that actually works.

- Climb the ladder before writing: does this need to exist? → reuse what's in the repo → stdlib/native → an already-installed dep → one line → only then new code. **Never add a dependency for what a few lines do.**
- No speculative abstractions: no interface with one implementation (the `EventStore` / `RuntimeAdapter` ports in `final_plan.md` are the sanctioned exceptions — they are mandated), no factory for one product, no config for a constant.
- Deletion over addition. Boring over clever. Fewest files, shortest working diff — but only after you understand the whole flow.
- Mark deliberate shortcuts with `// ponytail: <what>, <upgrade path/when>` so intent reads as intent.
- Non-trivial logic leaves one small `vitest` check behind — the smallest test that fails if the logic breaks.

Run `/ponytail-review` on a diff and `/ponytail-audit` on the repo when asked to review for over-engineering.

## 3. Follow the existing design and folder structure — always

The structure and its rules are defined in `final_plan.md` §4. Do not reshape it.

- `packages/protocol` is the contract: it imports nothing internal (only `zod`) and owns every wire name — envelope, commands, durable-event and frame registries, error/close codes, HTTP route schemas. Everything else compiles against it.
- `packages/core` defines the ports (`EventStore`, `RuntimeAdapter`) and domain logic; **`packages/runtime-pi` is the only package allowed to import Pi.**
- Dependency edges are mechanically enforced by `pnpm boundary`. Do not add an import that crosses a forbidden edge; if you think you need one, the design is off — discuss it.
- Match the code that is already there: erasable-syntax-only TypeScript (no enums/namespaces — runs under Node 22 type stripping and Bun), explicit `.ts` import extensions, strict types, no `any`, Biome formatting.
- Put new files where the plan's tree says they go. New wire names, events, or routes are defined in `protocol` first, then used elsewhere.

## 4. Write optimised code

"Optimised" here means minimal and correct, not clever. Reuse before rebuild; the standard library and native platform features before dependencies; a projection or index before a scan when the plan calls for it. Do not micro-optimise speculatively — but do not reintroduce complexity the plan deliberately removed (e.g. never persist streaming deltas as event rows; keep frames ephemeral).

## 5. Respect milestone scope

The repo is built milestone by milestone (`final_plan.md` §14). Do not scaffold, stub, or add dependencies for a later milestone's machinery. If a request needs something a later milestone owns (SQLite, shell/PTY, approvals, importers, `.agena` execution), say which milestone it belongs to and confirm the user wants to pull it forward.

## 6. Before you hand work back

Run the gates and report the result honestly:

```sh
pnpm ci   # lint + boundary + typecheck + vitest
```

State plainly what passed, what failed (with output), and what was skipped. Do not claim done on unverified work. Do not run `git` commit/push unless the user asks.
