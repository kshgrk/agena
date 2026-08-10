// Command palette (design.md §12): cmdk in a centered overlay. Three sources
// in one list — the command registry (groups, Kbd shortcuts, when-guards),
// dynamic session-switcher entries (recent first), and bridge.search message
// hits with seq-anchored jump. A ">" prefix reserves the palette for commands
// (the classic editor convention); plain text searches sessions + messages.
// Filtering is ours (cmdk shouldFilter={false}) because async search hits
// must never be text-filtered against the query that produced them.
//
// Mounted ALWAYS by the shell; renders nothing while closed. `paletteOpen` is
// part of hasOverlay, so D-INV-3 holds without extra bookkeeping.
import type { SearchHit } from "@agena/protocol";
import { Command } from "cmdk";
import { MessageSquare, Search } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import {
  allCommands,
  ensureSubscribed,
  pushToast,
  runCommand,
  shortcutLabel,
  useCommands,
  useSessions,
  useUi,
} from "../../store/index.ts";
import { Kbd } from "../../ui/index.ts";
import { splitMatches } from "../search/highlight.ts";
import {
  filterCommands,
  groupCommands,
  parsePaletteQuery,
  rankSessions,
} from "./palette-logic.ts";

const SESSION_LIMIT = 6;
const HIT_LIMIT = 12;
const MIN_SEARCH = 2;
const DEBOUNCE_MS = 250;

const ITEM_CLS =
  "mx-1.5 flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm text-fg-secondary " +
  "data-[selected=true]:bg-raised data-[selected=true]:text-fg data-[disabled=true]:opacity-50";

const GROUP_CLS =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 " +
  "[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium " +
  "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider " +
  "[&_[cmdk-group-heading]]:text-fg-muted";

/** Jump contract (see store/types.ts `jump`): requestJump scrolls the
 * transcript; `transcript.jumpTo` is an optional flash/focus command the
 * transcript feature may register — a safe no-op when absent. */
function openHit(sessionId: string, seq?: number): void {
  useSessions.getState().setActive(sessionId);
  ensureSubscribed(sessionId).catch(() =>
    pushToast({ kind: "err", title: "Failed to open session" }),
  );
  if (seq !== undefined) {
    useUi.getState().setSelected({ sessionId, seq });
    useUi.getState().requestJump(sessionId, seq);
    runCommand("transcript.jumpTo");
  }
}

/** <mark>-highlighted snippet (React escapes; splitMatches is tested). */
function Highlighted({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => splitMatches(text, query), [text, query]);
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: derived parts, replaced wholesale
          <mark key={i} className="rounded-xs bg-accent/26 text-fg">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  // cmdk's Command.Dialog = radix Dialog under the hood: focus trap,
  // role=dialog/aria-modal, Escape and outside-click close — a hand-rolled
  // overlay leaks Tab focus into the app behind the backdrop. The body
  // unmounts on close (query/hits state resets for free) after the 100ms
  // exit fade (design.md §12).
  return (
    <Command.Dialog
      open={open}
      onOpenChange={setPaletteOpen}
      label="Command palette"
      shouldFilter={false}
      loop
      // backdrop: bg-canvas/60, no blur (banned app-wide)
      overlayClassName="fixed inset-0 z-50 bg-canvas/60 animate-fade-in data-[state=closed]:animate-fade-out"
      contentClassName={
        "fixed left-1/2 top-[20vh] z-50 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 " +
        "origin-top overflow-hidden rounded-xl border border-border bg-overlay shadow-overlay " +
        "animate-fade-slide-in data-[state=closed]:animate-fade-out"
      }
    >
      <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
      <PaletteBody />
    </Command.Dialog>
  );
}

