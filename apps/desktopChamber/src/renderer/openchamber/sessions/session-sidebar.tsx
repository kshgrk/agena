// Source-derived from OpenChamber SessionSidebar and its focused subcomponents (MIT).
import {
  Archive,
  ChevronDown,
  Clock3,
  Command,
  Info,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { OpenChamberSessionRow } from "./session-row.tsx";
import {
  aggregateActivity,
  filterSessionTree,
  type OpenChamberProjectNode,
  type OpenChamberSessionNode,
  PROJECT_SESSION_PREVIEW_LIMIT,
  projectSessionPreview,
  type SessionSidebarActions,
  sessionTreeContains,
} from "./types.ts";

export type OpenChamberSessionSidebarProps = {
  activeSessionId: string | null;
  recent?: readonly OpenChamberSessionNode[];
  projects: readonly OpenChamberProjectNode[];
  globalSessions?: readonly OpenChamberSessionNode[];
  actions: SessionSidebarActions;
  initialCollapsedProjects?: readonly string[];
  initialExpandedSessions?: readonly string[];
  title?: string;
  footer?: React.ReactNode;
};

export function OpenChamberSessionSidebar({
  activeSessionId,
  recent = [],
  projects,
  globalSessions = [],
  actions,
  initialCollapsedProjects = [],
  initialExpandedSessions = [],
  title = "Sessions",
  footer,
}: OpenChamberSessionSidebarProps) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement | null>(null);
  const [collapsed, setCollapsed] = useState(
    () => new Set(initialCollapsedProjects),
  );
  const [expanded, setExpanded] = useState(
    () => new Set(initialExpandedSessions),
  );
  const [showAllProjects, setShowAllProjects] = useState(
    () => new Set<string>(),
  );
  const normalizedProjects = useMemo(
    () =>
      projects
        .map((project) => ({
          ...project,
          sessions: filterSessionTree(project.sessions, query),
        }))
        .filter((project) => project.sessions.length > 0 || !query.trim()),
    [projects, query],
  );

  useEffect(() => {
    if (!searching) return;
    const frame = requestAnimationFrame(() => searchInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [searching]);

  useEffect(() => {
    if (!activeSessionId) return;
    const project = normalizedProjects.find(
      (candidate) =>
        candidate.sessions.length > PROJECT_SESSION_PREVIEW_LIMIT &&
        !sessionTreeContains(
          candidate.sessions.slice(0, PROJECT_SESSION_PREVIEW_LIMIT),
          activeSessionId,
        ) &&
        sessionTreeContains(candidate.sessions, activeSessionId),
    );
    if (!project) return;
    setShowAllProjects((current) => {
      if (current.has(project.id)) return current;
      const next = new Set(current);
      next.add(project.id);
      return next;
    });
  }, [activeSessionId, normalizedProjects]);

  function toggle(setter: typeof setExpanded, id: string): void {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filteredRecent = filterSessionTree(recent, query);
  const filteredGlobal = filterSessionTree(globalSessions, query);
  return (
    <div className="chamber-session-sidebar flex h-full min-h-0 flex-col bg-sidebar text-foreground">
      <header className="chamber-session-header flex h-12 shrink-0 items-center gap-1 px-2.5">
        {searching ? (
          <div className="flex min-w-0 flex-1 items-center rounded-lg bg-interactive-hover px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  setSearching(false);
                }
              }}
              placeholder="Search sessions"
              className="h-8 min-w-0 flex-1 bg-transparent px-2 text-[13px] outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setSearching(false);
              }}
              className="flex size-6 items-center justify-center rounded-md hover:bg-interactive-active"
              aria-label="Close search"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <>
            <strong className="min-w-0 flex-1 truncate text-sm font-semibold">
              {title}
            </strong>
            <HeaderButton label="Search" onClick={() => setSearching(true)}>
              <Search />
            </HeaderButton>
            <HeaderButton
              label="New session"
              onClick={() => actions.createSession?.(null)}
            >
              <Plus />
            </HeaderButton>
          </>
        )}
      </header>

      <nav className="shrink-0 space-y-0.5 px-2 pb-2">
        <NavRow
          icon={<Plus />}
          label="New session"
          onClick={() => actions.createSession?.(null)}
        />
        <NavRow icon={<Archive />} label="Archive" />
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {filteredRecent.length ? (
          <Section title="recent" icon={<Clock3 />}>
            <SessionTree
              sessions={filteredRecent}
              activeSessionId={activeSessionId}
              expanded={expanded}
              onToggle={(id) => toggle(setExpanded, id)}
              actions={actions}
            />
          </Section>
        ) : null}

        {normalizedProjects.map((project) => {
          const projectCollapsed = collapsed.has(project.id);
          const showingAll = showAllProjects.has(project.id);
          const visibleSessions = projectSessionPreview(
            project.sessions,
            showingAll,
            query,
          );
          const hiddenCount =
            project.sessions.length - PROJECT_SESSION_PREVIEW_LIMIT;
          const activity =
            project.activity ?? aggregateActivity(project.sessions);
          return (
            <section key={project.id} className="relative mt-1">
              <div className="sticky top-0 z-20 -mx-2.5 bg-sidebar px-2.5">
                <div className="group/project flex h-8 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggle(setCollapsed, project.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    aria-expanded={!projectCollapsed}
                  >
                    <ChevronDown
                      className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ${projectCollapsed ? "-rotate-90" : ""}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
                      {project.label}
                    </span>
                    {projectCollapsed && activity ? (
                      <span
                        className={`mr-1 size-1.5 rounded-full ${activity === "active" ? "bg-primary" : "bg-info"}`}
                      />
                    ) : null}
                  </button>
                  <button
                    type="button"
                    onClick={() => actions.createSession?.(project.id)}
                    className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-interactive-hover hover:text-foreground group-hover/project:opacity-100 focus-visible:opacity-100"
                    aria-label={`New session in ${project.label}`}
                  >
                    <Plus className="size-3.5" />
                  </button>
                </div>
              </div>
              {!projectCollapsed ? (
                <>
                  <SessionTree
                    sessions={visibleSessions}
                    activeSessionId={activeSessionId}
                    expanded={expanded}
                    onToggle={(id) => toggle(setExpanded, id)}
                    actions={actions}
                  />
                  {!query.trim() && hiddenCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => toggle(setShowAllProjects, project.id)}
                      className="ml-5 mt-0.5 flex h-7 items-center rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
                    >
                      {showingAll ? "Show less" : `Show ${hiddenCount} more`}
                    </button>
                  ) : null}
                </>
              ) : null}
            </section>
          );
        })}

        {filteredGlobal.length ? (
          <Section title="global">
            <SessionTree
              sessions={filteredGlobal}
              activeSessionId={activeSessionId}
              expanded={expanded}
              onToggle={(id) => toggle(setExpanded, id)}
              actions={actions}
            />
          </Section>
        ) : null}
      </div>

      {footer ?? (
        <footer className="flex shrink-0 items-center gap-1 px-2.5 py-2">
          <FooterButton label="Settings" onClick={actions.openSettings}>
            <Settings />
          </FooterButton>
          <FooterButton label="Shortcuts" onClick={actions.openShortcuts}>
            <Command />
          </FooterButton>
          <FooterButton label="About" onClick={actions.openAbout}>
            <Info />
          </FooterButton>
        </footer>
      )}
    </div>
  );
}

