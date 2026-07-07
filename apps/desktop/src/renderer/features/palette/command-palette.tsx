// Command palette (plan §7.8): cmdk overlay, a pure projection of the command
// registry — grouped, fuzzy-filtered, chord labels right-aligned.
import { Command } from "cmdk";
import { useMemo } from "react";
import {
  allCommands,
  type CommandDef,
  chordLabel,
  useCommands,
} from "../../store/commands.ts";
import { useUi } from "../../store/index.ts";
import { Kbd } from "../../ui/index.ts";

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const byId = useCommands((s) => s.byId);

  const groups = useMemo(() => {
    const m = new Map<string, CommandDef[]>();
    for (const cmd of allCommands(byId)) {
      const list = m.get(cmd.group);
      if (list) list.push(cmd);
      else m.set(cmd.group, [cmd]);
    }
    return [...m.entries()];
  }, [byId]);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setPaletteOpen}
      label="Command palette"
      loop
      overlayClassName="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
      contentClassName="fixed left-1/2 top-[20%] z-50 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-raised shadow-xl focus:outline-none"
    >
      <Command.Input
        placeholder="Type a command…"
        className="h-10 w-full border-b border-border bg-transparent px-3 text-sm text-ink placeholder:text-ink-mute focus:outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-1">
        <Command.Empty className="px-3 py-6 text-center text-xs text-ink-mute">
          No matching commands
        </Command.Empty>
        {groups.map(([group, cmds]) => (
          <Command.Group
            key={group}
            heading={group}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-ink-mute"
          >
            {cmds.map((cmd) => (
              <Command.Item
                key={cmd.id}
                // title first for scoring, id suffix for uniqueness
                value={`${cmd.title}·${cmd.id}`}
                keywords={cmd.keywords ?? []}
                disabled={cmd.enabled ? !cmd.enabled() : false}
                onSelect={() => {
                  setPaletteOpen(false);
                  useCommands.getState().run(cmd.id);
                }}
                className="flex h-7 cursor-default items-center justify-between gap-3 rounded px-2 text-[13px] text-ink-dim data-[disabled=true]:opacity-40 data-[selected=true]:bg-accent/10 data-[selected=true]:text-ink"
              >
                <span className="truncate">{cmd.title}</span>
                {cmd.chord ? <Kbd>{chordLabel(cmd.chord)}</Kbd> : null}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
