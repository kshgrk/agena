# Agena UI revamp: source-level product-design and frontend-architecture report

**Research date:** 2026-08-08  
**Agena revision audited:** `eb83051bffcabff5b9babe05d9b2a44a2ebbb376` (`codex/persist-user-environment-imports`)  
**Scope:** read-only frontend/product investigation; no Agena code, dependencies, services, or external systems were changed.

> **Repository-evidence limitation.** The supplied path `/Users/kushagrakaushal/Desktop/Rough/agena` is not mounted in this environment. The connected GitHub repository exposes `apps/desktopNew` at the revision above, but that revision has no `apps/conductor`. Desktop findings below are line-verified against that revision. Mobile recommendations are source-backed by current external implementations—especially OpenChamber's React 19 + Capacitor 8 client—but the current Agena Conductor implementation could not be audited. Before implementation planning is finalized, rerun only the Conductor rows of section B against the local/current checkout.

## A. Executive verdict

### Verdict

Agena does **not** need a frontend rewrite. It needs a controlled shell/component refactor led by behavioral correctness, with a deliberately separate mobile presentation layer.

The current foundation is already unusually close to the right one:

- keep React 19, TypeScript, Vite, Tailwind 4, Zustand, Radix, Lucide, Dockview, TanStack Virtual, xterm.js, Shiki, `react-markdown`, and `@git-diff-view/react`;
- keep the `@agena/client` / `@agena/protocol` boundary and the durable-event/ephemeral-frame reduction model;
- keep one mounted workspace per open desktop session and the terminal objects outside React render state;
- refine, rather than replace, the existing Graphite & Iris semantic token layer;
- build a mobile shell that shares domain state, reducers, transcript primitives, and content renderers, but not Dockview or desktop navigation.

The recommended foundation is therefore **Agena-owned primitives over the dependencies already installed**, plus narrowly ported, attributed behavior from permissively licensed projects. No new component suite or chat framework is justified.

### Highest-value codebases to borrow from

1. **OpenChamber (MIT)** — the closest technical analogue: React 19, Capacitor 8, TanStack Virtual 3.14.5, desktop and dedicated mobile shells. Borrow its transcript anchoring/measurement-cache behavior and its mobile “chat + sessions surface + workspace surface” model, not its entire app.
2. **OpenCode (MIT)** — borrow its timeline projection/reconciliation, exact DOM-anchor hold, per-session measurement snapshots, and visual-stability/session-switch performance harnesses. Port behavior because its app is Solid, not React.
3. **assistant-ui (MIT)** — source-port only the small autoscroll intent state machine: distinguish user upward movement from content-driven movement, cancel pending follow on pointer input, and react to content resize. Do not install the framework.
4. **Vercel AI Elements (Apache-2.0)** — continue adapting small source recipes for tool, confirmation, attachment, context, and task presentation. Agena already uses this approach correctly.
5. **VS Code (MIT)** — interaction reference and selective source study for workbench focus, tree keyboard semantics, panes, commands, and persistent layout. Do not copy the whole workbench.

### Largest risks

1. **Transcript drift and remount behavior.** Current prepend restoration is index-aligned, not pixel/element anchored; variable Markdown, images, code, and expanding tool cards can move the user's reading position.
2. **Streaming render cost.** Every text delta creates new transcript state and reparses the active Markdown tail; tool deltas copy the block array. Long runs can make the UI feel progressively heavier.
3. **Desktop state leaking into mobile presentation.** Dockview, hover-only metadata, 11–13 px UI text, 28–32 px targets, fixed overlay positions, and side-by-side file panes are not a phone design.
4. **Two sources of layout truth.** Dockview and Zustand synchronize in both directions. It currently works, but future panes can introduce loops, stale visibility, or focus loss unless Dockview remains the sole desktop geometry owner.
5. **Native browser layering.** Electron `WebContentsView` renders above DOM overlays. The current global overlay counter is pragmatic but fragile; every new modal/sheet must participate.

### Explicitly do not replace

- daemon, event protocol, persistence, reconnect contract, Pi adapter, or client SDK;
- Dockview on desktop;
- TanStack Virtual with React Virtuoso—the existing version already exposes the needed anchoring and snapshot APIs;
- xterm.js or its direct byte path;
- Radix with React Aria/Base UI/Ariakit wholesale;
- `@git-diff-view/react` unless measured failures justify it;
- Shiki or the current async singleton highlighter;
- Graphite & Iris as a visual direction;
- the pure transcript event reducers.

## B. Current Agena UI audit

All links in this table are permalinks to the audited Agena revision.

