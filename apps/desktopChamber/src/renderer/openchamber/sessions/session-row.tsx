// Source-derived from OpenChamber components/session/sidebar/SessionNodeItem.tsx (MIT).
import {
  Archive,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { memo, useState } from "react";
import type { OpenChamberSessionNode, SessionSidebarActions } from "./types.ts";

export type SessionRowProps = {
  node: OpenChamberSessionNode;
  active: boolean;
  depth?: number;
  expanded: boolean;
  onToggle: (sessionId: string) => void;
  actions: SessionSidebarActions;
};

export const OpenChamberSessionRow = memo(function OpenChamberSessionRow({
  node,
  active,
  depth = 0,
  expanded,
  onToggle,
  actions,
}: SessionRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const hasChildren = Boolean(node.children?.length);
  const activity = node.activity ?? "idle";
  return (
    <div className="group/session relative" data-session-id={node.id}>
      <div
        className={`relative flex min-h-8 items-center rounded-md pr-1 transition-colors duration-150 ${active ? "bg-interactive-active text-foreground" : "text-muted-foreground hover:bg-interactive-hover hover:text-foreground"}`}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        <button
          type="button"
          className={`oc-session-toggle flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity ${hasChildren ? "opacity-0 group-hover/session:opacity-100 focus-visible:opacity-100" : "pointer-events-none opacity-0"}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(node.id);
          }}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${node.title}`}
          aria-expanded={hasChildren ? expanded : undefined}
        >
          <ChevronRight
            className={`size-3.5 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
        </button>
        <span className="flex w-3 shrink-0 items-center justify-center">
          {activity !== "idle" ? (
            <span
              className={`size-1.5 rounded-full ${activity === "active" ? "bg-primary" : "bg-info"}`}
              title={activity === "active" ? "Running" : "Unread"}
            >
              <span className="sr-only">
                {activity === "active" ? "Running" : "Unread"}
              </span>
            </span>
          ) : null}
        </span>
        <button
          type="button"
          disabled={node.disabled}
          onClick={() => actions.selectSession(node.id)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left outline-none disabled:opacity-50"
        >
          <span
            className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${activity === "unread" ? "font-semibold text-foreground" : "font-medium"}`}
          >
            {node.title}
          </span>
          {activity === "active" && node.elapsed ? (
            <span className="shrink-0 text-[11px] tabular-nums text-primary">
              {node.elapsed}
            </span>
          ) : (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
              {node.time}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
          className={`oc-session-actions flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${menuOpen ? "opacity-100" : "opacity-0 group-hover/session:opacity-100 focus-visible:opacity-100"}`}
          aria-label={`Actions for ${node.title}`}
          aria-expanded={menuOpen}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </div>
      {node.context ? (
        <div
          className="pointer-events-none -mt-1 truncate pb-1 pr-8 text-[11px] text-muted-foreground/70"
          style={{ paddingLeft: 41 + depth * 14 }}
        >
          {node.context}
        </div>
      ) : null}
      {menuOpen ? (
        <div className="absolute right-1 top-7 z-50 min-w-40 rounded-lg border border-border bg-raised p-1 shadow-lg">
          {actions.renameSession ? (
            <MenuAction
              icon={<Pencil />}
              label="Rename"
              onClick={() => actions.renameSession?.(node.id)}
            />
          ) : null}
          {actions.archiveSession ? (
            <MenuAction
              icon={<Archive />}
              label="Archive"
              onClick={() => actions.archiveSession?.(node.id)}
            />
          ) : null}
          {actions.deleteSession ? (
            <MenuAction
              icon={<Trash2 />}
              label="Delete"
              danger
              onClick={() => actions.deleteSession?.(node.id)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

function MenuAction({
  icon,
  label,
  danger = false,
  onClick,
}: {
  icon: React.ReactElement<{ className?: string }>;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-interactive-hover ${danger ? "text-danger" : "text-foreground"}`}
      onClick={onClick}
    >
      <span className="[&>svg]:size-3.5">{icon}</span>
      {label}
    </button>
  );
}
