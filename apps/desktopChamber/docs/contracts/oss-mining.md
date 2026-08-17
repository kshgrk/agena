# OSS Mining Contract — desktopNew

This doc is the builder's guide to the verbatim OSS copies under
`apps/desktopChamber/docs/oss/`. Read `docs/oss/LICENSES.md` first — it lists
provenance (repo, commit, license) and the attribution header you MUST add to
any desktopNew file adapted from these copies.

Two sources:

- `docs/oss/ai-elements/` — Vercel ai-elements (Apache-2.0), copy-paste shadcn
  components for AI chat UIs. Pulled from `packages/elements/src/` at commit
  `0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b`.
- `docs/oss/openchamber/` — OpenCode desktop/web UI (MIT). Pulled at commit
  `0311d2dcb2d12278a0523f7eaa55d299229ad4cd`.

A third repo, **claudecodeui, is AGPL — DO NOT copy any code from it, ever.**
Two of its ideas are described in prose at the bottom; re-implement from the
prose only.

---

## Global adaptation rules for ai-elements files

Every ai-elements file shares the same assumptions. Fix these uniformly:

1. **shadcn/ui imports.** They import from `@repo/shadcn-ui/components/ui/*`
   (badge, button, collapsible, alert, card, scroll-area, select, hover-card,
   avatar, input-group) and `cn` from `@repo/shadcn-ui/lib/utils`. desktopNew
   must have local shadcn components at `src/components/ui/*` and the standard
   `cn()` util (`clsx` + `tailwind-merge`). Rewrite import paths; component
   APIs are stock shadcn, no other change needed.
2. **`"ai"` package types.** Several files import types from Vercel's `ai`
   package: `ToolUIPart`, `DynamicToolUIPart`, `UIMessage`, `ChatStatus`,
   `FileUIPart`, `SourceDocumentUIPart`, `LanguageModelUsage`. desktopNew does
   NOT depend on `ai`. Replace these with our own protocol types (the daemon
   event/message types defined in the desktopNew protocol contract). The
   structural expectations are documented per-file below — match those shapes.
3. **Tailwind.** All styling is Tailwind utility classes using shadcn semantic
   tokens (`text-muted-foreground`, `bg-background`, `border`, etc.). Keep the
   class strings; make sure our Tailwind theme defines the same semantic
   variables (see the openchamber CSS section — we mine our tokens from there).
4. **`"use client"` directives** are Next.js artifacts. Harmless in Vite;
   delete them.
5. **Optional deps.** Some files pull `streamdown` (+ `@streamdown/*` plugins),
   `use-stick-to-bottom`, `shiki`, `ansi-to-react`, `lucide-react`,
   `@radix-ui/react-use-controllable-state`, `motion`, `tokenlens`. Per-file
   notes below say which to keep and which to strip.
6. **Compound-component pattern.** Every ai-elements file exports a family of
   small components (`Tool`, `ToolHeader`, `ToolContent`, ...) sharing state
   via React context, each accepting `className` merged with `cn()`. Keep this
   pattern — it is the house style for desktopNew presentation components.

### The `ToolUIPart` shape (referenced everywhere)

ai-elements code treats a tool part as (verbatim from `tool.tsx`):

```ts
export type ToolPart = ToolUIPart | DynamicToolUIPart;
// state is one of:
// "approval-requested" | "approval-responded" | "input-available" |
// "input-streaming" | "output-available" | "output-denied" | "output-error"
// plus fields: input (unknown), output (ReactNode | object), errorText (string)
// type is `tool-${toolName}` (ToolHeader derives display name via
// type.split("-").slice(1).join("-")), or "dynamic-tool" with explicit toolName.
```

When adapting, map the daemon's tool lifecycle onto these seven states — the
status badges/icons in `tool.tsx` and the approval flow in `confirmation.tsx`
key off them.

---

## ai-elements file inventory (`docs/oss/ai-elements/`)