function PaletteBody() {
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const byId = useCommands((s) => s.byId);
  const sessionsById = useSessions((s) => s.byId);
  const activeSessionId = useSessions((s) => s.activeSessionId);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const reqRef = useRef(0);

  const close = () => setPaletteOpen(false);
  const { mode, text } = parsePaletteQuery(query);

  // ">" is reserved-for-commands; plain text searches sessions + messages.
  // The empty query shows both worlds for discovery.
  const showCommands = mode === "commands" || text.length === 0;
  const commandGroups = useMemo(() => {
    if (!showCommands) return [];
    return groupCommands(filterCommands(allCommands(byId), text));
  }, [showCommands, byId, text]);

  const sessions = useMemo(
    () =>
      mode === "mixed"
        ? rankSessions(Object.values(sessionsById), text, SESSION_LIMIT)
        : [],
    [mode, sessionsById, text],
  );

  // debounced message search (the palette's only bridge call)
  useEffect(() => {
    const q = text;
    if (mode !== "mixed" || q.length < MIN_SEARCH) {
      reqRef.current += 1;
      setHits([]);
      setSearching(false);
      return;
    }
    const id = ++reqRef.current;
    setSearching(true);
    const timer = setTimeout(() => {
      getBridge()
        .search(q, { limit: HIT_LIMIT })
        .then((found) => {
          if (reqRef.current === id) {
            setHits(found);
            setSearching(false);
          }
        })
        .catch(() => {
          // palette search is best-effort; the Search pane surfaces errors
          if (reqRef.current === id) {
            setHits([]);
            setSearching(false);
          }
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mode, text]);

  const select = (action: () => void) => {
    close(); // close FIRST so the action can move focus/panes freely
    action();
  };

  const sessionLabel = (id: string): string =>
    sessionsById[id]?.title ?? `session ${id.slice(-6)}`;

  return (
    <>
      <Command.Input
        value={query}
        onValueChange={setQuery}
        autoFocus
        placeholder="Search sessions and messages — type “>” for commands"
        className="h-12 w-full border-b border-border-subtle bg-transparent px-4 text-base text-fg placeholder:text-fg-muted focus:outline-none"
      />
      <Command.List className="max-h-[344px] overflow-y-auto overscroll-contain pb-1.5">
        <Command.Empty className="flex h-16 items-center justify-center text-sm text-fg-muted">
          {mode === "commands" ? "No commands match" : "No matches"}
        </Command.Empty>

        {sessions.length > 0 ? (
          <Command.Group heading="Sessions" className={GROUP_CLS}>
            {sessions.map((s) => (
              <Command.Item
                key={s.sessionId}
                value={`session:${s.sessionId}`}
                onSelect={() => select(() => openHit(s.sessionId))}
                className={ITEM_CLS}
              >
                <MessageSquare className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate">
                  {sessionLabel(s.sessionId)}
                </span>
                {s.sessionId === activeSessionId ? (
                  <span className="shrink-0 text-2xs text-fg-faint">
                    current
                  </span>
                ) : (
                  <span className="shrink-0 text-2xs text-fg-faint">
                    {s.status}
                  </span>
                )}
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {commandGroups.map(([group, cmds]) => (
          <Command.Group key={group} heading={group} className={GROUP_CLS}>
            {cmds.map((cmd) => (
              <Command.Item
                key={cmd.id}
                value={`cmd:${cmd.id}`}
                disabled={cmd.when ? !cmd.when() : false}
                onSelect={() => select(() => runCommand(cmd.id))}
                className={ITEM_CLS}
              >
                <span className="min-w-0 flex-1 truncate">{cmd.title}</span>
                <span className="shrink-0 text-2xs text-fg-faint">{group}</span>
                {cmd.shortcut ? <Kbd>{shortcutLabel(cmd.shortcut)}</Kbd> : null}
              </Command.Item>
            ))}
          </Command.Group>
        ))}

        {mode === "mixed" && text.length >= MIN_SEARCH ? (
          <Command.Group heading="Messages" className={GROUP_CLS}>
            {hits.map((hit, i) => (
              <Command.Item
                // biome-ignore lint/suspicious/noArrayIndexKey: hits replaced wholesale per query
                key={`${hit.sessionId}:${hit.seq ?? "x"}:${i}`}
                value={`hit:${i}`}
                onSelect={() => select(() => openHit(hit.sessionId, hit.seq))}
                className={ITEM_CLS}
              >
                <Search className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate">
                  <Highlighted text={hit.snippet} query={text} />
                </span>
                <span className="max-w-28 shrink-0 truncate text-2xs text-fg-faint">
                  {sessionLabel(hit.sessionId)}
                  {hit.seq !== undefined ? ` · #${hit.seq}` : ""}
                </span>
              </Command.Item>
            ))}
            {searching && hits.length === 0 ? (
              <div className="mx-1.5 flex h-8 items-center px-2 text-sm text-fg-muted">
                Searching messages…
              </div>
            ) : null}
          </Command.Group>
        ) : null}
      </Command.List>
    </>
  );
}
