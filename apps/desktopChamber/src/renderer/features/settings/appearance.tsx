import { Check } from "lucide-react";
import type { ThemeAppearance, ThemeFamily } from "../../../shared/bridge.ts";
import { useUi } from "../../store/index.ts";
import { cx, Segmented } from "../../ui/index.ts";
import { Field, GroupLabel, SectionHeader } from "./common.tsx";

const FAMILIES: ReadonlyArray<{
  id: ThemeFamily;
  name: string;
  description: string;
  accessibility?: boolean;
}> = [
  {
    id: "graphite",
    name: "Graphite & Iris",
    description: "Neutral graphite with a restrained iris signal.",
  },
  {
    id: "folio",
    name: "Folio & Ember",
    description: "Warm, editorial, and comfortable for long transcripts.",
  },
  {
    id: "cobalt",
    name: "Cobalt & Steel",
    description: "Crisp, cool, and tuned for dense engineering work.",
  },
  {
    id: "signal",
    name: "Signal",
    description: "Maximum separation and legibility.",
    accessibility: true,
  },
  {
    id: "evergreen",
    name: "Evergreen Dusk",
    description: "Muted sage surfaces with a warm, low-glare foreground.",
  },
  {
    id: "clay",
    name: "Clay Studio",
    description: "Soft earthen neutrals with a restrained ember accent.",
  },
  {
    id: "harbor",
    name: "Harbor Mist",
    description: "Calm blue-gray surfaces with a softened steel signal.",
  },
];

const COMFORT_FAMILIES = new Set<ThemeFamily>(["evergreen", "clay", "harbor"]);

function ThemePreview({
  family,
  selected,
}: {
  family: ThemeFamily;
  selected: boolean;
}) {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const previewAppearance =
    theme.appearance === "dim"
      ? "dim"
      : theme.appearance === "system"
        ? document.documentElement.dataset.appearance === "light"
          ? "light"
          : "dark"
        : theme.appearance;
  const spec = FAMILIES.find((item) => item.id === family);
  if (!spec) return null;
  return (
    <button
      type="button"
      data-theme={family}
      data-appearance={previewAppearance}
      aria-pressed={selected}
      onClick={() => setTheme({ ...theme, family })}
      className={cx(
        "group rounded-xl border bg-canvas p-3 text-left transition-colors",
        selected
          ? "border-accent ring-1 ring-accent"
          : "border-border hover:border-border-strong",
      )}
    >
      <span className="flex items-start justify-between gap-2">
        <span>
          <span className="block text-sm font-semibold text-fg">
            {spec.name}
          </span>
          <span className="mt-0.5 block text-xs text-fg-muted">
            {spec.description}
          </span>
        </span>
        {selected ? <Check className="size-4 shrink-0 text-accent" /> : null}
      </span>
      <span className="mt-3 block rounded-lg border border-border bg-surface p-2">
        <span className="block text-sm text-fg">
          Aa&nbsp; Build the smallest correct change.
        </span>
        <span className="mt-2 flex items-center gap-2 rounded bg-raised px-2 py-1 text-xs text-fg-secondary">
          <span className="size-1.5 rounded-full bg-tool-running" /> Running
          tool
          <span className="ml-auto text-diff-add-fg">+12</span>
          <span className="text-diff-del-fg">−4</span>
        </span>
      </span>
      {spec.accessibility ? (
        <span className="mt-2 block text-2xs font-medium uppercase tracking-wider text-info">
          Accessibility
        </span>
      ) : null}
    </button>
  );
}

export function AppearanceSection() {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const visibleFamilies = FAMILIES.filter((family) =>
    theme.appearance === "dim"
      ? COMFORT_FAMILIES.has(family.id)
      : !COMFORT_FAMILIES.has(family.id),
  );
  return (
    <div>
      <SectionHeader
        title="Appearance"
        description="Choose one complete Agena theme for desktop and phone."
      />
      <div className="space-y-5">
        <Field label="Mode" hint="System follows your device appearance.">
          <Segmented<ThemeAppearance>
            ariaLabel="Appearance mode"
            value={theme.appearance}
            onValueChange={(appearance) => setTheme({ ...theme, appearance })}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dim", label: "Dim" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </Field>
        <div>
          <GroupLabel>Theme</GroupLabel>
          <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
            {visibleFamilies.map((family) => (
              <ThemePreview
                key={family.id}
                family={family.id}
                selected={theme.family === family.id}
              />
            ))}
          </div>
        </div>
        <p className="text-xs text-fg-muted">
          Code, diffs, tools, diagrams, and the terminal inherit the selected
          family.
        </p>
      </div>
    </div>
  );
}