### tool.tsx
Collapsible tool-call card: `Tool` (Collapsible root) + `ToolHeader` (wrench
icon, tool name, status badge) + `ToolContent` + `ToolInput` (renders `input`
as JSON in a `CodeBlock`) + `ToolOutput` (renders `output` or `errorText`).
Adapt: replace `ToolUIPart`/`DynamicToolUIPart` from `"ai"` with our tool-part
protocol type; keep the seven-state badge map verbatim (see shape above).
Use for: every tool call rendered in the chat transcript. Verbatim
header-props shape worth keeping:

```ts
export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | { type: DynamicToolUIPart["type"]; state: DynamicToolUIPart["state"]; toolName: string }
);
```

### confirmation.tsx
Approval/permission UI for a tool call: `Confirmation` (Alert wrapper holding
`{ approval, state }` in context), `ConfirmationTitle`, `ConfirmationRequest`
(shown while `state === "approval-requested"`), `ConfirmationAccepted`/
`ConfirmationRejected` (shown after response), `ConfirmationActions`/`ConfirmationButton`.
The approval discriminated union (verbatim):

```ts
type ToolUIPartApproval =
  | { id: string; approved?: never; reason?: never }
  | { id: string; approved: boolean; reason?: string }
  | undefined;
```

Adapt: swap `ToolUIPart["state"]` for our tool state union; wire
`ConfirmationButton` onClick to the daemon permission-reply RPC. Use for: the
permission-prompt cards (Bash approval, file-write approval) in the transcript.

### reasoning.tsx
Collapsible "Thinking" block that auto-opens while streaming and auto-closes
1s after streaming ends (`AUTO_CLOSE_DELAY = 1000`), tracks elapsed thinking
`duration` (controllable or self-timed), renders body through `Streamdown`.
Props (verbatim):

```ts
export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};
```

