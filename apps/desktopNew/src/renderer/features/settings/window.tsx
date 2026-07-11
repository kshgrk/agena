// The settings window: a routed overlay surface (design.md §13 — 880×600,
// bg-surface, left nav) bound to useUi.settingsOpen, with section routing in
// useSettingsView. Mounted always by the shell; renders nothing while closed.
// D-INV-3: app.tsx treats settingsOpen as an overlay signal, so the native
// browser view is hidden while this window is up.
import type { LucideIcon } from "lucide-react";
import {
  FolderInput,
  Info,
  Plug,
  Server,
  Sparkles,
  WalletCards,
  X,
} from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useMemo, useState } from "react";
import { useUi } from "../../store/index.ts";
import { cx, IconButton, Input, ScrollArea } from "../../ui/index.ts";
import { AboutSection } from "./about.tsx";
import { ConnectionSection } from "./connection.tsx";
import { filterSettingsItems } from "./lib.ts";
import { McpSection } from "./mcp.tsx";
import { ProvidersSection } from "./providers.tsx";
import { SessionImportSection } from "./session-import.tsx";
import { SkillsSection } from "./skills.tsx";
import { type SettingsSection, useSettingsView } from "./store.ts";

const SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  title: string;
  icon: LucideIcon;
  keywords: readonly string[];
}> = [
  {
    id: "connection",
    title: "Connection",
    icon: Plug,
    keywords: ["daemon", "profile", "diagnostics", "theme"],
  },
  {
    id: "providers",
    title: "Providers",
    icon: WalletCards,
    keywords: ["models", "api key", "oauth", "subscription"],
  },
  {
    id: "mcp",
    title: "MCP servers",
    icon: Server,
    keywords: ["tools", "servers", "oauth", "import"],
  },
  {
    id: "skills",
    title: "Skills",
    icon: Sparkles,
    keywords: ["agents", "instructions", "import", "update"],
  },
  {
    id: "import",
    title: "Session import",
    icon: FolderInput,
    keywords: ["claude", "codex", "pi", "migrate"],
  },
  {
    id: "about",
    title: "About",
    icon: Info,
    keywords: ["version", "licenses"],
  },
];

function SectionBody({ section }: { section: SettingsSection }) {
  switch (section) {
    case "connection":
      return <ConnectionSection />;
    case "providers":
      return <ProvidersSection />;
    case "mcp":
      return <McpSection />;
    case "skills":
      return <SkillsSection />;
    case "import":
      return <SessionImportSection />;
    case "about":
      return <AboutSection />;
  }
}

export function SettingsWindow() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const section = useSettingsView((s) => s.section);
  const setSection = useSettingsView((s) => s.setSection);
  const [query, setQuery] = useState("");
  const visibleSections = useMemo(
    () => filterSettingsItems(SECTIONS, query),
    [query],
  );

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-canvas/60 animate-fade-in" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className={cx(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "flex h-[600px] max-h-[85vh] w-[880px] max-w-[calc(100vw-32px)]",
            "overflow-hidden rounded-xl border border-border bg-surface shadow-overlay",
            "animate-fade-in",
          )}
        >
          <nav
            aria-label="Settings sections"
            className="flex w-40 shrink-0 flex-col border-r border-border-subtle p-2"
          >
            <RadixDialog.Title className="px-2 pb-2 pt-1 text-lg font-semibold text-fg">
              Settings
            </RadixDialog.Title>
            <Input
              fieldSize="md"
              value={query}
              aria-label="Search settings"
              placeholder="Search…"
              className="mb-2"
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="space-y-0.5">
              {visibleSections.map(({ id, title, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSection(id)}
                  className={cx(
                    "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
                    section === id
                      ? "bg-raised text-fg"
                      : "text-fg-secondary hover:bg-raised/60",
                  )}
                >
                  <Icon className="size-4 shrink-0 text-fg-muted" />
                  <span className="truncate">{title}</span>
                </button>
              ))}
              {visibleSections.length === 0 ? (
                <p className="px-2 py-3 text-xs text-fg-muted">
                  No settings found
                </p>
              ) : null}
            </div>
          </nav>
          <div className="relative min-w-0 flex-1">
            <div className="absolute right-3 top-3 z-10">
              <RadixDialog.Close asChild>
                <IconButton label="Close settings" noTooltip>
                  <X />
                </IconButton>
              </RadixDialog.Close>
            </div>
            <ScrollArea className="h-full p-6">
              <div className="max-w-[560px]">
                <SectionBody section={section} />
              </div>
            </ScrollArea>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
