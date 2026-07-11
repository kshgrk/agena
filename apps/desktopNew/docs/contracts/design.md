# Agena Desktop — Design Contract

Owner: design agent (W1). Binding for every builder. Pairs with
`src/renderer/styles/theme.css` — the stylesheet is the source of truth for values; this document
is the source of truth for *usage*. If a component looks different from this spec, the component
is wrong.

The bar: Linear / Zed / Raycast. Dark-first developer tool. The design language is
**"Graphite & Iris"** — cool graphite neutrals (hue 270) with a single iris accent (hue 275).

---

## 1. Visual principles

1. **Density with air.** This is a professional tool: 13px UI type, 28px rows, 4px grid. Density
   comes from small type and tight rows — never from cramped padding. Blocks get real breathing
   room (16–20px gaps between transcript blocks); rows inside a list sit at 2px apart.
2. **Hierarchy through lightness, not decoration.** Five background layers
   (`canvas → surface → raised → overlay`, plus `inset` for wells) and four foreground steps
   (`fg → fg-secondary → fg-muted → fg-faint`) carry ALL hierarchy. No gradients on surfaces, no
   glows, no colored panel backgrounds.
3. **Restraint with color.** Chrome is grayscale. Color means something happened: accent = the
   agent is doing something / the selected thing; green = succeeded; red = failed/destructive;
   amber = needs your attention. A screen at rest is nearly monochrome. If a screen looks
   colorful, it's over-signaling.
4. **Borders define surfaces; shadows define elevation.** Every card/popover has a 1px token
   border. Shadows (always paired with a border) appear only on things that float: popovers
   (`shadow-md`), dialogs/palette (`shadow-overlay`). In-page cards never have shadows.
5. **The transcript is the product.** Everything else (sidebar, docks, statusbar) is quiet chrome
   that recedes. Chrome uses `text-sm`/`text-xs` and muted foregrounds; only transcript prose uses
   `text-base`.
6. **Motion is confirmation, not decoration.** Things animate once, when they appear or change
   state — never continuously (the only exceptions: shimmer on running labels, pulse on the
   stream caret and pending-approval dot).

---

## 2. Hard rules (violations fail review)

- **All colors reference theme tokens.** Tailwind utilities backed by `@theme` (`bg-surface`,
  `text-fg-muted`, `border-border`, `text-tool-error`, …) or `var(--*)` in rare inline styles.
  **Never** raw hex/oklch/rgb in a component. Tailwind's default palette is disabled
  (`--color-*: initial`) — `bg-zinc-900` will not compile; that's intentional.
- Tints and washes are opacity modifiers on tokens: `bg-danger/10`, `border-warn/35`,
  `bg-accent/12`. Standard alphas: **10** (wash bg), **16** (hover wash / gutter), **26**
  (strong highlight), **35** (colored border).
- All spacing on the 4px grid (`gap-1` … `gap-5`; `p-1` … `p-5`). No arbitrary pixel values
  except where this doc specifies one.
- One radius per role (see stylesheet comments): buttons/inputs/rows `rounded-md`, cards/popovers
  `rounded-lg`, panels/dialogs `rounded-xl`, composer `rounded-2xl`. Never mix on one element
  family.
- All mono text is `text-sm` (13px). Never smaller, never larger — code, diffs, tool args, paths.
- Icons: lucide-react only. 16px (`size-4`) default, 14px (`size-3.5`) in dense rows and the
  statusbar. Icon color follows the text color next to it.
- No new fonts, no images, no illustrations. Empty states are typography + one icon.
- Focus is `:focus-visible` only — already global in theme.css. Never add per-component focus
  styles, never `outline-none` on a focusable element (base styles handle it).
- Light theme is free if you use tokens. Never write `light:` variants for color; the tokens
  flip. (`light:` exists for the rare structural difference only.)
- The terminal is always dark, in both themes. Do not theme xterm from Tailwind classes; build
  its theme object from the `--term-*` vars (below).

