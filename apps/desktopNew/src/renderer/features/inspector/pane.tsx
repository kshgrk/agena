// Inspector: the raw-event viewer for the active session. A virtualized,
// filterable list of durable events (seq · type · time) with expandable
// pretty-printed payloads. Strictly read-only against store selectors.
//
// Frame/event distinction: `rawEvents` holds durable EVENTS only — frames are
// transient by design (store/types.ts) and are folded into the in-flight tail.
// While a tail exists we render one synthetic footer row labeled "frames" so
// the streaming state is visible without pretending it is durable history.
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownToLine,
  Braces,
  Check,
  ChevronRight,
  Copy,
  Inbox,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RawEventRow } from "../../store/index.ts";
import { useSessions, useTranscripts, useUi } from "../../store/index.ts";
import {
  Badge,
  cx,
  EmptyState,
  IconButton,
  Panel,
  PanelHeader,
  Segmented,
} from "../../ui/index.ts";
import {
  familyOf,
  matchesTimelineFilter,
  TIMELINE_FILTERS,
  type TimelineFilter,
} from "../timeline/timeline-logic.ts";
import { eventClock, indexOfSeq, payloadJson } from "./inspector-logic.ts";

function useCopied(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy: (text) => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    },
  };
}

export function InspectorPane() {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  if (!activeSessionId) {
    return (
      <Panel>
        <PanelHeader title="Inspector" />
        <EmptyState
          icon={Braces}
          title="No session"
          hint="Pick a session to inspect its raw event stream."
        />
      </Panel>
    );
  }
  return <EventList key={activeSessionId} sessionId={activeSessionId} />;
}

function EventList({ sessionId }: { sessionId: string }) {
  const rawEvents = useTranscripts((s) => s.bySession[sessionId]?.rawEvents);
  const streaming = useTranscripts(
    (s) => s.bySession[sessionId]?.inFlight !== null,
  );
  const selected = useUi((s) =>
    s.selected?.sessionId === sessionId ? s.selected.seq : null,
  );
  const setSelected = useUi((s) => s.setSelected);

  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
  const [followTail, setFollowTail] = useState(true);

  const rows = useMemo(() => {
    const all = rawEvents ?? [];
    return filter === "all"
      ? all
      : all.filter((r) => matchesTimelineFilter(r.type, filter));
  }, [rawEvents, filter]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 12,
    getItemKey: (i) => rows[i]?.seq ?? i,
  });

  // follow-tail: stick to the newest event as durable events append
  useEffect(() => {
    if (followTail && rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    }
  }, [followTail, rows.length, virtualizer]);

  // external selection (timeline dot, search hit) → expand + reveal. Guarded
  // by a ref so appended events (rows identity changes) don't re-trigger the
  // scroll for an already-handled selection.
  const handledSel = useRef<number | null>(null);
  useEffect(() => {
    if (selected === null) {
      handledSel.current = null;
      return;
    }
    if (handledSel.current === selected) return;
    handledSel.current = selected;
    setExpandedSeq(selected);
    setFollowTail(false);
    const i = indexOfSeq(rows, selected);
    if (i >= 0) virtualizer.scrollToIndex(i, { align: "center" });
    // filtered-out or not-loaded seqs simply don't scroll — the filter chip
    // or paging older events in the transcript brings them back.
  }, [selected, rows, virtualizer]);

  const toggleRow = (seq: number) => {
    setFollowTail(false);
    const next = expandedSeq === seq ? null : seq;
    setExpandedSeq(next);
    handledSel.current = next; // a manual toggle IS the selection; don't re-scroll
    setSelected(next === null ? null : { sessionId, seq });
  };

  return (
    <Panel>
      <PanelHeader
        title="Inspector"
        actions={
          <>
            <span className="text-2xs text-fg-muted tabular-nums">
              {rows.length}
            </span>
            <IconButton
              label={followTail ? "Following tail — click to stop" : "Follow tail"}
              size="sm"
              onClick={() => setFollowTail((f) => !f)}
              className={followTail ? "text-accent" : undefined}
              aria-pressed={followTail}
            >
              <ArrowDownToLine />
            </IconButton>
          </>
        }
      />
      <div className="shrink-0 overflow-x-auto border-b border-border-subtle p-2">
        <Segmented
          value={filter}
          onValueChange={setFilter}
          options={TIMELINE_FILTERS.map((f) => ({ value: f.id, label: f.label }))}
          ariaLabel="Event family filter"
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No events"
          hint={
            filter === "all"
              ? "Events appear here as the session runs."
              : "Nothing matches this filter yet."
          }
        />
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto">
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <EventRow
                    row={row}
                    expanded={expandedSeq === row.seq}
                    onToggle={() => toggleRow(row.seq)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
      {streaming ? (
        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border-subtle px-3">
          <Badge tone="accent" className="font-mono">
            frames
          </Badge>
          <span className="shimmer-text text-xs text-fg-muted">
            streaming — in-flight deltas, not yet durable events
          </span>
        </div>
      ) : null}
    </Panel>
  );
}

function EventRow({
  row,
  expanded,
  onToggle,
}: {
  row: RawEventRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={cx(expanded && "bg-raised/60")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex h-7 w-full items-center gap-2 px-2 text-left transition-colors duration-fast hover:bg-raised/60"
      >
        <ChevronRight
          className={cx(
            "size-3.5 shrink-0 text-fg-faint transition-transform duration-base",
            expanded && "rotate-90",
          )}
        />
        <span
          className={`size-1.5 shrink-0 rounded-full ${familyOf(row.type).dotClass}`}
        />
        <span className="w-10 shrink-0 text-right text-2xs text-fg-faint tabular-nums">
          #{row.seq}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-sm text-fg-secondary"
          title={row.type}
        >
          {row.type}
        </span>
        <span className="shrink-0 text-2xs text-fg-muted tabular-nums">
          {eventClock(row.at)}
        </span>
      </button>
      {expanded ? <EventDetail row={row} /> : null}
    </div>
  );
}

function EventDetail({ row }: { row: RawEventRow }) {
  const json = useMemo(() => payloadJson(row.payload), [row.payload]);
  const { copied, copy } = useCopied();
  return (
    <div className="space-y-2 px-3 pb-3 pt-1 animate-fade-in">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          tone={
            row.source.kind === "user"
              ? "accent"
              : row.source.kind === "runtime"
                ? "info"
                : "neutral"
          }
        >
          {row.source.kind}
        </Badge>
        {row.source.runtime !== undefined ? (
          <Badge className="font-mono">{row.source.runtime}</Badge>
        ) : null}
        <Badge>event</Badge>
        <span
          className="ml-auto text-2xs text-fg-muted tabular-nums"
          title={row.at}
        >
          {new Date(row.at).toLocaleString()}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-2xs font-medium uppercase tracking-wider text-fg-muted">
          Payload
        </span>
        <IconButton
          label={copied ? "Copied" : "Copy JSON"}
          size="sm"
          onClick={() => copy(json)}
        >
          {copied ? <Check className="text-success" /> : <Copy />}
        </IconButton>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre rounded-md bg-inset p-2.5 font-mono text-sm text-fg">
        {json}
      </pre>
    </div>
  );
}
