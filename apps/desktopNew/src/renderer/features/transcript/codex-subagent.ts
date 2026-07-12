import type { SessionSummary } from "@agena/protocol";
import type { Block } from "../../store/types.ts";

export function isCodexImportedSubagent(
  session: SessionSummary | undefined,
): boolean {
  return (
    session?.origin === "import.codex" && session.sessionKind === "subagent"
  );
}

export function visibleCodexSubagentBlocks(
  session: SessionSummary | undefined,
  blocks: readonly Block[],
): readonly Block[] {
  if (!isCodexImportedSubagent(session)) return blocks;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind === "assistant" && block.status === "completed") {
      return [block];
    }
  }
  return [];
}