---

## 3. Token reference

### Backgrounds (utilities: `bg-canvas`, `bg-surface`, `bg-raised`, `bg-overlay`, `bg-inset`)

| Token | Use |
|---|---|
| `canvas` | Window base. Transcript scroll area, titlebar, statusbar. |
| `surface` | Sidebar, dock panels, tool cards, settings cards, composer. |
| `raised` | Popovers, dropdown menus, hovered/selected list rows, kbd chips. |
| `overlay` | Command palette, dialogs, tooltips, toasts. |
| `inset` | Terminal, code wells inside tool cards, diff code area, input troughs. |

Rule: a child surface is at most one layer above its parent. Hover state of a row on `surface` is
`raised`; hover of a row on `raised` is `bg-fg/6` wash.

### Foreground (utilities: `text-fg`, `text-fg-secondary`, `text-fg-muted`, `text-fg-faint`)

| Token | Use |
|---|---|
| `fg` | Prose, primary labels, code. |
| `fg-secondary` | Section labels, sidebar row titles, tab labels. |
| `fg-muted` | Timestamps, counts, placeholders, shortcuts, inactive icons. |
| `fg-faint` | Disabled, tree guides, decorative chevrons. |

### Accent & status

`bg-accent text-accent-fg` for the one primary action per view. `accent-hover`/`accent-active`
for interaction. Status colors `success` / `warn` / `danger` / `info` — text and icons at full
strength, backgrounds only as washes (`/10`).

### Tool states (utilities: `text-tool-running`, `bg-tool-success`, …)

`pending`, `running`, `success`, `error`, `aborted`, `denied` — mapping in §6.

### Diff tokens

`diff-add-bg`, `diff-add-hl`, `diff-add-gutter`, `diff-add-fg` and `del` equivalents — alphas are
baked in, use them verbatim (e.g. `bg-diff-add-bg`), never re-tint.

### Motion

Durations: `--duration-fast` 100ms (color shifts) · `--duration-base` 140ms (default) ·
`--duration-med` 180ms (expand/collapse, popovers) · `--duration-slow` 260ms (dialogs).
Easing: `ease-out` (`cubic-bezier(0.22,1,0.36,1)`) for everything entering/expanding;
`ease-in-out` for anything reversible mid-flight. Named animations: `animate-fade-slide-in`,
`animate-fade-in`, `animate-pulse-soft`, `animate-shimmer`, `animate-spin`.

---

## 4. Typography

UI font: Inter/system (`font-sans`). Mono: `font-mono` (SF Mono stack). Semantic scale:

| Class | px | Role |
|---|---|---|
| `text-2xs` | 11 | Statusbar, badges, kbd chips, diff line numbers |
| `text-xs` | 12 | Field labels, sidebar metadata, tab labels, tool card meta (duration) |
| `text-sm` | 13 | **UI default** (body of app chrome) and **all mono/code** |
| `text-base` | 14 | Transcript prose (user + assistant markdown) — nothing else |
| `text-lg` | 16 | Pane titles, dialog titles, settings section headers |
| `text-xl` | 18 | Empty-state headings only |

Weights: 400 body, 450–500 (`font-medium`) labels/titles, 600 (`font-semibold`) dialog titles and
empty-state headings. Never 700+. Never uppercase-tracking labels except tiny group headers in
sidebar/palette (`text-2xs font-medium uppercase tracking-wider text-fg-muted`).

Markdown in transcript: headings max `1.125em`, semibold, `text-fg`; inline code
`bg-inset px-1 py-px rounded-xs text-[0.9em]`; links `text-accent` underline on hover only;
blockquotes 2px `border-l-border-strong` + `text-fg-secondary`. Code blocks: `bg-inset`
`border-border-subtle` `rounded-lg`, header row 28px with language label (`text-2xs
text-fg-muted`) and copy button revealed on hover; shiki-highlighted body, `p-3`, horizontal
scroll (never wrap).