Adapt: keep auto-open/auto-close logic verbatim (it handles the "opened during
stream vs user-toggled" distinction carefully); replace `Streamdown` with our
markdown renderer if we don't adopt streamdown. Uses
`@radix-ui/react-use-controllable-state` — keep that dep, it's tiny.
Use for: extended-thinking blocks in assistant messages.

### code-block.tsx
Shiki-based syntax highlighting with a two-phase render: instant fallback
tokens synchronously, then async highlighted tokens swapped in — no flash on
streaming code. Includes `CodeBlockCopyButton` and a language selector. Root
props (verbatim):

```ts
type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;   // from "shiki"
  showLineNumbers?: boolean;
};
```

Adapt: keep shiki (`createHighlighter`) and the async token machinery; it uses
themes for light/dark — point them at our theme pair. Discard the language
selector subcomponents if the transcript never switches languages. Use for:
all code rendering — tool inputs, file snippets, markdown code fences.

### terminal.tsx
Terminal-styled output panel with ANSI color support (`ansi-to-react`),
auto-scroll-while-streaming, copy and clear buttons, and a blinking cursor
while streaming. Props (verbatim):

```ts
export type TerminalProps = HTMLAttributes<HTMLDivElement> & {
  output: string;
  isStreaming?: boolean;
  autoScroll?: boolean;
  onClear?: () => void;
};
```

Adapt: keep `ansi-to-react` (Bash output is ANSI-heavy). Use for: Bash/exec
tool output inside tool cards and any bottom terminal dock.

### conversation.tsx
Chat scroll container built on `use-stick-to-bottom`: `Conversation`
(StickToBottom root, `role="log"`), `ConversationContent`,
`ConversationEmptyState`, `ConversationScrollButton` (floating "scroll to
bottom" that appears via `useStickToBottomContext().isAtBottom`), and
`ConversationDownload` (export messages as JSON file). Adapt: keep
`use-stick-to-bottom` as a dependency — do not hand-roll scroll pinning;
`ConversationDownload` takes `UIMessage[]` from `"ai"`, retype to our message
type or discard. Use for: the main transcript scroll area.

### message.tsx
Message row: `Message` (from-user/from-assistant variants with group data
attrs), `MessageContent`, `MessageActions`/`MessageAction` (icon buttons with
tooltip), `MessageBranch`* family (branch navigation: previous/next/page
counter for regenerated messages), `MessageResponse` (Streamdown markdown
rendering with cjk/code/math/mermaid plugins). Adapt: retype `UIMessage`;
decide on streamdown vs our own markdown pipeline once, here — `MessageResponse`
is the single markdown entry point. Discard `MessageBranch*` if desktopNew v1
has no message branching. Use for: user/assistant message chrome in the
transcript.

### prompt-input.tsx
The big one (38K): full chat composer — auto-growing textarea, submit button
with status-aware icon (submit/stop/retry keyed on `ChatStatus`:
`"submitted" | "streaming" | "ready" | "error"`), attachment handling
(add/remove `FileUIPart`s, drag-drop, paste), model-select and tool-toggle
slots, keyboard handling (Enter submits, Shift+Enter newline). Adapt: retype
`ChatStatus`, `FileUIPart`, `SourceDocumentUIPart` to our protocol; strip the
speech-input hooks if present. Use for: the composer at the bottom of the
session view; this replaces hand-rolling the hardest interaction surface in
the app.

### plan.tsx
Collapsible plan card (Card + Collapsible): `Plan` with
`isStreaming` context, `PlanHeader`/`PlanTitle`/`PlanDescription` (shimmer
while streaming), `PlanContent`, `PlanFooter`, `PlanTrigger`. Adapt: swap its
Shimmer import to our copy of shimmer.tsx; content is free-form children.
Use for: plan-mode proposals from the agent (render plan markdown inside,
approve/reject buttons in `PlanFooter`).

### task.tsx
Compact collapsible task/subagent progress widget: `Task` (Collapsible),
`TaskTrigger` (title + search icon + chevron), `TaskContent`, `TaskItem`, and
`TaskItemFile` (inline file chip). Adapt: nothing structural — retype nothing,
it's all `ComponentProps`. Use for: subagent/Task tool progress ("Searching
codebase…", file-touched list) in the transcript.

### file-tree.tsx
Controlled/uncontrolled file tree: `FileTree` root holds
`expanded: Set<string>` + `selectedPath` context, `FileTreeFolder` (recursive,
collapsible, indent by depth), `FileTreeFile`, `FileTreeIcon`, `FileTreeName`,
`FileTreeActions`. Root props (verbatim):

```ts
export type FileTreeProps = Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> & {
  expanded?: Set<string>;
  defaultExpanded?: Set<string>;
  selectedPath?: string;
  onSelect?: (path: string) => void;
  onExpandedChange?: (expanded: Set<string>) => void;
};
```

Adapt: as-is; feed it from the daemon's project file listing. Use for: the
project file sidebar and changed-files pickers.

### shimmer.tsx
Animated text shimmer (motion-based gradient sweep) for loading/streaming
labels. Props (verbatim):

```ts
export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}
```

Adapt: requires the `motion` package; if we don't take motion, replace with a
pure-CSS keyframe gradient (openchamber's `MinDurationShineText` idea). Use
for: "Thinking…", "Running tool…" status labels.

### queue.tsx
Queued-messages UI: `Queue`/`QueueList`/`QueueItem` with indicator (numbered
or completed-check), content (truncated 2-line text), attachments
(image/file chips), per-item actions, and collapsible `QueueSection` with
count badge. Defines its own protocol-free types (verbatim):

```ts
export interface QueueMessagePart {
  type: string; text?: string; url?: string; filename?: string; mediaType?: string;
}
export interface QueueMessage { id: string; parts: QueueMessagePart[]; }
export interface QueueTodo {
  id: string; title: string; description?: string; status?: "pending" | "completed";
}
```

Adapt: as-is. Use for: the message-queue feature (messages typed while the
agent is busy, shown as pending chips above the composer).

### chain-of-thought.tsx
Vertical step timeline (dot + connector line) for agent progress:
`ChainOfThought` (open-state context), `ChainOfThoughtHeader`,
`ChainOfThoughtStep` with `status?: "complete" | "active" | "pending"`,
`ChainOfThoughtSearchResults`/`SearchResult` badges, `ChainOfThoughtImage`.
Adapt: as-is. Use for: multi-step turn progress (alternative/complement to
task.tsx for long agent turns).

### context.tsx
Token-usage HUD: circular progress icon + hover card breaking down
input/output/reasoning/cache token usage and estimated cost. Core schema
(verbatim):

```ts
interface ContextSchema {
  usedTokens: number;
  maxTokens: number;
  usage?: LanguageModelUsage;  // from "ai" — retype to our usage shape
  modelId?: ModelId;           // string
}
```

Adapt: it uses `tokenlens` (`getUsage`) for cost estimation — replace with our
own per-model pricing map or drop cost rows; retype `LanguageModelUsage` to
our daemon's usage payload (`{ inputTokens, outputTokens, reasoningTokens?, cachedInputTokens? }`).
Use for: context-window meter in the session header.

### checkpoint.tsx
Tiny (1.6K) horizontal separator with flag icon + trigger button, marking a
restorable point in the conversation. Adapt: as-is; wire `CheckpointTrigger`
to session revert/fork. Use for: checkpoint/revert markers in the transcript.

### commit.tsx
Collapsible git commit card: hash (copyable), message, author avatar,
relative timestamp, and per-file rows with status letter (A/M/D/R),
+additions/−deletions counts. Adapt: as-is; feed from daemon git events. Use
for: rendering commits the agent makes.

### stack-trace.tsx
Parses raw error/stack-trace text into a structured collapsible view (error
type extracted from `"ErrorType: message"` format), with copy button. Adapt:
as-is. Use for: error tool results and daemon error events.

### test-results.tsx
Test-run summary card: pass/fail/skip counts, duration, progress bar, and
collapsible per-suite breakdown (`TestSuite`, `TestSuiteName`,
`TestSuiteStats`). Adapt: as-is; parse from test-runner tool output. Use for:
rendering test-run results richly. Optional — skip in v1 if no structured
test output exists.

### attachments.tsx
Attachment display for composer and messages: grid/inline/list variants,
media-category detection (image/audio/video/document), preview thumbnails,
hover card, remove button. `AttachmentData` is `FileUIPart | SourceDocumentUIPart`
from `"ai"` — retype to our attachment shape (`{ url, filename?, mediaType? }`
covers it). Use for: image/file attachments in the composer and in sent
messages.

### sources.tsx / suggestion.tsx / snippet.tsx
Small utilities: `Sources` (collapsible "Used N sources" citation list),
`Suggestions` (horizontal scroll row of pill buttons with `onClick(suggestion)`),
`Snippet` (inline copyable command line, input-group styled). Adapt: as-is.
Use for: web-search tool citations; suggested prompts on the empty session
screen; copyable CLI commands in onboarding/settings.

---

## openchamber file inventory (`docs/oss/openchamber/`)

### event-pipeline.ts (from `packages/ui/src/sync/event-pipeline.ts`)
Reference implementation (31K, heavily commented) for the daemon event
transport: WS-preferred with SSE fallback (`transport: "auto" | "ws" | "sse"`),
heartbeat timeout detection, visibility-aware exponential backoff, and
per-directory event coalescing flushed on a frame budget. This is the design
document for desktopNew's WS client — port the mechanics, not the OpenCode
SDK specifics. Public contract (verbatim):

```ts
export type EventPipelineInput = {
  sdk: OpencodeClient
  onEvent: (directory: string, payload: Event) => void
  routeDirectory?: (directory: string, payload: Event) => string
  /** Called after stream reconnects (visibility restore or heartbeat timeout). */
  onReconnect?: () => void
  /** Called when the stream disconnects (heartbeat timeout, network error, or transport failure). */
  onDisconnect?: (reason: string) => void
  /** Called when transport switches (e.g. WS timeout → SSE fallback) without actual disconnection. */
  onTransportSwitch?: () => void
  transport?: "auto" | "ws" | "sse"
  heartbeatTimeoutMs?: number
  reconnectDelayMs?: number
  wsReadyTimeoutMs?: number
}

export type EventPipeline = {
  cleanup: () => void
  reconnect: (reason?: string) => void
}
```

Tuning constants worth keeping verbatim: `FLUSH_FRAME_MS = 33`,
`BACKPRESSURE_FLUSH_FRAME_MS = 200`, `BACKPRESSURE_MODE_MS = 10_000`,
`RETRY_BACKOFF_BASE_MS = 250`, `RETRY_BACKOFF_CAP_VISIBLE_MS = 5_000`,
`RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS = 60_000`,
`RETRY_BACKOFF_MAX_EXPONENT = 8`, `DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000`,
`DEFAULT_WS_READY_TIMEOUT_MS = 2_000`. Coalescing detail: streaming delta
events are keyed (`coalesced: Map<string, number>` mapping coalesce-key →
queue index) so a newer delta for the same part replaces the queued one
instead of appending; a full part snapshot drops all pending delta keys with
that part's prefix (see lines ~458-496). The header comment's rule matters:
the pipeline makes NO state-dependent validity decisions — that belongs in
the reducer. Use for: `desktopNew` daemon WS client (main-process or renderer),
replacing `OpencodeClient`/`Event` with our daemon SDK and event types.

### styles/index.css (from `packages/ui/src/index.css`)
The Tailwind v4 CSS entry point: `@import "tailwindcss"`, imports the other
style files, defines `@custom-variant dark (&:is(.dark *))`, KaTeX theming,
theme-switch transition suppression (`.oc-theme-switching`), and the macOS
vibrancy system (`data-oc-vibrancy` attrs making body/sidebar transparent over
a native NSVisualEffectView, with a "ready" flag to avoid transparency flash).
Adapt: copy the structure (single entry importing token files), the dark
custom-variant, and — if desktopNew wants native vibrancy — the whole
vibrancy block with `oc-` prefixes renamed. Discard KaTeX/fireworks bits.

### styles/design-system.css
THE design-token file — this is where openchamber's theme variables live. Two
parts: `@layer base` with `:root` (light) and `.dark` blocks defining shadcn
semantic tokens in oklch (`--background`, `--foreground`, `--card`,
`--primary`, `--muted`, `--destructive`, `--border`, `--ring`, `--sidebar-*`,
`--chart-1..5`, `--radius`) plus app-specific vars (`--oc-safe-area-*`,
`--oc-header-height`, scrollbar colors, `--padding-scale`, semantic type sizes
`--text-markdown: 0.9375rem`, `--text-code: 0.8125rem`, etc.); then a
`@theme inline` block (Tailwind v4) that maps those vars into Tailwind's
token namespace — including a full spacing-scale override where every
`--spacing-N` is `calc(base * var(--padding-scale, 1))` for global density
control. Adapt: take the whole structure, rename `--oc-*` to our prefix, and
restyle the palette (theirs is warm sand/orange). Use for: desktopNew's
`src/styles/` foundation; builders should not invent a token system.

### styles/typography.css
Semantic typography utility classes built on the `--text-*` variables from
design-system.css (markdown text, code, UI headers/labels, meta, micro).
Small (4.8K) — adapt nearly verbatim so font sizing is centralized. Use for:
consistent text sizing across transcript vs chrome.

### styles/mobile.css
31K of mobile adaptations, gated on `:root.mobile-pointer:not(.desktop-runtime)`
within `@media (max-width: 1024px)` — i.e. class-flag + media query, so
desktop-runtime windows never get mobile styles even when narrow. Defines
`--is-mobile`, `--font-scale: 0.9`, `.desktop-only`/`.mobile-only` utilities,
safe-area handling, touch target sizing. Adapt: mine the gating pattern and
safe-area/keyboard handling if desktopNew ever renders in a narrow window or
web build; skip wholesale import — it references many openchamber-specific
class names. Use for: responsive behavior reference only.

### components/SessionNodeItem.tsx (from `components/session/sidebar/`)
The session-list row (65K — read selectively): status dot/spinner per session
state, inline rename, hover actions, context menu (fork/archive/delete/copy
id), drag handle, nested worktree children, unread/attention markers, relative
timestamps. This is the visual reference for how a dense, information-rich
session row is composed with Tailwind + shadcn primitives. Adapt: do NOT port
wholesale — extract the row layout, status indicator, and hover-action
patterns into a much smaller component bound to our session store. Use for:
desktopNew session sidebar list items.

### components/MessageHeader.tsx (from `components/chat/message/`)
Small (4.9K) message header: role-based avatar/label, model name, timestamp
formatting, copy-message affordance. Clean example of openchamber's message
chrome. Adapt: retype its message-info props to our message type; combine
with ai-elements `message.tsx` (openchamber wins on visual polish, ai-elements
wins on structure). Use for: per-message header row in the transcript.

### components/AssistantTextPart.tsx (from `components/chat/message/parts/`)
Small (4.2K) renderer for one assistant text part: lazy markdown rendering,
streaming-aware visibility, fade-in on reveal. Shows the part-level rendering
granularity openchamber uses (message → parts → part components) — desktopNew
should adopt the same decomposition: a `MessageBody` that switches on part
type and delegates to per-part components. Use for: assistant text parts in
the transcript.

---

## claudecodeui patterns — PROSE ONLY (AGPL, zero code may be copied)

### 1. Config-driven tool rendering registry
claudecodeui renders every tool execution through a single
`ToolRenderer` driven by a central registry: one exported record mapping tool
name → a display config object. The config describes, declaratively: which of
two base display patterns to use for the tool's input (a compact one-line row
vs a collapsible panel, plus special modes like plan or hidden), an icon and
label, functions extracting the primary and secondary display strings from the
tool input, a click action (copy / open-file / jump-to-results / none), text
wrapping and a color scheme, and for collapsibles a title, default-open flag,
a content type tag (diff / markdown / file-list / todo-list / text / task /
question-answer) and a props-extractor; a parallel optional section describes
the tool result (hidden, hide-on-success, display type, message extractor).
Adding a new tool = adding one registry entry, no new conditionals in the
renderer. desktopNew should re-implement this idea from scratch: define our
own `ToolDisplayConfig`-style interface and a `TOOL_CONFIGS` registry keyed by
our daemon's tool names, with the ai-elements `tool.tsx` family as the
rendering substrate underneath.

### 2. The `--keyboard-height` visualViewport trick
For iOS Safari (and web/PWA builds generally): Android Chrome shrinks the
layout viewport when the virtual keyboard opens, so `inset-0` containers
adjust automatically — but iOS keeps the layout viewport full-height and
overlays the keyboard. claudecodeui listens to `window.visualViewport`'s
`resize` event only (deliberately NOT `scroll`, because on iOS scrolling
changes `visualViewport.offsetTop` and would make the value fluctuate and the
UI bounce), computes keyboard height as
`max(0, window.innerHeight - visualViewport.height)`, writes it to a CSS
custom property `--keyboard-height` on `document.documentElement`, and the
root app container is `position: fixed; inset: 0` with
`bottom: var(--keyboard-height, 0px)`. Re-implement from this description if
desktopNew ships a mobile/web surface; irrelevant for the Electron desktop
window.

---

## Suggested dependency set (derived from the mined files)

Keep: `lucide-react`, `use-stick-to-bottom`, `shiki`, `ansi-to-react`,
`@radix-ui/react-use-controllable-state`, `clsx` + `tailwind-merge` (for
`cn()`), shadcn/ui components (generated locally), Tailwind v4.
Decide once: `streamdown` (+ plugins) vs own markdown renderer — affects
message.tsx and reasoning.tsx. Optional: `motion` (only shimmer.tsx),
`tokenlens` (only context.tsx cost rows).