function SessionTree({
  sessions,
  activeSessionId,
  expanded,
  onToggle,
  actions,
  depth = 0,
}: {
  sessions: readonly OpenChamberSessionNode[];
  activeSessionId: string | null;
  expanded: ReadonlySet<string>;
  onToggle: (sessionId: string) => void;
  actions: SessionSidebarActions;
  depth?: number;
}) {
  return sessions.map((node) => {
    const open = expanded.has(node.id);
    return (
      <div key={node.id}>
        <OpenChamberSessionRow
          node={node}
          active={node.id === activeSessionId}
          depth={depth}
          expanded={open}
          onToggle={onToggle}
          actions={actions}
        />
        {open && node.children?.length ? (
          <SessionTree
            sessions={node.children}
            activeSessionId={activeSessionId}
            expanded={expanded}
            onToggle={onToggle}
            actions={actions}
            depth={depth + 1}
          />
        ) : null}
      </div>
    );
  });
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-1">
      <div className="sticky top-0 z-20 -mx-2.5 flex h-8 items-center gap-1.5 bg-sidebar px-3.5">
        <span className="[&>svg]:size-3.5 text-muted-foreground">{icon}</span>
        <span className="text-[14px] font-semibold lowercase">{title}</span>
      </div>
      {children}
    </section>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: (() => void) | undefined;
  children: React.ReactElement;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground [&>svg]:size-4"
      aria-label={label}
    >
      {children}
    </button>
  );
}

function FooterButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: (() => void) | undefined;
  children: React.ReactElement;
}) {
  return (
    <HeaderButton label={label} onClick={onClick}>
      {children}
    </HeaderButton>
  );
}

function NavRow({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactElement;
  label: string;
  onClick?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground [&>svg]:size-4"
    >
      {icon}
      {label}
    </button>
  );
}