Numbers that update live (token counts, durations) get `tabular-nums`.

---

## 5. Layout chrome

Grid: left sidebar (sessions) · center transcript+composer · right dock (dockview tabs:
inspector/files/timeline/snapshots/diff) · bottom dock (terminal) · 24px statusbar. Titlebar is
part of `canvas` with `.app-region-drag`; all buttons inside it `.app-region-no-drag`.

- Panel chrome: docks sit on `bg-surface` separated from canvas by 1px `border-border-subtle`.
  No double borders — the divider between two panels is one line.
- Dockview tabs: 32px tall, `text-xs text-fg-muted`, active tab `text-fg` with 1px `bg-accent`
  underline (2px looks heavy at this size). No tab backgrounds.
- Sidebar: 260px default (200–360 resizable), collapsible to 0.
  - Project group header row 28px: `text-2xs uppercase tracking-wider text-fg-muted`.
  - Session row 44px, `rounded-md`, two lines: title (`text-sm text-fg-secondary`, active
    `text-fg font-medium`) + meta line (`text-xs text-fg-muted`: relative time · model).
    Left edge: 6px `.status-dot` — `bg-success animate-pulse-soft` while the agent is running in
    that session, `bg-fg-faint` idle, `bg-warn` pending approval. Selected row: `bg-raised`;
    hover: `bg-raised/60`. NO accent bar on selection — the dot + lightness carries it.
  - Archived sessions live in a collapsed group at the bottom, rows at 60% opacity.
- Statusbar: 24px, `bg-canvas border-t border-border-subtle`, `text-2xs text-fg-muted`,
  `tabular-nums`. Left: connection (dot + profile name) · session status. Right: model ·
  thinking level · context/token usage. Connection dot maps `BridgeConnectionState`:

  ```ts
  /** src/shared/bridge.ts — verbatim */
  export type BridgeConnectionState =
    | "connecting"
    | "connected"
    | "reconnecting"
    | "closed";
  ```

  `connected` → `bg-success`; `connecting`/`reconnecting` → `bg-warn animate-pulse-soft`;
  `closed` → `bg-danger`. Statusbar items are hover targets (`hover:text-fg-secondary`) that open
  their popover/pane; no other interaction styling.

Session status (`@agena/protocol`, verbatim):

```ts
export type SessionStatus = "active" | "idle" | "archived";
```

---

## 6. Transcript

The center column uses `.transcript-column` (46rem clamp — defined in theme.css; use the class,
don't re-declare widths). Virtualized (`@tanstack/react-virtual`). Background: `canvas`.

**Message layout — no avatars, no chat bubbles.**

- **User message**: a quiet block — `bg-surface border border-border-subtle rounded-lg px-4 py-3`,
  `text-base text-fg`. No "You" label (the card shape IS the label). Attachments as chips inside.
- **Assistant message**: bare prose directly on canvas, `text-base`, markdown rules from §4.
  No container, no border. Tool cards interleave between prose blocks at full column width.
- **Reasoning/thinking**: collapsed by default into a 28px disclosure row: chevron +
  "Thinking" label (`text-xs text-fg-muted`; `.shimmer-text` while streaming) + duration when
  done. Expanded body: `text-sm text-fg-muted`, 2px `border-l-border` inset `pl-3`, markdown
  muted (headings/links inherit muted color).
- Block spacing: 20px (`gap-5`) between turns, 12px (`gap-3`) between blocks within a turn.
- Timestamps: none inline. Hovering a turn reveals a right-aligned `text-2xs text-fg-faint`
  time + copy button row (opacity 0 → 1, 100ms).

**Streaming rules (absolute):**

- Streamed text renders instantly as it arrives. **Never** animate tokens (no fades, no
  typewriter easing, no per-word transitions). The ONLY streaming indicators are the
  `.stream-caret` after the last text node and `.shimmer-text` on in-progress labels.
- Settled blocks are memoized with stable identity; a streaming tail must never cause earlier
  blocks to re-render or shift. Width is clamped by `.transcript-column` — text must never
  reflow horizontally when the caret appears/disappears.
- Auto-follow: pinned to bottom while streaming; any upward user scroll unpins; a "Jump to
  latest ↓" pill (`bg-overlay border-border shadow-md rounded-full text-xs`, bottom-center,
  `animate-fade-slide-in`) re-pins. Programmatic scrolls use `behavior: "instant"` while
  streaming — smooth-scroll fights the stream and causes jitter.
