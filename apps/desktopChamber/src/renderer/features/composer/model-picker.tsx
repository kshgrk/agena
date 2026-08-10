// Model combobox (replaces the unusable flat menu): Pi's runtimeInfo returns
// the entire multi-provider catalog (50+ ids), so this needs filter-as-you-
// type, provider grouping, and a scrollable list. cmdk inside a Popover,
// styled to match the palette. Overlay-counted per D-INV-3.
import type { ModelRef } from "@agena/protocol";
import { Command } from "cmdk";
import { Check, ChevronDown, Cpu } from "lucide-react";
import { useMemo, useState } from "react";
import { useUi } from "../../store/index.ts";
import {
  cx,
  Dialog,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../ui/index.ts";

const ITEM_CLS =
  "mx-1.5 flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm text-fg-secondary " +
  "data-[selected=true]:bg-raised data-[selected=true]:text-fg";

const GROUP_CLS =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 " +
  "[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium " +
  "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider " +
  "[&_[cmdk-group-heading]]:text-fg-muted";

export function ModelPicker({
  models,
  current,
  label,
  chipCls,
  onPick,
  mobile = false,
}: {
  models: readonly ModelRef[];
  current: ModelRef | null | undefined;
  label: string;
  chipCls: string;
  onPick: (model: ModelRef) => void;
  mobile?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const enterOverlay = useUi((s) => s.enterOverlay);
  const exitOverlay = useUi((s) => s.exitOverlay);

  // group by provider, providers and ids each sorted; current provider first
  const groups = useMemo(() => {
    const by = new Map<string, ModelRef[]>();
    for (const m of models) {
      const g = by.get(m.provider);
      if (g) g.push(m);
      else by.set(m.provider, [m]);
    }
    const names = [...by.keys()].sort((a, b) =>
      a === current?.provider
        ? -1
        : b === current?.provider
          ? 1
          : a.localeCompare(b),
    );
    return names.map((name) => ({
      name,
      models: (by.get(name) ?? []).sort((a, b) => a.id.localeCompare(b.id)),
    }));
  }, [models, current?.provider]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) enterOverlay();
    else exitOverlay();
  };

  const trigger = (
    <button
      type="button"
      aria-label="Model"
      className={chipCls}
      onClick={mobile ? () => onOpenChange(true) : undefined}
    >
      <Cpu />
      <span className="truncate">{label}</span>
      <ChevronDown />
    </button>
  );
  const picker = (
    <Command loop className="outline-none">
      <Command.Input
        autoFocus
        placeholder="Filter models…"
        className={cx(
          "w-full border-b border-border-subtle bg-transparent px-3 text-fg outline-none placeholder:text-fg-muted",
          mobile ? "h-12 text-base" : "h-9 text-sm",
        )}
      />
      <Command.List
        className={cx(
          "overflow-y-auto overscroll-contain py-1",
          mobile ? "max-h-[50dvh]" : "max-h-80",
        )}
      >
        <Command.Empty className="px-3 py-6 text-center text-sm text-fg-muted">
          No authenticated models
        </Command.Empty>
        {groups.map((g) => (
          <Command.Group key={g.name} heading={g.name} className={GROUP_CLS}>
            {g.models.map((m) => {
              const isCurrent =
                m.id === current?.id && m.provider === current?.provider;
              return (
                <Command.Item
                  key={`${m.provider}/${m.id}`}
                  // provider searchable too: "bedrock sonnet" narrows both
                  value={`${m.provider} ${m.id}`}
                  onSelect={() => {
                    onOpenChange(false);
                    onPick(m);
                  }}
                  className={cx(
                    ITEM_CLS,
                    mobile && "h-11 px-3 text-base",
                    isCurrent && "text-accent",
                  )}
                >
                  <Check
                    className={cx(
                      "size-3.5 shrink-0",
                      isCurrent ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{m.id}</span>
                </Command.Item>
              );
            })}
          </Command.Group>
        ))}
      </Command.List>
      {models.length > 0 ? (
        <div className="border-t border-border-subtle px-3 py-1.5 text-2xs text-fg-muted">
          {models.length} models · type to filter
        </div>
      ) : null}
    </Command>
  );

  if (mobile) {
    return (
      <>
        {trigger}
        <Dialog
          open={open}
          onOpenChange={onOpenChange}
          bottomSheet
          className="w-full max-w-none rounded-b-none p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <DialogTitle className="sr-only">Choose model</DialogTitle>
          {picker}
        </Dialog>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger>{trigger}</PopoverTrigger>
      <PopoverContent className="w-88 p-0" align="start" side="top">
        {picker}
      </PopoverContent>
    </Popover>
  );
}
