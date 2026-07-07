// Full-text search across sessions with jump-to-seq (plan D3, FN-8 path).
import type { SearchHit } from "@agena/protocol";
import { Search, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import { useSessions, useUi } from "../../store/index.ts";
import {
  EmptyState,
  PanelHeader,
  PanelShell,
  Spinner,
  TextInput,
} from "../../ui/index.ts";

const errMessage = (err: unknown): string =>
  typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : String(err);

/** Snippet with <mark> on each case-insensitive match; React escapes the rest. */
function highlightSnippet(snippet: string, query: string): ReactNode[] {
  if (!query) return [snippet];
  const q = query.toLowerCase();
  const lower = snippet.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const at = lower.indexOf(q, i);
    if (at < 0) {
      out.push(snippet.slice(i));
      return out;
    }
    if (at > i) out.push(snippet.slice(i, at));
    out.push(
      <mark key={key++} className="rounded-[2px] bg-accent/20 text-accent">
        {snippet.slice(at, at + q.length)}
      </mark>,
    );
    i = at + q.length;
  }
}

type SearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "error"; message: string }
  | { status: "ready"; query: string; hits: SearchHit[] };

export function SearchPane() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const reqRef = useRef(0);
  const byId = useSessions((s) => s.byId);

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener("agena:open-search", focus);
    return () => window.removeEventListener("agena:open-search", focus);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      reqRef.current++;
      setState({ status: "idle" });
      return;
    }
    const id = ++reqRef.current;
    setState({ status: "searching" });
    const timer = setTimeout(() => {
      getBridge()
        .search(q)
        .then((hits) => {
          if (reqRef.current === id)
            setState({ status: "ready", query: q, hits });
        })
        .catch((err) => {
          if (reqRef.current === id)
            setState({ status: "error", message: errMessage(err) });
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const openHit = (hit: SearchHit) => {
    useSessions.getState().setActive(hit.sessionId);
    if (hit.seq !== undefined) {
      useUi.getState().setSelected({ sessionId: hit.sessionId, seq: hit.seq });
      useUi.getState().requestJump(hit.sessionId, hit.seq);
    }
  };

  return (
    <PanelShell>
      <PanelHeader title="Search" />
      <div className="shrink-0 border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-mute" />
          <TextInput
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            className="pl-7"
            spellCheck={false}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "idle" ? (
          <EmptyState
            icon={Search}
            title="Search every session"
            hint="Matches across all transcripts in this workspace. Type at least two characters."
          />
        ) : state.status === "searching" ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-ink-mute">
            <Spinner /> searching…
          </div>
        ) : state.status === "error" ? (
          <EmptyState
            icon={SearchX}
            title="Search failed"
            hint={state.message}
          />
        ) : state.hits.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title={`No matches for “${state.query}”`}
            hint="Try a shorter or different term."
          />
        ) : (
          <>
            <div className="px-3 py-1.5 text-[11px] text-ink-mute">
              {state.hits.length} {state.hits.length === 1 ? "hit" : "hits"}
            </div>
            {state.hits.map((hit, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: hits list is replaced wholesale per query; index disambiguates duplicate (session, seq) pairs
                key={`${hit.sessionId}:${hit.seq ?? "x"}:${i}`}
                type="button"
                onClick={() => openHit(hit)}
                className="flex w-full flex-col gap-1 border-b border-border px-3 py-2 text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-xs font-medium text-ink">
                    {byId[hit.sessionId]?.title ??
                      `session ${hit.sessionId.slice(-6)}`}
                  </span>
                  {hit.seq !== undefined ? (
                    <span className="shrink-0 rounded border border-border bg-raised px-1 font-mono text-[10px] leading-4 text-ink-mute">
                      #{hit.seq}
                    </span>
                  ) : null}
                </div>
                <div className="line-clamp-2 text-xs leading-4 text-ink-dim">
                  {highlightSnippet(hit.snippet, state.query)}
                </div>
              </button>
            ))}
          </>
        )}
      </div>
    </PanelShell>
  );
}