- New blocks entering the transcript get `animate-fade-slide-in` ONCE on mount. Never re-animate
  on state change, re-render, or scroll re-mount by the virtualizer (guard: animate only when the
  block's event is newer than mount time).

### Composer

`bg-surface border border-border rounded-2xl` at the bottom of the column, focus:
`border-accent/50` (no ring — border shift only). Textarea `text-base`, min 44px, autogrow to
40vh. Bottom row inside: model + thinking-level selectors as ghost chips (left), send button
(right): `bg-accent text-accent-fg rounded-md size-7` icon button; morphs to a stop button
(`bg-danger/10 text-danger`) while a run is active. Attachment/slash affordances are `fg-muted`
icon buttons on the left.

---

## 7. Tool cards

The signature component. Get this perfect.

The protocol event payloads (from `@agena/protocol` `events.ts`, verbatim):

```ts
export type ToolCallStarted = {
  toolCallId: string;
  messageId: string;
  runId: string;
  turnId: string;
  name: string;
  args?: unknown;
  runtimeToolCallId?: string;
};

export type ToolCallCompleted = {
  toolCallId: string;
  result: ContentBlock[];
  durationMs: number;
};

export type ToolCallFailed = {
  toolCallId: string;
  error: { code: string; message: string };
  partialOutput?: ContentBlock[];
  durationMs?: number;
};

export type ToolCallAborted = {
  toolCallId: string;
  partialOutput: ContentBlock[];
  reason: "user_abort" | "daemon_shutdown" | "daemon_restart" | "runtime_error";
};

export type ToolCallDenied = {
  toolCallId: string;
  approvalId?: string;
  reason: "user_denied" | "approval_expired" | "policy" | "hook_denied";
};
```

UI visual state union (define in the transcript feature, exactly this):

```ts
export type ToolVisualState =
  | "pending"   // approval requested for this call, not yet answered
  | "running"   // tool.call.started, no terminal event yet
  | "success"   // tool.call.completed
  | "error"     // tool.call.failed
  | "aborted"   // tool.call.aborted
  | "denied";   // tool.call.denied
```

| State | Status glyph (16px, left) | Name treatment | Meta (right) |
|---|---|---|---|
| pending | `CircleDashed` `text-tool-pending` | `text-fg-secondary` | "waiting for approval" `text-warn` |
| running | `Loader2` `animate-spin text-tool-running` | `.shimmer-text` | live elapsed time, `tabular-nums` |
| success | `Check` `text-tool-success` | `text-fg-secondary` | `durationMs` formatted (`1.2s`) `text-fg-muted` |
| error | `X` `text-tool-error` | `text-fg-secondary` | `error.code` `text-danger` |
| aborted | `Ban` `text-tool-aborted` | `text-fg-muted` | reason ("stopped") `text-fg-muted` |
| denied | `ShieldX` `text-tool-denied` | `text-fg-muted` | reason ("denied") `text-warn` |

**Collapsed row (default for success/aborted/denied; everything starts collapsed except error):**
single 32px row, full column width — `rounded-lg border border-border-subtle bg-surface px-3`,
containing: status glyph · tool name in `font-mono text-sm` · one-line summary of the primary
argument (`text-fg-muted font-mono text-sm`, middle-truncated — e.g. the command for bash, the
path for edits, the pattern for grep) · right-aligned meta · chevron (`text-fg-faint`, rotates
180° in 140ms when expanded). Hover: `bg-raised/60`. The whole row is the toggle button.

- Error cards auto-expand and get `border-danger/35`.
- Running cards get `border-accent/35`. No other state colors the border.

**Expanded body:** separated by `border-t border-border-subtle`, `p-3`, `space-y-3` on
`bg-surface`. Sections, each with an 11px header (`text-2xs uppercase tracking-wider
text-fg-muted mb-1`):

1. **Input** — args in a `bg-inset rounded-md p-2.5 font-mono text-sm` well; shiki JSON (or
   language-appropriate: bash for commands, diff preview for edits). Max-height 240px,
   scroll inside.
2. **Output / Error** — same well; for `error` the well is `bg-danger/10 text-danger` with
   `error.message` above any `partialOutput`. Streaming tool output appends with NO animation;
   well auto-scrolls to bottom until user scrolls up (same pin rule as transcript). Max-height
   320px.

Expand/collapse animates height 180ms `ease-out` (grid-template-rows trick or measured height —
never `height: auto` jumps) plus `animate-fade-in` on the body content. Collapse is 140ms.

Consecutive same-tool success cards (e.g. 5 greps) render as one stacked group: first row normal,
subsequent rows flush (`border-t` only, no gap), sharing outer border/radius.

---

## 8. Approvals

The **approval banner** is a distinct block pinned inline in the transcript at the point of the
requesting tool call (not a floating modal — the user must see context):

- Container: `rounded-lg border border-warn/35 bg-warn/10 p-3`, `animate-fade-slide-in`.
- Header row: `ShieldAlert size-4 text-warn` · title `text-sm font-medium text-fg`
  ("Approve `bash`?") · countdown if the approval expires (`text-xs text-warn tabular-nums`).
- Subject: the command/path/diff being approved in a `bg-inset rounded-md p-2.5 font-mono text-sm`
  well (same well spec as tool cards). Show the FULL subject — never truncate what the user is
  approving; scroll if long (max-height 320px).
- Action row, right-aligned, `gap-2`: **Deny** (ghost: `text-fg-secondary hover:bg-fg/6
  rounded-md h-7 px-3 text-sm`) · **Approve** (`bg-accent text-accent-fg` same size) · optional
  "Always allow" dropdown chevron attached to Approve. Keyboard: `Enter` approve / `Esc` deny /
  shortcuts shown as `.kbd` chips inside the buttons.
- While pending, the session row dot in the sidebar and a statusbar badge turn `bg-warn
  animate-pulse-soft`. When answered, the banner collapses (height 180ms) into the tool card's
  state.
- Multiple pending approvals: banners stack in transcript order; a `bg-warn text-2xs` count badge
  appears on the statusbar item; NO modal, ever.

---

## 9. Diff viewer

Right-dock pane, `@git-diff-view/react` skinned entirely by tokens:

- File header 36px: `bg-surface border-b border-border-subtle px-3`, filename `font-mono text-sm
  text-fg` (dirname `text-fg-muted`), right: `+n` `text-diff-add-fg` / `−n` `text-diff-del-fg`
  `text-xs tabular-nums`, split/unified toggle, expand-all.
- Code area on `bg-inset`, shiki syntax, mono `text-sm`, line numbers `text-2xs text-fg-faint`
  in gutters `bg-diff-add-gutter`/`bg-diff-del-gutter` for changed lines.
- Line backgrounds: `bg-diff-add-bg` / `bg-diff-del-bg`; word-level: `bg-diff-add-hl` /
  `bg-diff-del-hl`. No red/green text recoloring of code tokens — syntax colors stay, only
  backgrounds mark the change.
- Collapsed unchanged regions: 24px row `bg-surface text-fg-muted text-xs` centered
  "⋯ 34 unchanged lines" — click expands (no animation; instant, it's a data reveal).
- Multi-file: vertical stack, sticky file headers. File list rail (if shown) uses sidebar row
  spec at 28px with per-file +/− counts.

## 10. Terminal

Bottom dock. xterm mounts on `bg-inset` with 12px padding, no inner border. Build the theme
object from tokens at mount + on theme change:

```ts
const css = getComputedStyle(document.documentElement);
const v = (name: string) => css.getPropertyValue(name).trim();
const xtermTheme = {
  background: v("--term-bg"), foreground: v("--term-fg"),
  cursor: v("--term-cursor"), selectionBackground: v("--term-selection"),
  black: v("--term-ansi-black"), red: v("--term-ansi-red"),
  green: v("--term-ansi-green"), yellow: v("--term-ansi-yellow"),
  blue: v("--term-ansi-blue"), magenta: v("--term-ansi-magenta"),
  cyan: v("--term-ansi-cyan"), white: v("--term-ansi-white"),
  brightBlack: v("--term-ansi-bright-black"), brightRed: v("--term-ansi-bright-red"),
  brightGreen: v("--term-ansi-bright-green"), brightYellow: v("--term-ansi-bright-yellow"),
  brightBlue: v("--term-ansi-bright-blue"), brightMagenta: v("--term-ansi-bright-magenta"),
  brightCyan: v("--term-ansi-bright-cyan"), brightWhite: v("--term-ansi-bright-white"),
};
```

(`--term-*` values are identical in both themes by design — the terminal is always dark.)
Terminal tabs reuse the dockview tab spec. PTY output writes straight to xterm — never through
React state, never animated.

## 11. File tree

28px rows, `rounded-md`, indent 12px/level with a `border-l border-border-subtle` guide line per
depth. Folder chevron `text-fg-faint` rotates 90° (140ms). Name `text-sm text-fg-secondary`;
selected row `bg-raised text-fg`; git-status dot on the right (`bg-success` added, `bg-warn`
modified, `bg-danger` deleted/conflict). No file-type icon library — a single `File`/`Folder`
lucide glyph, `text-fg-muted`.

## 12. Command palette

cmdk inside a centered overlay: `w-[560px] max-h-[400px] bg-overlay border border-border
rounded-xl shadow-overlay`, top-aligned at 20vh. Backdrop `bg-canvas/60` (no blur — blur is
banned app-wide; it smears text on external displays). Enter: `animate-fade-in` on backdrop +
scale 0.98→1 with fade, 180ms `ease-out`, transform-origin top. Exit: fade 100ms, no scale.

- Input row 48px, `text-base`, no border, `border-b border-border-subtle`, placeholder
  `text-fg-muted`. No search icon — the caret is enough.
- Results: 32px rows `rounded-md mx-1.5`, icon `text-fg-muted` + title `text-sm` + group label
  right (`text-2xs text-fg-faint`) + shortcut as `.kbd` chips. Active row `bg-raised text-fg`
  (arrow keys move instantly, no animation).
- Group headers: `text-2xs uppercase tracking-wider text-fg-muted px-3 pt-2 pb-1`.
- Empty: single centered line `text-sm text-fg-muted`, "No commands match".

## 13. Settings (incl. MCP / skills)

Settings is a dialog-sized surface (`bg-surface rounded-xl border border-border shadow-overlay`,
880×600) with a left nav (160px: `text-sm` rows, spec identical to sidebar rows at 28px) and a
scrollable content pane (`p-6`, `max-w-[560px]` content column).

- Section header: `text-lg font-semibold` + one-line description `text-sm text-fg-muted`,
  `mb-4`.
- Fields: label above (`text-xs font-medium text-fg-secondary mb-1`), control below. Inputs:
  `h-8 bg-inset border border-border rounded-md px-2.5 text-sm`, focus `border-accent/50`.
  Toggles: radix switch, 32×18, checked `bg-accent`, unchecked `bg-fg/15`.
- MCP servers / skills: card-per-item lists — `border border-border-subtle rounded-lg p-3`
  rows with name (`text-sm font-medium`), detail line (`text-xs text-fg-muted font-mono`),
  right side: status badge + overflow menu. Status badge: `.status-dot` + `text-2xs` label —
  `ready`/`imported` → `bg-success`; `update_available` → `bg-info`; `needs_authorization` →
  `bg-warn`; `error` → `bg-danger` with the error message underneath in `text-xs text-danger`.
- Destructive actions (delete server/skill/project) always: ghost `text-danger
  hover:bg-danger/10` button + confirm popover (never window.confirm).

## 14. Toasts & empty states

- Toasts: bottom-right stack, `w-[340px] bg-overlay border border-border rounded-lg shadow-lg
  p-3`, icon by kind (`info`/`success`/`warn`/`danger` tokens), title `text-sm font-medium`,
  detail `text-xs text-fg-muted`. Enter `animate-fade-slide-in`; exit fade 140ms. Max 3 visible.
  Toasts NEVER contain actions other than one optional "View" link — decisions belong in
  approvals/dialogs.
- Empty states (no session selected, empty pane, zero MCP servers): centered, one lucide icon
  `size-8 text-fg-faint`, heading `text-xl font-semibold text-fg-secondary`, one sentence
  `text-sm text-fg-muted`, and at most one action (primary button or `.kbd`-annotated hint like
  "Press ⌘K"). Max width 320px. No illustrations, no multi-step onboarding copy.

## 15. Motion — what animates, what never does

Animates (once, on the listed trigger):
- Block/banner/toast mount → `animate-fade-slide-in` (180ms).
- Expand/collapse (tool cards, reasoning, sidebar groups) → height 180ms `ease-out` + content
  fade; collapse 140ms.
- Popover/menu/palette enter → fade + 0.98 scale, 180ms; exit fade 100ms.
- Hover/active color shifts → 100ms.
- Chevron rotations → 140ms.
- Continuous, whitelisted only: `animate-spin` (running spinner), `animate-pulse-soft`
  (status dots for running/pending, stream caret), `animate-shimmer` (running labels).

Never animates:
- **Streaming text and terminal output. No token fades, no typewriter effects, no smooth
  scroll while streaming, no layout that shifts as text arrives.** (Repeated because it is the
  most common way to ruin this class of app.)
- Layout: pane resize, sidebar width, dock drag — always direct manipulation, zero transition.
- Lists reordering/filtering (palette results, file tree, session list) — instant.
- Anything on scroll. No parallax, no scroll-linked effects, no scroll-triggered reveals.
- Diff expand-unchanged, tab switches, theme switches (theme flips instantly; suppress
  transitions during the flip like openchamber's `oc-theme-switching` if flashing is observed).

`prefers-reduced-motion` is already handled globally in theme.css — write no per-component code
for it.

## 16. Primitive kit (foundation-ui) quick spec

Buttons (heights: `h-7` default, `h-8` in settings forms, `h-6` inline): primary
`bg-accent text-accent-fg hover:bg-accent-hover rounded-md px-3 text-sm font-medium`; secondary
`bg-raised border border-border hover:border-border-strong`; ghost `text-fg-secondary
hover:bg-fg/6`; danger-ghost `text-danger hover:bg-danger/10`. Icon buttons square, same
heights. Tooltips: `bg-overlay border border-border rounded-md px-2 py-1 text-xs shadow-md`,
delay 500ms, instant for siblings. Menus/popovers (radix): `bg-raised border border-border
rounded-lg shadow-md p-1`, items = 28px `rounded-md px-2 text-sm` rows, destructive items
`text-danger`. Badges: `text-2xs rounded-full px-1.5 py-px` on `/10` washes with matching text
token.
