import type {
  ThemeAppearance,
  ThemeFamily,
  ThemePreference,
} from "../../shared/bridge.ts";

export const DEFAULT_THEME: ThemePreference = {
  family: "graphite",
  appearance: "system",
};

const FAMILIES = new Set<ThemeFamily>([
  "graphite",
  "folio",
  "cobalt",
  "signal",
  "evergreen",
  "clay",
  "harbor",
]);
const COMFORT_FAMILIES = new Set<ThemeFamily>(["evergreen", "clay", "harbor"]);
const APPEARANCES = new Set<ThemeAppearance>([
  "dark",
  "dim",
  "light",
  "system",
]);

/** Accepts the old appearance-only preference and safely rejects bad disk data. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  if (typeof value === "string" && APPEARANCES.has(value as ThemeAppearance)) {
    const appearance = value as ThemeAppearance;
    return {
      family: appearance === "dim" ? "evergreen" : "graphite",
      appearance,
    };
  }
  if (!value || typeof value !== "object") return DEFAULT_THEME;
  const candidate = value as { family?: unknown; appearance?: unknown };
  const family = FAMILIES.has(candidate.family as ThemeFamily)
    ? (candidate.family as ThemeFamily)
    : DEFAULT_THEME.family;
  const appearance = APPEARANCES.has(candidate.appearance as ThemeAppearance)
    ? (candidate.appearance as ThemeAppearance)
    : DEFAULT_THEME.appearance;
  if (appearance === "dim") {
    return {
      family: COMFORT_FAMILIES.has(family) ? family : "evergreen",
      appearance,
    };
  }
  return {
    family: COMFORT_FAMILIES.has(family) ? DEFAULT_THEME.family : family,
    appearance,
  };
}

export function resolveAppearance(
  appearance: ThemeAppearance,
  systemPrefersLight = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches,
): "dark" | "light" {
  if (appearance === "dim") return "dark";
  return appearance === "system"
    ? systemPrefersLight
      ? "light"
      : "dark"
    : appearance;
}
