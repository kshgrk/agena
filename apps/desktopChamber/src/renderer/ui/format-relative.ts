/** "just now" / "2m ago" / "3h ago" / "yesterday" / "3d ago" / locale date.
 * Pure — kept out of the component file so it runs under node --test. */
export function formatRelative(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}
