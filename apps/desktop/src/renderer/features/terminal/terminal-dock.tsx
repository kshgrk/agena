// Bottom terminal dock (plan §7.9): 32px tab bar + xterm views + empty state.
// Registers terminal.toggle / terminal.new in the command registry.
import { Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { ContextMenu } from "radix-ui";
import { useEffect, useState } from "react";
import { chordLabel, useCommands } from "../../store/commands.ts";
import { useSessions, useUi } from "../../store/index.ts";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  IconButton,
  toast,
} from "../../ui/index.ts";
import {
  readXtermTheme,
  type TerminalTab,
  useTerminals,
} from "./terminal-store.ts";
import { TerminalView } from "./terminal-view.tsx";

/** New PTY in the active session's cwd; standalone (no keys) without one. */
function openInActiveCwd(): void {
  const { activeSessionId, byId } = useSessions.getState();
  const summary = activeSessionId ? byId[activeSessionId] : undefined;
  useTerminals
    .getState()
    .open(summary ? { cwd: summary.cwd, sessionId: summary.sessionId } : {})
    .catch((err: unknown) => {
      const message =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : "unknown error";
      toast(`Could not open terminal: ${message}`, { tone: "err" });
    });
}

function cwdTail(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? "terminal";
}

// Same look as ui/menu.tsx, on radix ContextMenu (cursor-positioned).
const MENU_CLS =
  "z-50 min-w-40 rounded-md border border-border bg-surface p-1 shadow-lg";
const ITEM_CLS =
  "flex cursor-default select-none items-center gap-2 rounded px-2 py-1 text-xs text-ink outline-none " +
  "data-[highlighted]:bg-raised data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

function DockTab({ tab, active }: { tab: TerminalTab; active: boolean }) {
  const [renaming, setRenaming] = useState(false);
  // Bump on menu open so `disabled` below sees the selection at open time.
  const [, setMenuOpen] = useState(false);

  const label = tab.label ?? cwdTail(tab.cwd);
  const commit = (value: string) => {
    useTerminals.getState().rename(tab.id, value);
    setRenaming(false);
  };

  return (
    <ContextMenu.Root onOpenChange={setMenuOpen}>
      <ContextMenu.Trigger asChild>
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
            "group flex h-8 min-w-0 shrink-0 cursor-default select-none items-center gap-1.5 border-r border-border px-2.5 text-xs transition-colors",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent",
            active
              ? "bg-surface text-ink"
              : "text-ink-dim hover:bg-raised hover:text-ink",
          )}
        >
          {tab.exited ? (
            <span
              title={`exited (code ${tab.exited.code ?? "?"})`}
              className={cx(
                "size-1.5 shrink-0 rounded-full",
                tab.exited.code === 0 ? "bg-ok" : "bg-err",
              )}
            />
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
              className="w-24 border-b border-accent bg-transparent font-mono text-xs text-ink outline-none"
            />
          ) : (
            <span className="max-w-36 truncate font-mono">{label}</span>
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
            className="rounded p-0.5 text-ink-mute opacity-0 transition-opacity hover:bg-overlay hover:text-ink focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU_CLS}>
          <ContextMenu.Item
            className={ITEM_CLS}
            onSelect={() => setRenaming(true)}
          >
            Rename
          </ContextMenu.Item>
          <ContextMenu.Item
            className={ITEM_CLS}
            disabled={!tab.readSelection()}
            onSelect={() => {
              const sel = tab.readSelection();
              if (sel) useUi.getState().requestComposerInsert(sel);
            }}
          >
            Send selection to composer
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function TerminalDock() {
  const tabs = useTerminals((s) => s.tabs);
  const activeId = useTerminals((s) => s.activeId);

  useEffect(
    () =>
      useCommands.getState().register([
        {
          id: "terminal.toggle",
          title: "Toggle Terminal",
          group: "Terminal",
          chord: "mod+j",
          keywords: ["dock", "shell", "pty"],
          run: () => useUi.getState().toggleTerminal(),
        },
        {
          id: "terminal.new",
          title: "New Terminal",
          group: "Terminal",
          chord: "mod+`",
          keywords: ["shell", "pty", "open"],
          run: () => {
            if (!useUi.getState().terminalOpen)
              useUi.getState().toggleTerminal();
            openInActiveCwd();
          },
        },
      ]),
    [],
  );

  // Live theme switch: re-read the xterm theme when data-theme flips.
  useEffect(() => {
    const mo = new MutationObserver(() => {
      const theme = readXtermTheme();
      for (const t of useTerminals.getState().tabs)
        t.term.options.theme = theme;
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => mo.disconnect();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div
        role="tablist"
        aria-label="Terminals"
        className="flex h-8 shrink-0 items-center border-b border-border bg-app"
      >
        <div className="flex h-full min-w-0 flex-1 items-center overflow-x-auto">
          {tabs.map((t) => (
            <DockTab key={t.id} tab={t} active={t.id === activeId} />
          ))}
        </div>
        <div className="flex shrink-0 items-center px-1">
          <IconButton
            label={`New terminal (${chordLabel("mod+`")})`}
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
            hint={`${chordLabel("mod+`")} opens one in the session cwd`}
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