| Surface | Current files/primitives | Main problems | Keep/refactor/replace | Evidence |
|---|---|---|---|---|
| Application shell | `app.tsx`; React; Zustand; Radix overlay hosts | A `max-width:900px` media query only hides the rail; that is responsive desktop, not a mobile shell. Native-browser visibility depends on every overlay being counted. | **Refactor** into shared boot/providers plus `DesktopShell` and `MobileShell`. | [boot, breakpoint, rail and overlays](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/app.tsx#L54-L170) |
| Desktop workbench | `shell/layout.tsx`; Dockview portals | Good geometry/persistence foundation. Dockview and UI store mirror inspector/browser/terminal visibility, which increases state-transition risk. Focus restoration is implicit rather than specified. | **Keep and refactor lightly**; Dockview owns geometry, store owns intent only. | [panel registry and placement](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/shell/layout.tsx#L102-L244), [restore/sync/persist](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/shell/layout.tsx#L248-L455) |
| Projects/sessions navigation | `features/sessions/sessions-rail.tsx`; Radix context menu; local UI state | Feature-rich but dense: projects/tasks, filter, groups, archived, subagents, create/delete dialogs in one ~1,100-line component. Collapse/expansion state is local and lost on remount. Row focus uses ordinary buttons rather than tree/list roving focus. | **Refactor** into selectors + `ProjectSection`, `SessionTree`, dialogs. Keep data/actions. | [session row and status](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/sessions/sessions-rail.tsx#L160-L312), [rail state and commands](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/sessions/sessions-rail.tsx#L316-L468) |
| Agent/subagent hierarchy | `sessions-rail.tsx`, `features/agents/task-group.tsx` | Parent/child state is derived by scanning loaded transcripts; hierarchy can be incomplete until relevant events are loaded. Active-agent summaries and child banners repeat similar status semantics. | **Refactor** to one memoized `AgentTreeProjection`, with desktop tree rows and mobile drill-down presentations. | [subagent receipt](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/agents/task-group.tsx#L162-L245), [active/child views](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/agents/task-group.tsx#L247-L315) |
| Tabs and split chat panes | Dockview session panels; one `SessionWorkspace` per `sessionId` | Strong: panel identity is session-stable and inactive panels normally remain mounted, preventing blank switches. Missing explicit split/open commands, focus history, and performance tests. Closing a panel destroys its local scroll state unless captured elsewhere. | **Keep**, add `Open beside`, split commands, focus restoration, and scroll snapshots. | [session panel identity/open](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/shell/layout.tsx#L50-L165) |
| Transcript viewport | `transcript-pane.tsx`; TanStack Virtual 3.14.5 | Correct stable keys, measurement, bottom pill, and pagination. Weaknesses: `estimateSize=64` is far below typical coding turns; initial bottom uses post-paint double RAF; prepend restores an index with `align:start`, not the prior element's pixel offset; no measurement snapshot cache; browser anchoring ownership is unspecified. | **Refactor critically**, keep TanStack Virtual. | [virtualizer and resize](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/transcript/transcript-pane.tsx#L99-L171), [prepend/follow logic](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/transcript/transcript-pane.tsx#L173-L235), [rendered rows and pill](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/transcript/transcript-pane.tsx#L286-L417) |
| Transcript state | `store/transcript.ts`; pure event/frame reducers; Zustand | Excellent event durability separation and malformed-event resilience. Each tool delta clones the whole `blocks` array; text deltas repeatedly concatenate strings; all loaded history remains resident. | **Keep reducers**, refactor streaming storage and add per-session cache limits/snapshots. | [event reduction](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/store/transcript.ts#L90-L353), [frame copying](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/store/transcript.ts#L385-L415), [paging](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/store/transcript.ts#L503-L598) |
| Message blocks | `blocks.tsx`; memoized settled rows; `react-markdown` | Good visual hierarchy. Hover-only time/copy actions are unavailable to touch and can be hard to discover by keyboard. Image content renders as a badge rather than an image. | **Refactor** metadata actions and attachments; keep block taxonomy. | [content and hover metadata](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/transcript/blocks.tsx#L47-L135), [assistant status/usage](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/transcript/blocks.tsx#L139-L171) |
| Streaming output | `tail.tsx`; in-flight row outside settled blocks | Correctly isolates the tail from settled-row memoization, but every token update reruns `react-markdown` over each streaming block. No batching/cadence boundary is visible. | **Refactor** to one update per animation frame and throttled Markdown parsing; authoritative final event replaces tail. | [tail rendering](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/transcript/tail.tsx#L10-L54) |
| Tool-call cards | `tool-card.tsx`; AI Elements-derived; ANSI parser; Shiki | Strong state language and bounded 400-line live view. Each running card starts a 1-second timer; live output still updates its parent transcript array; expanding content can perturb scroll. | **Keep/restyle**, isolate live tool output by `toolCallId`, notify viewport of size changes. | [state mapping and timer](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/transcript/tool-card.tsx#L77-L155), [bounded output/follow](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/transcript/tool-card.tsx#L157-L268) |
| Composer | `composer.tsx`; Zustand per-session drafts; Radix menus/cmdk model picker | Text-only despite product requirement for image prompts. Desktop key semantics are good; textarea max 40vh and 13/14 px surrounding controls need mobile-specific keyboard handling. Fast Mode is absent in this revision. | **Refactor** around shared send controller + separate desktop/mobile chrome. Add attachment strip and Fast Mode only if protocol already exposes them. | [draft and send controller](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/composer/composer.tsx#L41-L116), [input and controls](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/composer/composer.tsx#L319-L491) |
| Image attachments | Protocol content renderer only; no composer attachment control | Images are represented as a badge, not previewed; no file picker, paste/drop path, upload state, retry, remove, or alt text UI appears. | **Replace placeholder with a real shared attachment model and platform pickers.** | [image rendered as badge](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/transcript/blocks.tsx#L49-L78) |
| Model/thinking/Fast Mode | `composer.tsx`, `model-picker.tsx`; cmdk and Radix menu | Model search/grouping is appropriate. Thinking uses a flat menu; model changes are visually disabled during a run. No Fast Mode surface is present in the audited revision. | **Keep model picker**, consolidate all runtime controls into one `RunConfiguration` model and platform-specific presentation. | [runtime fetch and mutation](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/composer/composer.tsx#L158-L307), [control footer](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/composer/composer.tsx#L365-L435) |
| Status and usage footer | `shell/statusbar.tsx`, `shell/panes.ts` | Appropriate desktop location. Usage only finds the latest assistant block with totals; status-bar semantics should not be transplanted to phone. | **Keep desktop**, expose mobile usage in header metadata sheet. | [usage selector](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/shell/panes.ts#L66-L77) |
| Approvals | `approvals/card.tsx`, `approvals/pane.tsx`; Radix Dialog/Popover; derived pending store | Strong global queue and optimistic response flow. Up to three fixed banners can cover transcript content; fixed `top-12`, `w-96`, and hover-era density do not fit phones. `Y/N` global keys are safely scoped to confirm requests. | **Keep model/controller**, use desktop non-modal inbox + one banner; mobile bottom/full-screen review surface. | [global queue and routing](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/approvals/pane.tsx#L39-L69), [fixed banners/modal](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/approvals/pane.tsx#L221-L330) |
| Terminal | `terminal-store.ts`, `terminal-view.tsx`; xterm 6; fit/search/WebGL | Excellent direct byte path and object lifetime outside React. Desktop keyboard behavior is deliberate. Mobile needs a distinct full-screen presentation, 16 px default font, accessory keys, explicit PTY Escape handling, and visibility-driven fit/focus. | **Keep engine/store**, add platform presentation adapter. | [xterm creation/direct bytes](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/terminal/terminal-store.ts#L116-L217), [lifecycle/disposal](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/terminal/terminal-store.ts#L220-L290) |
| Files and code viewer | `files/pane.tsx`, `code-view.tsx`; TanStack Virtual; Shiki | Good lazy tree and stale-read guard. `role=tree` lacks full tree keyboard semantics/levels/set size; desktop fixed 240 px tree + viewer cannot compress to phone. Image preview is explicitly unimplemented. | **Refactor presentation**: desktop split remains; mobile tree → full-screen viewer drill-down. | [virtual tree](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/files/pane.tsx#L60-L195), [loading/viewer and split](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/files/pane.tsx#L220-L429) |
| Diff viewer | `diff/pane.tsx`; `@git-diff-view/react` | Correct keep candidate. Validate large-diff virtualization, keyboard navigation, copy, wrap, and mobile unified-only behavior. | **Keep**, mobile defaults to unified; split only on tablet/desktop. | [diff body/list/pane](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/diff/pane.tsx#L55-L198) |
| Search | `search/pane.tsx`; bridge search; local grouped results | Clear and race-aware, but results are unvirtualized and keyboard result navigation is not explicit. Jump assumes target history can be revealed elsewhere. | **Keep/refactor** keyboard listbox behavior and mobile full-screen presentation. | [search request/group/jump](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/search/pane.tsx#L30-L199) |
| Timeline | `timeline/pane.tsx`; ResizeObserver; pointer slider | Useful secondary navigator; small 2 px marks and crosshair/drag interaction are desktop-biased. Duplicates the user-message rail concept. | **Consolidate** timeline and user-message rail behind one `TranscriptNavigator`; desktop rail/inspector, mobile outline sheet. | [timeline brush](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/timeline/pane.tsx#L43-L216) |
| Snapshots | `snapshots/pane.tsx`; dialogs; typed restore confirmation | Sound destructive-action handling. Hover-revealed row actions need touch-visible equivalents; local component state is fine. | **Keep/refactor** row action disclosure and mobile sheet. | [snapshot states and confirmation](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/snapshots/pane.tsx#L48-L239), [pane list](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/snapshots/pane.tsx#L242-L393) |
| Embedded browser | `browser/pane.tsx/store.ts`; native Electron view | Necessary native solution. Bounds follow ResizeObserver/window scroll; overlay visibility is global. Desktop tabs/navigation are suitable. There is no verified Capacitor counterpart in this revision. | **Keep desktop**; mobile uses authenticated system/in-app browser, not Electron view emulation. | [bounds, visibility and chrome](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/browser/pane.tsx#L17-L181) |
| Settings/import | `settings/window.tsx` and section modules | Desktop two-column window is coherent but not mobile. The settings module already separates sections well enough to reuse content selectively. | **Refactor presentation**: desktop window; mobile navigation stack/pages. Keep import logic. | [settings window/navigation](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/settings/window.tsx#L81-L176) |
| Pairing | Not present in audited GitHub revision | Cannot audit QR permissions, camera flow, token storage, error recovery, or accessibility. | **Unverified; inspect `apps/conductor` before implementation.** | Repository revision contains no `apps/conductor`. |
| Errors/empty/loading/reconnect | App banner, feature-local `EmptyState`/`Spinner`, toast store | Good fail-soft philosophy but inconsistent locality and copy. Transcript can show a full skeleton while initial history is fetched, causing perceived disappearance. Toast viewport is fixed bottom-right. | **Consolidate** into semantic `AsyncBoundary` patterns; never replace previously rendered content with skeleton during refresh/reconnect. | [connection states](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/app.tsx#L40-L52), [transcript initial fill](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/features/transcript/transcript-pane.tsx#L173-L283) |
| Compaction/retries/failures | Transcript markers and assistant/tool status | Correctly durable, but compaction is a plain marker; repeated retry/failure events can create vertical noise and lose causal grouping. | **Refactor** into one collapsible run-status group per turn with latest state visible. | [compaction/failure reduction](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/store/transcript.ts#L283-L345) |

### Audit conclusion

The implementation is not “assembled” at the architectural level; it is assembled at the **presentation and behavioral-policy level**. The right move is to stabilize the transcript, consolidate repeated state language, then reshape the shell. Redesigning CSS first would hide rather than fix the real problems.

## C. Candidate comparison matrix

Maintenance reflects the repository head inspected on 2026-08-08 or the exact Agena package version. “Direct reuse” assumes preserving the relevant MIT or Apache-2.0 notice.

| Candidate | Relevant primitive | Exact source/package | License | Maintenance | Desktop fit | Mobile fit | Integration effort / dependency consequence | Recommendation |
|---|---|---|---|---|---|---|---|---|
| OpenChamber | End-anchored variable-height transcript, measurement snapshots, exact anchor hold, iOS prepend deferral; dedicated Capacitor shell | [`MessageList.tsx`](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/components/chat/MessageList.tsx), [`MobileApp.tsx`](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/apps/MobileApp.tsx), [`MobileWorkspaceDrawer.tsx`](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/apps/MobileWorkspaceDrawer.tsx), [`mobile.css`](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/styles/mobile.css) | [MIT](https://github.com/openchamber/openchamber/blob/main/LICENSE) | Active; inspected commit `0c?`/repository head dated 2026-08-08; v1.18.1 | Excellent | Excellent | **Medium source port**, no new runtime dependency; same React/Capacitor/TanStack versions reduce risk. Do not port the 1,800-line component wholesale. | **Primary implementation reference** |
| OpenCode | Timeline projection, stable row reuse, end anchoring, per-session virtualizer snapshots, exact prepend anchor, scroll interaction/perf tests | [`message-timeline.tsx`](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/pages/session/timeline/message-timeline.tsx), [`row-reconciliation.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/pages/session/timeline/row-reconciliation.ts), [`scroll-interaction.spec.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/app/e2e/performance/timeline-stability/scroll-interaction.spec.ts), [`session-tab-switch-benchmark.spec.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/app/e2e/performance/timeline/session-tab-switch-benchmark.spec.ts) | [MIT](https://github.com/anomalyco/opencode/blob/dev/LICENSE) | Very active; inspected commit `fe82a1b` dated 2026-08-08 | Excellent | Good interaction logic; Solid UI is not directly reusable | **Medium behavior port**; no dependency. Source concepts translate from Solid to React. | **Primary behavior/testing reference** |
| assistant-ui | Autoscroll-intent state machine, resize-aware following, thread-switch policies, top-anchor reserve | [`useThreadViewportAutoScroll.ts`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts), [`mountTopAnchorReserve.ts`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react/src/primitives/thread/topAnchor/mountTopAnchorReserve.ts) | [MIT](https://github.com/assistant-ui/assistant-ui/blob/main/LICENSE) | Very active; inspected commit `0ae51a8` dated 2026-08-08 | Good | Good | Whole framework is a large overlapping runtime/store abstraction. A **small source port** is low cost. | Port 100–200 lines of behavior; **do not install framework** |
| Vercel AI Elements | Tool, confirmation, attachment, context, task and conversation source recipes | [`conversation.tsx`](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/conversation.tsx), [`tool.tsx`](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/tool.tsx), [`confirmation.tsx`](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/confirmation.tsx), [`attachments.tsx`](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/attachments.tsx) | [Apache-2.0](https://github.com/vercel/ai-elements/blob/main/LICENSE) | Active; inspected commit `0c1f5e8` dated 2026-07-09 | Good | Good after Agena restyling | Low source adaptation; recipes bring shadcn/AI SDK assumptions if copied indiscriminately. Agena already vendors attributed excerpts. | Continue selective ports, especially attachments; never adopt visual identity wholesale |
| Dockview | Persistent draggable tabs, split groups, panel lifecycle and JSON layout | [`dockview`](https://www.npmjs.com/package/dockview), [core source](https://github.com/mathuo/dockview) | [MIT](https://github.com/mathuo/dockview/blob/master/LICENSE) | Current Agena pin 7.0.2 | Excellent | Poor—desktop workbench metaphor | Already installed; no added bundle. | **Keep desktop-only** |
| TanStack Virtual | Dynamic measurement, stable keys, `anchorTo:'end'`, `followOnAppend`, snapshots, scroll adjustment hook | [`@tanstack/react-virtual`](https://tanstack.com/virtual/latest/docs/framework/react/react-virtual), [core source](https://github.com/TanStack/virtual) | [MIT](https://github.com/TanStack/virtual/blob/main/LICENSE) | Current Agena/OpenChamber pin 3.14.5 | Excellent | Excellent with touch policy | Already installed and small. Correct use is cheaper than replacing it. | **Keep and use more of its API** |
| React Virtuoso OSS core | `firstItemIndex`, `followOutput`, state restore, prepend examples | [`Virtuoso.tsx`](https://github.com/petyosi/react-virtuoso/blob/master/packages/react-virtuoso/src/Virtuoso.tsx), [`prepend-as-you-scroll.tsx`](https://github.com/petyosi/react-virtuoso/blob/master/packages/react-virtuoso/examples/prepend-as-you-scroll.tsx) | [Core MIT](https://github.com/petyosi/react-virtuoso/blob/master/packages/react-virtuoso/LICENSE); **Virtuoso Message List has a separate commercial EULA** | Active; inspected commit `e1186cd` dated 2026-08-04 | Excellent | Excellent | New overlapping virtualizer and migration cost. Commercial Message List must not be copied or assumed free. | Useful benchmark/fallback only; **do not add now** |
| VS Code | Grid/pane IA, keyboard/focus discipline, tree/list semantics, status bar | [`gridview.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/grid/gridview.ts), [`abstractTree.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/tree/abstractTree.ts), [`panelPart.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/panel/panelPart.ts) | [MIT](https://github.com/microsoft/vscode/blob/main/LICENSE.txt) | Very active; inspected commit `5fb9376` dated 2026-08-08 | Excellent | Low; desktop workbench only | Copying workbench code would be expensive and tightly coupled. Small algorithms/styles are legally reusable with notice. | Interaction reference and keyboard checklist; keep Dockview |
| OpenHands Agent Canvas | Event grouping, tool visualizers, attachments, mobile conversation panel, tabs | [`chat-interface.tsx`](https://github.com/OpenHands/OpenHands/blob/main/src/components/features/chat/chat-interface.tsx), [`tool-visualizers`](https://github.com/OpenHands/OpenHands/tree/main/src/components/features/chat/tool-visualizers), [`conversation-mobile-panel-page.tsx`](https://github.com/OpenHands/OpenHands/blob/main/src/components/features/conversation/conversation-main/conversation-mobile-panel-page.tsx) | [MIT](https://github.com/OpenHands/OpenHands/blob/main/LICENSE) | Active; inspected commit `4470813` dated 2026-08-07; package 1.12.0 | Good | Good | Whole UI brings HeroUI, Monaco, React Router, React Query, Framer Motion and more. Direct adoption is unjustified. | Interaction/source reference for tool specialization and attachment states |
| Cline | Production VS Code webview chat, checkpoints, browser/tool cards, image prompts | [`ChatView.tsx`](https://github.com/cline/cline/blob/main/apps/vscode/webview-ui/src/components/chat/ChatView.tsx), [`ChatRow.tsx`](https://github.com/cline/cline/blob/main/apps/vscode/webview-ui/src/components/chat/ChatRow.tsx) | [Apache-2.0](https://github.com/cline/cline/blob/main/LICENSE) | Active; repository inspected at current head | Good inside IDE/webview | Limited | React source is reusable with notice, but it is coupled to VS Code message protocol and Cline state. | Interaction reference for checkpoints/browser actions; no dependency |
| Radix Primitives | Dialog, popover, menu, context menu, tabs, focus trapping, dismiss layers | [`radix-ui` package](https://www.npmjs.com/package/radix-ui), [source](https://github.com/radix-ui/primitives) | [MIT](https://github.com/radix-ui/primitives/blob/main/LICENSE) | Current Agena pin 1.6.2 | Excellent | Good when touch sizing/presentation are Agena-owned | Already installed. Adding React Aria/Base UI would overlap. | **Keep**; close accessibility gaps in Agena composition |
| xterm.js | Terminal emulation, search/fit/WebGL, screen-reader mode | [`@xterm/xterm`](https://www.npmjs.com/package/@xterm/xterm), [source](https://github.com/xtermjs/xterm.js) | [MIT](https://github.com/xtermjs/xterm.js/blob/master/LICENSE) | Current Agena pin 6.0.0 | Excellent | Good with full-screen chrome/accessory keys | Already installed; WebGL addon costs only when terminal mounts. | **Keep** |
| `@git-diff-view/react` | Unified/split diff and syntax-aware line rendering | [source](https://github.com/MrWangJustToDo/git-diff-view), [`@git-diff-view/react`](https://www.npmjs.com/package/@git-diff-view/react) | [MIT](https://github.com/MrWangJustToDo/git-diff-view/blob/main/LICENSE) | Current Agena pin 0.0.36 | Good | Unified view is good; split is tablet/desktop | Already installed. Validate large diffs before considering Monaco/Pierre. | **Keep pending benchmarks** |

### Shortlist

Use OpenChamber for the near-drop-in transcript/mobile patterns, OpenCode for independent confirmation plus its testing discipline, assistant-ui for the smallest correct follow-state machine, AI Elements for narrow content recipes, and VS Code for desktop interaction standards. Everything else is either already installed infrastructure or a comparison/control.

## D. Reuse map

| Agena surface | Source/reference | What to borrow | Reuse mode | Required adaptation | Files likely affected |
|---|---|---|---|---|---|
| Transcript virtualizer | OpenChamber `MessageList.tsx`; OpenCode `message-timeline.tsx` | `anchorTo:'end'`, `initialOffset`, adaptive estimate, snapshot cache, `shouldAdjustScrollPositionOnItemSizeChange`, pre-exposed total height | **source port** | Convert to Agena `Block` keys and React store; keep code small and attributed | `features/transcript/transcript-pane.tsx`, new `viewport-controller.ts`, `store/ui.ts` |
| Prepend restoration | OpenChamber/OpenCode | Capture first non-sticky visible element `{key, offset}`, restore delta, hold until stable/cancel on user input | **source port** | Use `data-block-seq`; integrate with `prependOlder`; mobile gesture deferral | transcript viewport/controller/tests |
| Follow/jump state | assistant-ui | Pending bottom intent, pointer cancellation, content-vs-user scroll discrimination | **source port** | No assistant-ui stores; implement a three-state reducer | transcript controller/tests |
| Measurement/session cache | OpenChamber/OpenCode | LRU of `virtualizer.takeSnapshot()` plus open/expanded state | **source port** | Limit 8 mobile / 16 desktop; persist only semantic anchor, not measurements | transcript cache, layout persistence |
| Tool cards | Agena current + AI Elements | Current compact row; attachment/confirmation composition patterns | **keep current** | Central state labels, touch-visible actions, isolated live-output subscription | `tool-card.tsx`, approvals, tokens |
| Settled/streaming separation | Agena current + OpenChamber | Keep settled virtual history and streaming tail separate | **keep current** | Batch tail updates; cache parsed settled Markdown | `tail.tsx`, transcript store |
| Desktop layout | Agena Dockview + VS Code | Pane roles, focus history, keyboard commands, open-beside semantics | **existing dependency** | Dockview remains geometry owner; add focus manager and commands | `shell/layout.tsx`, `shell/panes.ts`, shortcuts |
| Desktop session tree | VS Code tree semantics + OpenChamber hierarchy | Roving focus, arrows, expand/collapse, status/count grammar | **interaction reference** | Preserve Agena project/task grouping; do not copy VS Code workbench | sessions rail and selectors |
| Mobile shell | OpenChamber `MobileApp`, sessions sheet, workspace drawer | Chat primary; permanent/warm sessions surface; full-screen workspace tabs; tablet side panels | **interaction reference** | Build with Agena protocol/state and Radix; avoid copying entire app | `apps/conductor` shell/navigation (exact files unverified) |
| Mobile workspace | OpenChamber `MobileWorkspaceDrawer` | Files/changes/terminal/browser as one visited-tab full-screen surface; panes stay mounted after first visit | **source port** | Tabs: Changes, Files, Terminal, Browser; mobile back semantics | Conductor presentation + shared pane adapters |
| Composer attachments | AI Elements attachments; OpenHands uploaded-image states | Thumbnail strip, progress/error/remove/retry, paste/drop/picker | **source port** | Bind to existing Agena bridge/protocol only; no AI SDK types | composer shared controller + desktop/mobile presenters |
| Terminal | Current xterm store + OpenChamber mobile workspace | Keep PTY/xterm object warm; visibility-driven attach/fit; terminal owns Escape | **keep current** | 16 px mobile font, accessory bar, safe area and keyboard | terminal view/platform adapter |
| Code/files | Current Shiki/tree + mobile drill-down | Preserve data controller, use desktop split and mobile navigation stack | **keep current** | Add complete tree keyboard semantics and image preview | files controller + platform views |
| Diff | Current git-diff-view | Unified/split modes | **keep current** | Unified default on phone; virtualize/limit giant diffs; restore selected file | diff pane/controller |
| Approvals | Current controller + mobile full-screen sheet pattern | Global pending inbox, exact subject, explicit deny/approve | **keep current** | One unobtrusive desktop banner; mobile sheet with sticky actions | approvals presenter(s) |
| Errors/loading | Current primitives | Shared semantic async boundary | **source port** (internal consolidation) | Preserve stale content during refresh/reconnect; platform toast positions | UI kit + each pane |
| Tokens | Current Graphite & Iris | Existing surfaces, iris accent, OKLCH theme mapping | **keep current** | Rename raw tokens semantically, add density/touch/agent-state tokens | `styles/theme.css`, UI primitives |

## E. Target information architecture

### Desktop

The desktop app is a workbench. Keep a persistent project/session rail, session tabs in the center, an optional right context group, and an optional bottom terminal group. A session tab owns its transcript, composer, scroll snapshot, and focus history. Secondary panes follow the active session unless explicitly pinned.

Key rules:

- single click opens/focuses a session tab; `Open beside` creates a horizontal split; drag may create any Dockview split;
- `Cmd/Ctrl+1…9` focuses session tabs; `Cmd/Ctrl+Alt+Arrow` cycles sessions; `Cmd/Ctrl+Shift+E/D/F` retains current pane commands;
- focus returns to the last focused control within a panel after tab/pane restoration;
- the right group contains Inspector, Files, Diff, Search, Timeline, Snapshots, Browser; terminal remains a bottom group by default but can be dragged;
- approval need is visible in session rows, tab badges, and one global inbox—not three overlapping banners.

#### Desktop default

```text
┌ Projects / sessions ┬ Session tab: auth refresh ───────────────┐
│ Filter              │ parent › subagent (when applicable)      │
│ ▾ Project A         │                                          │
│   ● auth refresh    │ transcript                               │
│   ○ tests           │                                          │
│ ▾ Global tasks      │                                          │
│   ! release check   │ composer: model · thinking · fast · send │
└─────────────────────┴──────────────────────────────────────────┤
│ connection · branch · approvals · context / usage             │
└────────────────────────────────────────────────────────────────┘
```

#### Desktop two-chat split

```text
┌ Sessions ┬ auth refresh ─────────────┬ flaky tests ────────────┐
│          │ transcript A              │ transcript B            │
│          │                           │                         │
│          │ composer A                │ composer B              │
└──────────┴───────────────────────────┴─────────────────────────┤
│ status / active focus / pending approvals                      │
└────────────────────────────────────────────────────────────────┘
```

#### Desktop chat plus terminal/browser

```text
┌ Sessions ┬ chat ─────────────────────┬ Browser / Files / Diff ┐
│          │ transcript                │ localhost:3000          │
│          │ composer                  │                         │
│          ├───────────────────────────┴─────────────────────────┤
│          │ Terminal: workspace · tab 1 · tab 2                 │
└──────────┴─────────────────────────────────────────────────────┘
```

### Mobile

The phone app is a navigation stack, not a miniature workbench. The primary route is the active transcript. Sessions and projects are a full-height surface launched from the header; workspace tools are another full-height surface with visited tabs kept mounted. Approvals open as a bottom sheet for short confirms and full screen for input/editor/long command details. Do **not** add a permanent bottom navigation bar: the composer and software keyboard already own the lower edge.

Recommended route/state model:

- root: connection/pairing gate → sessions or restored transcript;
- transcript header: Sessions, parent breadcrumb/title, approval count, Workspace;
- Workspace surface tabs: Changes, Files, Terminal, Browser. Search/timeline/snapshots live in a More sheet until usage proves they deserve tabs;
- exact active session + semantic scroll anchor persisted on background; in-memory measurement snapshot retained while process lives;
- Android Back: close dialog → close approval → close workspace → close sessions surface → child to parent → transcript to sessions → OS background/exit;
- iOS: edge swipe follows the same stack, never a custom gesture inside terminal/diff horizontal scrolling.

#### Mobile project/session list

```text
┌ Sessions                              + ┐
│ Search sessions…                        │
│ PROJECT A                               │
│ ● Auth refresh                 running  │
│   ├─ API audit                  active  │
│   └─ Tests                     finished │
│ ○ Flaky login tests                      │
│ GLOBAL TASKS                             │
│ ! Release check              approval 1 │
└ Instances          Settings              ┘
```

#### Mobile transcript

```text
┌ ☰  Auth refresh              !1  Tools ┐
│ parent › API audit                      │
├─────────────────────────────────────────┤
│ transcript                              │
│  tool: bash · running · 12s        ›    │
│  assistant response…                    │
│                          Jump · 3 new ↓ │
├─────────────────────────────────────────┤
│ [image]  Prompt…                        │
│ model · think · fast               ↑/■  │
└ safe area / software keyboard ──────────┘
```

#### Mobile terminal

```text
┌ ‹ Chat       Terminal             ⋯ ┐
│ [1] workspace   [2] server   +       │
├───────────────────────────────────────┤
│ $ pnpm dev                          │
│ ready on http://localhost:3000      │
│                                     │
├───────────────────────────────────────┤
│ Esc  Tab  Ctrl  ↑  ↓  ←  →    Keyboard│
└ home-indicator safe area ─────────────┘
```

#### Agent/subagent hierarchy

```text
Parent: Auth refresh                         running
├─ API contract audit                        active
│  └─ Open transcript ›
├─ Regression tests                          finished
└─ Security review                           failed
   └─ Retry / open transcript ›
```

## F. Component architecture

### Smallest coherent hierarchy

```text
AppBoot
├─ ConnectionProvider / bridge subscriptions
├─ Domain stores (sessions, transcripts, approvals, runtime)
├─ Shared overlay and notification services
└─ PlatformRouter
   ├─ DesktopShell
   │  ├─ SessionRail
   │  ├─ DockWorkbench
   │  │  ├─ SessionWorkspace[]
   │  │  ├─ ContextPaneGroup
   │  │  └─ TerminalDock
   │  └─ DesktopStatusBar
   └─ MobileShell
      ├─ MobileHeader
      ├─ SessionSurface
      ├─ SessionWorkspace
      ├─ WorkspaceSurface
      └─ MobileLifecycleAdapter

SessionWorkspace
├─ AgentContextHeader (optional)
├─ TranscriptViewport
│  ├─ SettledHistory
│  ├─ StreamingTail
│  └─ JumpToLatest
└─ ComposerPresenter
```

### Ownership boundaries

| Layer | Owns | Must not own |
|---|---|---|
| Protocol/client | Wire events, commands, reconnect, HTTP/WS/PTy contracts | UI geometry or component state |
| Domain stores | Normalized sessions, transcript durable projection, in-flight buffers, approvals, runtime controls | Dock coordinates, modal animation, DOM measurements |
| Transcript controller | follow/reading/restoring state, semantic anchor, measurement LRU, unread counts | Network subscription or Markdown visual design |
| Desktop shell | Dockview groups, tabs, splits, focus history, persisted desktop layout | Mobile routes |
| Mobile shell | Navigation stack, safe areas, lifecycle, Android Back, workspace surfaces | Dockview |
| Shared content primitives | Message/tool/approval/code/diff content and semantic status | Platform navigation chrome |
| Platform adapters | file/image picker, notifications, browser opening, QR/camera, keyboard/lifecycle | Domain event interpretation |

### Store changes

- Preserve current `useSessions`, `useApprovals`, `useConnection`, and pure transcript reducers.
- Split transcript storage into:
  - durable settled blocks keyed by session;
  - in-flight assistant buffer keyed by message;
  - live tool output keyed by `toolCallId` so a delta does not clone every settled block;
  - viewport state keyed by `sessionId + paneInstanceId` (two panes can show the same session with different reading positions).
- Dockview JSON remains persisted, but `inspectorOpen/browserOpen/terminalOpen` become commands/derived selectors rather than competing geometry truth.
- Persist semantic view state only: `{anchorSeq, offsetPx, atLatest, unreadAfterSeq}`. Keep virtualizer measurement arrays in an LRU memory cache because they are implementation/version-specific.

### Share vs specialize

| Shared responsive component | Shared logic, platform-specific presenter | Desktop only | Mobile specific/native |
|---|---|---|---|
| `BlockView`, Markdown, code block, tool content, approval subject, attachment model, status badge | Composer chrome, session navigation, files browser, diff toolbar, approvals, settings | Dockview, status bar, hover meta, draggable split/tab chrome, Electron browser view | Mobile header/stack/surfaces, safe area, lifecycle restore, Android Back, QR scanner, native image picker, notification routing, terminal accessory bar |

### Consolidate/delete

- Consolidate `timeline` and `user-message-rail` data/commands into one `TranscriptNavigator` model; keep two presenters if both prove useful.
- Consolidate active-agent summary, subagent receipt, child banner, and session-row task status around `AgentTreeProjection` and shared status vocabulary.
- Consolidate feature-local loading/error wrappers into `AsyncBoundary` plus feature-specific empty content.
- Delete the shell's automatic “mobile” rail-collapse behavior once `MobileShell` routes by platform; a narrow desktop Electron window can still use compact desktop mode.
- Do not invent a generic pane interface beyond the existing `PaneDefinition`; one implementation does not need an adapter.

## G. Transcript and scroll architecture

### Required state machine

```text
FOLLOWING ── user scroll/pointer up ──> READING
    ▲                                  │
    │ jump/latest or reaches bottom    │ new rows: unread++
    └──────────────────────────────────┘

READING ── prepend requested ──> RESTORING_ANCHOR ── stable/cancel ──> READING
FOLLOWING ── resize/append ──> FOLLOWING (virtualizer scrollToEnd)
```

`FOLLOWING` is semantic intent, not merely “currently within 40 px.” Content resize can make a followed viewport temporarily non-bottom. Pending follow intent must survive that resize, but pointer/touch/wheel upward movement must cancel it immediately.

### Mounting and caching

1. **Desktop:** one `SessionWorkspace` instance per open Dockview panel. Inactive panels remain mounted but hidden by Dockview. Closing a panel writes its semantic anchor and measurement snapshot to an LRU. Reopening uses the cache.
2. **Split views:** key viewport state by `paneInstanceId`, not only `sessionId`; otherwise two views of the same chat fight over one scroll position.
3. **Mobile:** only one primary session workspace is visible. Cache the last 8 sessions' measurement snapshots and semantic anchors. Workspace tool panes remain mounted after first visit, hidden when inactive, so terminal/file/diff state survives drawer switches.
4. **Process background:** immediately persist active session, active surface, semantic anchor, draft, and unsent attachments. On foreground, reconnect/subscription recovery happens without clearing rendered blocks. Restore after the first matching block page exists, then let measurements settle.

### Initial opening at newest content

Use TanStack 3.14.5's end-anchored configuration, already proven in OpenChamber with the same version:

```ts
const virtualizer = useVirtualizer({
  count: settledRows.length,
  getItemKey: (i) => settledRows[i].key,
  getScrollElement: () => viewportRef.current,
  estimateSize: () => estimatedTurnHeight.current,
  initialOffset: () => Number.MAX_SAFE_INTEGER,
  initialMeasurementsCache: cached?.measurements,
  anchorTo: "end",
  followOnAppend: true,
  scrollEndThreshold: 64,
  overscan: isTouch ? 16 : 8,
});
```

This positions at the end during virtualizer initialization rather than visibly rendering at the top and issuing a post-paint double-RAF scroll. Keep the streaming tail outside settled history, as Agena already does.

### Dynamic measurement and browser ownership

- Set `overflow-anchor: none` on the virtualized scroller/content; browser-native scroll anchoring must not compete with application/TanStack anchoring.
- All variable rows use `measureElement` and a stable key derived from durable seq plus row subtype.
- Feed an adaptive estimate after at least five measured rows, clamped to roughly 120–1,200 px per turn. A 64 px fixed estimate is too optimistic for coding turns.
- Configure `shouldAdjustScrollPositionOnItemSizeChange` to compensate only when the changed row is above the first visible row and the viewport is not following the end. A tool card expanded inside the viewport should grow downward naturally.
- ResizeObserver notifications schedule at most one correction per animation frame.

### Exact prepend restoration

Before fetching/inserting older rows:

1. identify the first visible, non-sticky `[data-block-key]`;
2. record `{key, offsetPx = element.top - viewport.top}`;
3. insert the page with stable keys;
4. allow TanStack's end-anchor correction;
5. find the same element and apply `scrollTop += newOffset - oldOffset`;
6. repeat on animation frames until drift is ≤0.5 px for several frames, with a bounded maximum; cancel immediately on wheel/touch/pointer user input.

On iOS/Android touch momentum, if the prepend is strictly above existing content and the user is not near the top, hold the newly fetched page out of the rendered array until the gesture is quiet (~160 ms), with a hard ceiling (~1.5 s). The data can already be in the store; only its presentation is deferred. This prevents native momentum and DOM geometry correction from racing.

### Following and unread behavior

- Pointer/touch down cancels pending follow intent immediately.
- A scroll event is considered user-upward only if `scrollTop` decreased while `scrollHeight` stayed stable; content-driven shifts must not be misclassified.
- While `READING`, additions below the viewport increment unread by semantic turn/block count and never write `scrollTop`.
- “Jump to latest” calls `virtualizer.scrollToEnd()` with instant/auto behavior, resets unread, and enters `FOLLOWING`. Avoid smooth scrolling during live output.
- If the user naturally reaches within 1–2 px of the end, enter `FOLLOWING` and clear unread.
- Nested scroll regions (tool output, code block) own wheel/keyboard scrolling until they hit their boundary; only then should the transcript interpret the gesture.

### Streaming update path

Current deltas should not update the whole transcript React slice at token frequency.

1. Bridge ingests deltas into mutable, session-scoped buffers.
2. Schedule at most one publication per animation frame (or 30–50 ms when backgrounded).
3. `StreamingTail` subscribes only to its message buffer; live `ToolOutput` subscribes only to its tool buffer.
4. Render completed Markdown blocks from memoized parse output. For the actively growing Markdown block, publish visual text each frame but run expensive Markdown parsing on a bounded cadence (for example 80–120 ms) and immediately on fenced-block boundary/final event.
5. On `message.assistant.completed`, atomically append the authoritative durable block, clear the buffer, and preserve the tail's measured bottom position.
6. Cap live tool DOM output (current 400-line fold is good); keep full durable result available to the inspector/download path, not necessarily mounted.

### Retry, compaction, and failure presentation

- Group runtime/tool/retry markers within their causal turn.
- Default successful tool calls to collapsed; keep one-line command/path/result metadata visible.
- Auto-expand only the newest failure or pending approval, not every historical error.
- Represent retry as one status row whose state transitions (`retrying 2/3` → `recovered` / `failed`), while retaining raw events in Timeline/Inspector.
- Represent compaction as a quiet boundary chip with before/after context usage; failures use a single actionable error row.

## H. Design-system proposal

### Refine Graphite & Iris; do not replace it

The current theme already has the right semantic shape, OKLCH palette, light/dark mapping, reduced-motion rule, focused developer-tool typography, and constrained status colors. The problem is not the palette. It is inconsistent density, touch behavior, and duplicated component state language.

### Minimal semantic token taxonomy

```css
/* Surface */
--surface-canvas; --surface-panel; --surface-raised; --surface-overlay; --surface-inset;
/* Content */
--text-primary; --text-secondary; --text-muted; --text-disabled;
/* Structure */
--border-subtle; --border-default; --border-strong; --focus-ring;
/* Brand/action */
--accent; --accent-hover; --accent-active; --on-accent;
/* Feedback */
--status-info; --status-success; --status-warning; --status-danger;
/* Domain aliases, mapped to the feedback/content tokens */
--agent-running; --agent-waiting; --agent-attention; --agent-complete; --agent-failed;
--tool-pending; --tool-running; --tool-success; --tool-error; --tool-aborted; --tool-denied;
/* Metrics */
--control-h-sm; --control-h-md; --control-h-lg; --touch-target;
--content-column; --panel-gap; --transcript-gap-turn; --transcript-gap-block;
```

Map these to Tailwind 4 with `@theme inline`, as the current file already does. Renaming may be gradual: alias new names to existing `--bg-*`/`--fg-*` values first, then migrate utilities component by component.

### Typography

| Role | Desktop | Mobile | Notes |
|---|---:|---:|---|
| Transcript prose | 14 px / 24 px | 16 px / 25–26 px | Calm reading rhythm; max width 720–760 px desktop |
| Code/tool output | 13 px / 20–22 px | 14 px / 21 px | No ligatures; horizontal scroll for code |
| UI default | 13 px / 22 px | 15 px / 22 px | Mobile input text is **16 px minimum** to avoid iOS zoom |
| Metadata | 11–12 px | 13 px | Never use faint contrast for required status/action text |
| Pane/dialog heading | 16 px | 17 px | Sentence case |

### Density and geometry

- Desktop comfortable: 32 px list rows, 32 px controls; compact: 28 px. Do not offer compact mode until the base redesign is stable.
- Mobile touch target: 44×44 px preferred, 40×40 absolute minimum for dense terminal accessory keys.
- Base spacing remains 4 px; use 4/8/12/16/24/32 only.
- Retain radii roughly 4/6/8/12/16; transcript assistant prose remains bare, user messages use a quiet 8 px surface, overlays 12 px, composer 16 px.
- Borders carry structure; shadows only distinguish overlays. Avoid carding every event.

### Motion

- 100 ms hover/press, 140 ms popover, 180–220 ms mobile surface, 260 ms maximum for large desktop dialogs.
- No smooth autoscroll during generation.
- Animate only newly created user/assistant turn containers once; virtualized remounts never animate.
- Running shimmer/spinner, skeleton pulse, and active status dot are the only continuous motion. Honor reduced motion with zero translation and near-zero duration.

### Transcript rhythm and semantic states

- 20 px between user/assistant turns; 8–12 px between blocks in one turn; tool-call groups may be flush.
- Tool row always shows state icon, name, terse argument, duration/result. Expanded wells use inset surface.
- Approval warning uses amber border/wash and shield; denial is neutral/amber, not destructive red; execution failure is red; user abort is muted.
- Reconnect keeps content visible with a slim inline banner. Loading older uses a top progress chip. Initial empty, true loading, disconnected, unauthorized, and daemon-restarting are distinct states.
- Touch exposes message actions through a trailing `…` button or long-press menu; never rely on hover.

### Breakpoints

- Platform shell selection is based on runtime (`Electron` vs Capacitor) first, viewport second.
- Desktop compact/narrow: below ~900 px, rail becomes an overlay but Dockview remains available.
- Phone: up to ~767 CSS px, single surface.
- Tablet: ~768–1,199 px, chat plus optional persistent session/workspace side panel; no arbitrary horizontal Dockview.
- Desktop: ≥1,200 px or Electron runtime, full workbench.

## I. Incremental migration plan

Estimates are focused engineer-days, excluding product-review latency. Each stage is independently shippable and can be feature-flagged.

| Stage | Exact scope / likely files | Dependencies | Acceptance tests and visual coverage | Rollback boundary | Estimate |
|---|---|---|---|---|---:|
| 1. Transcript behavioral correctness | Introduce viewport state machine, end anchoring, exact prepend anchor, measurement snapshots, content-vs-user scroll detection. `transcript-pane.tsx`, new controller/cache, transcript fixtures. | Existing TanStack 3.14.5 only | Open newest without top flash; prepend drift ≤1 px desktop/≤2 px mobile after quiet; scrolling up prevents all downstream movement; split/session switch retains anchors. Screenshot + DOM-coordinate probes. | Feature flag `transcriptViewportV2`; old pane remains callable. | 5–7 d |
| 2. Streaming isolation/performance | rAF delta publication, separate live assistant/tool stores, memoized settled blocks, throttled active Markdown. `store/transcript.ts`, `tail.tsx`, `tool-card.tsx`, ingest. | None | Settled rows render zero times for 1,000 tail deltas; ≤1 React commit/frame; no dropped final content; 400-line tool fold. | Adapter can republish old state shape. | 4–6 d |
| 3. Primitives and tokens | Alias/refine semantic tokens; standardize controls, focus, async boundaries, status vocabulary, desktop/mobile density. `theme.css`, `ui/*`. | Existing Radix/Tailwind | Axe/keyboard snapshots for primitives; dark/light screenshots; reduced-motion tests; contrast AA for essential text. | Token aliases preserve old utilities. | 3–5 d |
| 4. Desktop shell/navigation | Dockview sole geometry owner; focus history; open-beside/split commands; session rail component split; agent projection. `shell/*`, sessions, agents, commands. | Dockview existing | Drag/split/restore; hot tab switch no blank frame; keyboard cycles; screen-reader names; corrupted layout falls back. Wide/narrow screenshots. | `desktopShellV2`; existing JSON layout version bumped only at cutover. | 6–8 d |
| 5. Transcript content/composer | Restyle turn rhythm/tool groups; touch-accessible actions; attachment model/UI; runtime controls including Fast Mode if protocol-supported; approval noise reduction. | Existing AI Elements excerpts; no framework | Send/steer/queue/abort; paste/drop/pick/remove/retry image; model/thinking state; tool/approval fixtures; 320/768/1440 screenshots. | Content components individually flaggable. | 6–8 d |
| 6. Secondary panes | Shared controllers with desktop presenters; files tree keyboard semantics/image preview; diff large-file safeguards; search keyboard nav; navigator consolidation; stale-content async states. | Existing Shiki/git-diff-view/xterm | 10k-file virtual tree, 20k-line code, large diff, search/reveal, snapshot destructive flows, browser overlay. | Each pane independently revertible. | 7–10 d |
| 7. Mobile shell | `MobileShell`, session surface, workspace surface, tablet panels, back stack, lifecycle restoration, safe areas, keyboard avoidance, terminal presenter. Exact Conductor files to confirm. | Capacitor 8; existing shared stores/primitives | iPhone SE/standard/Max, Pixel narrow/large, iPad; rotate/background/network switch; Android Back; software keyboard; approval and terminal flows. Device screenshots. | Runtime switch retains current responsive renderer behind flag. | 10–15 d |
| 8. Settings/pairing | Mobile settings stack, QR scan permission/retry/manual fallback, secure connection metadata, desktop settings visual alignment. Exact files require Conductor audit. | Existing Capacitor plugins only if already present; otherwise separately approved | Denied camera, bad/expired QR, offline daemon, relaunch, secure token persistence, screen reader labels. | Pairing gate stays independently deployable. | 4–7 d |
| 9. Hardening | Performance budgets, Playwright visual probes, axe, screen readers, memory/render telemetry, cross-platform polish. | Test tooling only | Thresholds in section J enforced in CI; no protocol/backend changes. | Tests/telemetry do not alter core behavior. | 5–7 d |

Sequence mobile after shared transcript correctness, not after all desktop visuals. This avoids building the phone on unstable scroll behavior while still allowing mobile shell work to start before every desktop secondary pane is polished.

## J. Validation plan

### Functional and store tests

- Pure reducer fixtures for every durable event and frame, malformed known events, unknown events, duplicate seq, replay + snapshot + live frame ordering.
- Viewport reducer tests for `FOLLOWING`, `READING`, `RESTORING_ANCHOR`, pointer cancel, unread counts, reconnect, and session/pane keys.
- Agent-tree projection tests for missing parent history, out-of-order task events, nested children, completion/failure/cancel.
- Layout persistence tests for version mismatch, unknown panels, deleted sessions, two panes showing the same session, and focus restore.

### Transcript fixtures

At minimum:

- 20,000 durable events / 5,000 rendered rows;
- variable Markdown with tables, 500-line fenced code, delayed images, nested lists, and long unbroken paths;
- 2,000 tool cards with running/completed/failed/retry/approval transitions;
- one row taller than the viewport;
- 1,000 token deltas at bursty cadence;
- 10 pages prepended while scrolled mid-turn;
- compaction during an active run; daemon restart with in-flight snapshot;
- two sessions streaming simultaneously in a desktop split.

### Measurable thresholds

| Measure | Target |
|---|---:|
| Initial newest-message positioning | Correct before first user-visible content frame; no top-to-bottom flash |
| Mid-history drift while content is added below | ≤1 px desktop; ≤2 px touch after momentum quiets |
| Prepend anchor drift after all measurements settle | ≤1 px desktop; ≤2 px mobile |
| Followed bottom error | ≤2 px within two animation frames |
| Hot session-tab switch | p95 ≤100 ms to first correct stable content; zero blank/wrong-session frame |
| Cold cached session switch | p95 ≤250 ms on reference desktop; ≤400 ms on reference phone |
| Streaming render scope | settled rows: 0 renders per tail delta; active tail/tool only |
| Streaming commit rate | ≤1 React commit per animation frame |
| Long task | p95 <50 ms during streaming/scrolling; none >100 ms in normal fixture |
| Scroll frame rate | p95 frame ≤20 ms desktop; ≤25 ms mid-tier Android fixture |
| Memory after cycling 50 sessions | returns within 15% of post-warm baseline after GC; measurement LRU bounded |
| Touch target | 44 px preferred, no essential target below 40 px |
| Contrast | WCAG AA for required text/status; focus ring visible in both themes |

### Interaction and accessibility checks

- Keyboard-only: open/split/close tab, tree navigation, pane toggles, composer/send/abort, approval review, terminal focus escape rules, return focus after dialog.
- Screen readers: NVDA + Chrome/Windows, VoiceOver + Safari/macOS, VoiceOver/iOS, TalkBack/Android. Transcript container is a named `role=log` only if announcements are throttled; do not announce every token. Announce turn completion, approval, failure, and reconnect changes through a separate polite live region.
- Zoom and reflow: desktop 200%; phone text scaling; no clipped approval subject or hidden send action.
- Pointer/touch: nested code/tool output scroll, text selection autoscroll, long press, touch momentum during prepend, edge swipe conflict with terminal/diff.

### Platform/resilience matrix

- viewport widths: 320, 375, 390, 430, 768, 1024, 1280, 1440, ultrawide;
- iOS current and previous major, Android current and previous major; portrait/landscape; hardware and software keyboard;
- background 5 s / 5 min / OS-evicted; Wi-Fi→cellular; offline→online; daemon restart; approval arrives while backgrounded;
- desktop native browser open while palette/settings/approval appears;
- terminal/browser/diff state after session switch, panel hide/show, app background, and reconnect.

### Visual regression

Use deterministic event fixtures and screenshot these states in light/dark and desktop/mobile:

- empty, loading, stale-refresh, disconnected, reconnecting, unauthorized, fatal;
- user/assistant long turns, running/failed/denied tools, compaction, retry group;
- one/many approvals and long command/args;
- default, two-chat split, chat+terminal, chat+browser, narrow desktop;
- mobile transcript with keyboard closed/open, sessions, workspace tabs, terminal, pairing errors;
- reduced motion and 200% zoom.

Coordinate-based visual probes, modeled on OpenCode's tests, should sample stable row bounding boxes across each animation frame—not just before/after screenshots. A screenshot can miss a visible jump that settles before capture.

## K. Sources

### Agena and governing architecture

- [Agena `final_plan.md`](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/final_plan.md)
- [Desktop package manifest](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/package.json)
- [Desktop architecture](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/ARCHITECTURE.md)
- [Graphite & Iris theme](https://github.com/kshgrk/agena/blob/eb83051bffcabff5b9babe05d9b2a44a2ebbb376/apps/desktopNew/src/renderer/styles/theme.css)

### Transcript, chat, and agent applications

- OpenChamber: [repository](https://github.com/openchamber/openchamber), [license](https://github.com/openchamber/openchamber/blob/main/LICENSE), [message list](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/components/chat/MessageList.tsx), [scroll spy](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/components/chat/lib/scroll/scrollSpy.ts), [mobile app](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/apps/MobileApp.tsx), [mobile sessions](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/apps/MobileSessionsSheet.tsx), [mobile workspace](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/apps/MobileWorkspaceDrawer.tsx), [mobile CSS](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/styles/mobile.css)
- OpenCode: [repository](https://github.com/anomalyco/opencode), [license](https://github.com/anomalyco/opencode/blob/dev/LICENSE), [message timeline](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/pages/session/timeline/message-timeline.tsx), [projection](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/pages/session/timeline/projection.ts), [row reconciliation](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/pages/session/timeline/row-reconciliation.ts), [scroll persistence](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/context/layout-scroll.ts), [scroll interaction tests](https://github.com/anomalyco/opencode/blob/dev/packages/app/e2e/performance/timeline-stability/scroll-interaction.spec.ts), [session-switch benchmark](https://github.com/anomalyco/opencode/blob/dev/packages/app/e2e/performance/timeline/session-tab-switch-benchmark.spec.ts)
- assistant-ui: [repository](https://github.com/assistant-ui/assistant-ui), [license](https://github.com/assistant-ui/assistant-ui/blob/main/LICENSE), [viewport auto-scroll](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts), [top-anchor reserve](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react/src/primitives/thread/topAnchor/mountTopAnchorReserve.ts), [reserve observers](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react/src/primitives/thread/topAnchor/createReserveObservers.ts)
- Vercel AI Elements: [repository](https://github.com/vercel/ai-elements), [Apache-2.0 license](https://github.com/vercel/ai-elements/blob/main/LICENSE), [conversation](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/conversation.tsx), [tool](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/tool.tsx), [attachments](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/attachments.tsx), [confirmation](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/confirmation.tsx), [task](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/task.tsx)
- OpenHands Agent Canvas: [repository](https://github.com/OpenHands/OpenHands), [license](https://github.com/OpenHands/OpenHands/blob/main/LICENSE), [chat interface](https://github.com/OpenHands/OpenHands/blob/main/src/components/features/chat/chat-interface.tsx), [tool visualizers](https://github.com/OpenHands/OpenHands/tree/main/src/components/features/chat/tool-visualizers), [mobile conversation panel](https://github.com/OpenHands/OpenHands/blob/main/src/components/features/conversation/conversation-main/conversation-mobile-panel-page.tsx)
- Cline: [repository](https://github.com/cline/cline), [Apache-2.0 license](https://github.com/cline/cline/blob/main/LICENSE), [chat view](https://github.com/cline/cline/blob/main/apps/vscode/webview-ui/src/components/chat/ChatView.tsx), [chat row](https://github.com/cline/cline/blob/main/apps/vscode/webview-ui/src/components/chat/ChatRow.tsx)

### Workbench, primitives, and rendering

- VS Code: [repository](https://github.com/microsoft/vscode), [MIT license](https://github.com/microsoft/vscode/blob/main/LICENSE.txt), [grid view](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/grid/gridview.ts), [abstract tree](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/tree/abstractTree.ts), [panel part](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/panel/panelPart.ts), [status bar](https://github.com/microsoft/vscode/tree/main/src/vs/workbench/browser/parts/statusbar)
- Dockview: [repository](https://github.com/mathuo/dockview), [license](https://github.com/mathuo/dockview/blob/master/LICENSE), [documentation](https://dockview.dev/)
- TanStack Virtual: [repository](https://github.com/TanStack/virtual), [license](https://github.com/TanStack/virtual/blob/main/LICENSE), [React API](https://tanstack.com/virtual/latest/docs/framework/react/react-virtual), [Virtualizer API](https://tanstack.com/virtual/latest/docs/api/virtualizer)
- React Virtuoso: [repository](https://github.com/petyosi/react-virtuoso), [core license](https://github.com/petyosi/react-virtuoso/blob/master/packages/react-virtuoso/LICENSE), [Virtuoso source](https://github.com/petyosi/react-virtuoso/blob/master/packages/react-virtuoso/src/Virtuoso.tsx), [prepend example](https://github.com/petyosi/react-virtuoso/blob/master/packages/react-virtuoso/examples/prepend-as-you-scroll.tsx), [Message List licensing](https://virtuoso.dev/virtuoso-message-list/licensing/)
- Radix Primitives: [repository](https://github.com/radix-ui/primitives), [license](https://github.com/radix-ui/primitives/blob/main/LICENSE), [accessibility overview](https://www.radix-ui.com/primitives/docs/overview/accessibility)
- xterm.js: [repository](https://github.com/xtermjs/xterm.js), [license](https://github.com/xtermjs/xterm.js/blob/master/LICENSE), [accessibility guide](https://xtermjs.org/docs/guides/accessibility/)
- Shiki: [repository](https://github.com/shikijs/shiki), [license](https://github.com/shikijs/shiki/blob/main/LICENSE)
- git-diff-view: [repository](https://github.com/MrWangJustToDo/git-diff-view), [license](https://github.com/MrWangJustToDo/git-diff-view/blob/main/LICENSE)

### Browser/platform behavior and accessibility

- MDN: [`overflow-anchor`](https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-anchor)
- MDN: [`ResizeObserver`](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver)
- MDN: [`VisualViewport`](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport)
- Capacitor: [App lifecycle API](https://capacitorjs.com/docs/apis/app), [Keyboard API](https://capacitorjs.com/docs/apis/keyboard), [Status Bar API](https://capacitorjs.com/docs/apis/status-bar)
- WAI-ARIA APG: [Tree View pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/), [Dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [Tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)

## Final recommendation

Treat the revamp as a **behavior-first consolidation**, not a visual rewrite:

1. port the narrow OpenChamber/OpenCode anchoring and snapshot ideas onto Agena's existing TanStack Virtual implementation;
2. isolate streaming state and prove scroll/session-switch stability with coordinate probes;
3. refine Graphite & Iris and the primitive layer;
4. improve the Dockview desktop workbench without replacing it;
5. build a dedicated Capacitor presentation—chat first, warm session/workspace surfaces, platform back/lifecycle behavior—over the same domain stores and transcript subsystem.

This is the smallest combination of proven code and patterns that can make Agena feel like one coherent product across desktop and phone without destabilizing the runtime architecture that already works.
