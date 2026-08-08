# Agent browser tool

The agent browser tool lets the coding agent drive a **headless browser inside
the daemon's container** — separate from the desktop app's embedded browser
pane (which is a native Electron view for the human). This one is for the agent:
opening pages, reading their accessibility tree, clicking, filling forms, and
capturing screenshots into the workspace.

It is provided by the [`pi-agent-browser-native`](https://github.com/fitchmultz/pi-agent-browser-native)
Pi extension wrapping the upstream [`agent-browser`](https://agent-browser.dev/)
CLI (a headless-Chromium automation binary).

## Containment stance

This tool is **opt-in and off by default.** With `AGENA_BROWSER_TOOL` unset the
daemon loads exactly one bundled extension (session naming) and nothing else —
identical to a build without this feature, and asserted by
`packages/runtime-pi/test/containment.test.ts`. The extension binaries ship in
the container image but are inert until the env gate is set; `chromium` is never
spawned when the tool is disabled.

When enabled, `packages/runtime-pi/src/adapter.ts` adds the extension to the
*contained* resource loader via `additionalExtensionPaths` (which still load
under `noExtensions: true` — only filesystem auto-discovery is disabled). The
package is resolved from `node_modules` at runtime and wrapped in try/catch, so
a missing package or binary logs a warning and degrades to today's behavior
instead of crashing the daemon.

## The tool

The agent gets a native `agent_browser` tool (beside `read`, `write`, `bash`).
Each call supplies exactly one input mode:

- **`args`** — raw upstream argv, e.g. `{ "args": ["open", "https://react.dev"] }`,
  `{ "args": ["snapshot", "-i"] }`. Full 1:1 CLI coverage.
- **`semanticAction`** — intent shorthand compiled to upstream `find`/`click`/
  `fill`/`select`, e.g. click-by-text
  `{ "semanticAction": { "action": "click", "locator": "text", "value": "Sign in" } }`
  or fill-by-label. More robust than hand-quoted selectors.
- **`job`** — a short fail-fast workflow (thin `batch` compiler).
- **`qa`** — a QA preset that fail-fast asserts readiness / expected text /
  selectors and reports a bounded `qa-failure`.

Snapshots lead with main page content and expose interactive `@eN` refs for
follow-up clicks/fills. See the package's `docs/TOOL_CONTRACT.md` and
`docs/COMMAND_REFERENCE.md` (installed under the global package) for field
rules.

### Prefer text snapshots; write screenshots to /workspace

Screenshots are large. Until blob spill lands (M7), tool output above the
**64 KiB inline cap** cannot be returned to the transcript inline. So:

- Prefer the **text snapshot / accessibility** mode (`snapshot -i`) for the
  agent to reason about a page — it is compact and stays under the cap.
- When a screenshot is genuinely needed, write it into **`/workspace`** (e.g.
  `{ "args": ["screenshot", "/workspace/shot.png"] }`) so it surfaces in the
  desktop Files pane rather than being truncated in the transcript.

## Enabling it

Two things are required: the binaries in the image, and the runtime env gate.

1. **Image** — the Node 24 container image (`docker/Dockerfile`) installs Debian
   `chromium`, and globally installs the verified pair `agent-browser@0.33.2` +
   `pi-agent-browser-native@0.3.0` alongside Agena's Pi 0.84.0 runtime.
   `AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium` points the CLI at the
   system browser, so no Chrome-for-Testing download is needed. This is already
   baked in — no action needed at build time.

2. **Env gate** — set `AGENA_BROWSER_TOOL=1` in the daemon's environment.
   - **Modal:** add `AGENA_BROWSER_TOOL=1` to the `agena-daemon` secret and
     redeploy. `deploy/modal_app.py` already reserves 2048 MB for the headless
     browser.
   - **Local / compose:** export `AGENA_BROWSER_TOOL=1` for the daemon process.

Optional override: `AGENA_BROWSER_EXTENSION` may point at an explicit extension
source directory if the package is installed somewhere non-standard.

For ordinary public research, add either `EXA_API_KEY` or `BRAVE_API_KEY` to the
daemon environment. The extension then registers `agent_browser_web_search`;
without either credential, direct URL browsing still works but the search tool
is intentionally absent. Managed-session restore-policy rejections from an
automatic reuse attempt are retried once with `sessionMode: "fresh"`.

## Requirements note

The browser tool needs meaningfully more memory than the base daemon; the Modal
function is sized to 2048 MB for this reason. If you run the daemon elsewhere,
give the container headroom for headless Chromium.
