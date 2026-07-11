// Full-text search over bridge.search (the one bridge call this feature makes;
// everything else is store-driven). Hits are grouped by session; clicking a
// hit activates the session and jumps the transcript to the hit's seq.
//
// Jump contract: `useUi.requestJump(sessionId, seq)` is the store-level
// scroll-to request the transcript feature consumes (store/types.ts `jump`).
// We additionally run the `transcript.jumpTo` command id — the transcript
// feature may register it to focus/flash the target block; when unregistered
// it is a safe no-op (runCommand ignores unknown ids).
import type { SearchHit } from "@agena/protocol";
import { Search, SearchX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import { formatBridgeError } from "../../lib/errors.ts";
import { OPEN_SEARCH_EVENT } from "../../shell/panes.ts";
import { runCommand, useSessions, useUi } from "../../store/index.ts";
import { Badge, EmptyState, Input, Panel, Spinner } from "../../ui/index.ts";
import { splitMatches } from "./highlight.ts";

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

type SearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "error"; message: string }
  | { status: "ready"; query: string; hits: SearchHit[] };

/** Activate the hit's session; when seq-anchored, jump the transcript there. */
export function openSearchHit(sessionId: string, seq?: number): void {
  useSessions.getState().setActive(sessionId);
  if (seq !== undefined) {
    useUi.getState().setSelected({ sessionId, seq });
    useUi.getState().requestJump(sessionId, seq);
    runCommand("transcript.jumpTo"); // optional flash/focus hook, see header
  }
}

/** Snippet with <mark> per case-insensitive match (React escapes the rest). */
export function Snippet({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => splitMatches(text, query), [text, query]);
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are derived, replaced wholesale
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

type SessionGroup = { sessionId: string; hits: SearchHit[] };

/** Group rank-ordered hits by session, keeping first-appearance order. */
function groupBySession(hits: readonly SearchHit[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const byId = new Map<string, SessionGroup>();
  for (const hit of hits) {
    let g = byId.get(hit.sessionId);
    if (!g) {
      g = { sessionId: hit.sessionId, hits: [] };
      byId.set(hit.sessionId, g);
      groups.push(g);
    }
    g.hits.push(hit);
  }
  return groups;
}

export function SearchPane() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const reqRef = useRef(0);
  const sessionsById = useSessions((s) => s.byId);

  // shell reveal contract: the dock activates the pane, then re-fires this
  // event on the next frame so we can grab focus (shell/panes.ts).
  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener(OPEN_SEARCH_EVENT, focus);
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, focus);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      reqRef.current += 1; // invalidate anything in flight
      setState({ status: "idle" });
      return;
    }
    const id = ++reqRef.current;
    setState({ status: "searching" });
    const timer = setTimeout(() => {
      getBridge()
        .search(q, { limit: 50 })
        .then((hits) => {
          if (reqRef.current === id) {
            setState({ status: "ready", query: q, hits });
          }
        })
        .catch((err: unknown) => {
          if (reqRef.current === id) {
            setState({ status: "error", message: formatBridgeError(err) });
          }
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const groups = useMemo(
    () => (state.status === "ready" ? groupBySession(state.hits) : []),
    [state],
  );

  const sessionLabel = (sessionId: string): string =>
    sessionsById[sessionId]?.title ?? `session ${sessionId.slice(-6)}`;

  return (
    <Panel>
      <div className="shrink-0 border-b border-border-subtle p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-muted" />
          <Input
            ref={inputRef}
            fieldSize="md"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transcripts…"
            className="pl-7"
            spellCheck={false}
            aria-label="Search transcripts"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === "idle" ? (
          <EmptyState
            icon={Search}
            title="Search every session"
            hint={`Matches across all transcripts in this workspace. Type at least ${MIN_QUERY} characters.`}
          />
        ) : state.status === "searching" ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-fg-muted">
            <Spinner /> Searching…
          </div>
        ) : state.status === "error" ? (
          <EmptyState icon={SearchX} title="Search failed" hint={state.message} />
        ) : state.hits.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="No matches"
            hint={`Nothing matched “${state.query}”. Try a shorter or different term.`}
          />
        ) : (
          <div className="pb-2">
            <div className="px-3 py-1.5 text-2xs text-fg-muted tabular-nums">
              {state.hits.length} {state.hits.length === 1 ? "hit" : "hits"} in{" "}
              {groups.length} {groups.length === 1 ? "session" : "sessions"}
            </div>
            {groups.map((group) => (
              <div key={group.sessionId}>
                <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-border-subtle bg-surface px-3 py-1">
                  <span className="min-w-0 truncate text-2xs font-medium uppercase tracking-wider text-fg-muted">
                    {sessionLabel(group.sessionId)}
                  </span>
                  <span className="shrink-0 text-2xs text-fg-faint tabular-nums">
                    {group.hits.length}
                  </span>
                </div>
                {group.hits.map((hit, i) => (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: hits are replaced wholesale per query; index disambiguates duplicate (session, seq) pairs
                    key={`${hit.seq ?? "x"}:${i}`}
                    type="button"
                    onClick={() => openSearchHit(hit.sessionId, hit.seq)}
                    className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors duration-fast hover:bg-raised/60"
                  >
                    <div className="line-clamp-2 text-sm text-fg-secondary">
                      <Snippet text={hit.snippet} query={state.query} />
                    </div>
                    {hit.seq !== undefined ? (
                      <Badge className="self-start font-mono">#{hit.seq}</Badge>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
