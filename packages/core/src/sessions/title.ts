import type { ContentBlock } from "@agena/protocol";

/** A durable title must not depend on a model, network, or auth state. */
export function fallbackSessionTitle(content: readonly ContentBlock[]): string {
  const cleaned = content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/[^\w\s-]/g, " ")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 8);
  const title = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
    .slice(0, 60)
    .trim();
  return title || "New Session";
}
