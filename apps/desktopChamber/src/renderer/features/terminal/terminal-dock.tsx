// Bottom terminal dock (features.md §5.10): 32px tab bar + per-tab xterm
// views (all mounted, inactive ones hidden — scrollback preserved) + empty
// state. Registers terminal.toggle / terminal.new in the command registry.
import { Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatBridgeError } from "../../lib/errors.ts";
import {
  pushToast,
  registerCommands,
  shortcutLabel,
  useSessions,
  useUi,
} from "../../store/index.ts";
import {
  Badge,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cx,
  EmptyState,
  IconButton,
  StatusDot,
} from "../../ui/index.ts";
import { exitText, tabLabel } from "./terminal-logic.ts";
import {
  readXtermTheme,
  type TerminalTab,
  useTerminals,
} from "./terminal-store.ts";
import { TerminalView } from "./terminal-view.tsx";

/** New PTY in the active session's cwd; standalone (daemon default) without one. */
function openInActiveCwd(): void {
  const { activeSessionId, byId } = useSessions.getState();
  const summary = activeSessionId ? byId[activeSessionId] : undefined;
  useTerminals
    .getState()
    .open(summary ? { cwd: summary.cwd, sessionId: summary.sessionId } : {})
    .catch((err: unknown) => {
      pushToast({
        kind: "err",
        title: "Could not open terminal",
        detail: formatBridgeError(err),
      });
    });
}

function DockTab({ tab, active }: { tab: TerminalTab; active: boolean }) {
  const [renaming, setRenaming] = useState(false);
  // Bump on menu open so the "Send selection" disabled state reflects the
  // selection at open time (readSelection is not reactive).
  const [, setMenuOpen] = useState(false);

  const label = tabLabel(tab);
  const commit = (value: string) => {
    useTerminals.getState().rename(tab.id, value);
    setRenaming(false);
  };

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger>
        <div
          role="tab"
          aria-selected={active}
          tabIndex={0}
          onClick={() => useTerminals.getState().setActive(tab.id)}
          onDoubleClick={() => setRenaming(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ")
              useTerminals.getState().setActive(tab.id);
          }}
          className={cx(
            // dockview tab spec (design.md §5): 32px, text-xs, no tab
            // backgrounds, active = text-fg + 1px accent underline.
            "group flex h-8 min-w-0 shrink-0 cursor-default select-none items-center gap-1.5 border-b px-2.5 text-xs transition-colors",
            active
              ? "border-accent text-fg"
              : "border-transparent text-fg-muted hover:text-fg-secondary",
          )}
        >
          {tab.exited ? (
            <StatusDot
              label={exitText(tab.exited)}
              className={tab.exited.code === 0 ? "bg-success" : "bg-danger"}
            />
          ) : tab.bell ? (
            <StatusDot label="bell" className="bg-warn" />
          ) : null}
          {renaming ? (
            <input
              ref={(el) => el?.focus()}
              defaultValue={label}
              aria-label="Rename terminal"
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commit(e.currentTarget.value);
                else if (e.key === "Escape") setRenaming(false);
              }}
              onBlur={(e) => commit(e.currentTarget.value)}
              className="w-24 border-b border-accent bg-transparent font-mono text-xs text-fg"
            />
          ) : (
            <span className="max-w-40 truncate font-mono">{label}</span>
          )}
          {tab.sessionId ? (
            <Badge tone="accent" className="shrink-0">
              {tab.sessionId.slice(-4)}
            </Badge>
          ) : null}
          <button
            type="button"
            aria-label={`Close ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              useTerminals.getState().close(tab.id);
            }}
            className="rounded-md p-0.5 text-fg-muted opacity-0 transition-opacity hover:bg-fg/10 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => setRenaming(true)}>
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!tab.readSelection()}
          onSelect={() => {
            const sel = tab.readSelection();
            if (sel) useUi.getState().requestComposerInsert(sel);
          }}
        >
          Send selection to composer
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          danger
          onSelect={() => useTerminals.getState().close(tab.id)}
        >
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function TerminalDock() {
  const tabs = useTerminals((s) => s.tabs);
  const activeId = useTerminals((s) => s.activeId);

  useEffect(
    () =>
      registerCommands([
        {
          id: "terminal.toggle",
          title: "Toggle Terminal",
          group: "Terminal",
          shortcut: "mod+j",
          keywords: ["dock", "shell", "pty"],
          run: () => useUi.getState().toggleTerminal(),
        },
        {
          id: "terminal.new",
          title: "New Terminal",
          group: "Terminal",
          shortcut: "mod+`",
          keywords: ["shell", "pty", "open"],
          run: () => {
            useUi.getState().setTerminalOpen(true);
            openInActiveCwd();
          },
        },
      ]),
    [],
  );

  // Live theme switch: each family owns a terminal palette.
  useEffect(() => {
    const mo = new MutationObserver(() => {
      const theme = readXtermTheme();
      for (const t of useTerminals.getState().tabs)
        t.term.options.theme = theme;
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-appearance"],
    });
    return () => mo.disconnect();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div
        role="tablist"
        aria-label="Terminals"
        className="flex h-8 shrink-0 items-center border-b border-border-subtle"
      >
        <div className="flex h-full min-w-0 flex-1 items-center overflow-x-auto">
          {tabs.map((t) => (
            <DockTab key={t.id} tab={t} active={t.id === activeId} />
          ))}
        </div>
        <div className="flex shrink-0 items-center px-1">
          <IconButton
            label={`New terminal (${shortcutLabel("mod+`")})`}
            size="sm"
            onClick={openInActiveCwd}
          >
            <Plus />
          </IconButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <EmptyState
            icon={TerminalIcon}
            title="No terminals"
            hint={`${shortcutLabel("mod+`")} opens one in the session cwd`}
            action={
              <Button size="sm" icon={<Plus />} onClick={openInActiveCwd}>
                New terminal
              </Button>
            }
          />
        ) : (
          tabs.map((t) => (
            <div
              key={t.id}
              className={cx("absolute inset-0", t.id !== activeId && "hidden")}
            >
              <TerminalView tab={t} active={t.id === activeId} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
