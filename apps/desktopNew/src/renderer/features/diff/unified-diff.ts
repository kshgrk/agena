// Pure unified-diff generation: line-level Myers diff → git-style hunk strings
// consumable by @git-diff-view/react (which renders hunks, never computes
// them). Node-safe, no imports — tested via unified-diff.test.ts.

export type LineOp = { type: "ctx" | "add" | "del"; line: string };

/** Split text into lines, treating a trailing newline as line terminator. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ponytail: D cap keeps worst-case time/memory bounded (O(D²) trace); beyond
// it the diff degrades to whole-region replace, which is still a valid diff.
const MAX_D = 1000;

/**
 * Line-level diff (Myers greedy, common prefix/suffix trimmed). Output is the
 * full op sequence covering every input line, old-order for deletions before
 * insertions at the same position.
 */
export function diffLines(
  oldLines: readonly string[],
  newLines: readonly string[],
): LineOp[] {
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (
    endOld > start &&
    endNew > start &&
    oldLines[endOld - 1] === newLines[endNew - 1]
  ) {
    endOld--;
    endNew--;
  }
  const a = oldLines.slice(start, endOld);
  const b = newLines.slice(start, endNew);
  const middle =
    myers(a, b) ??
    // cap exceeded: replace the whole differing region
    [
      ...a.map((line): LineOp => ({ type: "del", line })),
      ...b.map((line): LineOp => ({ type: "add", line })),
    ];
  return [
    ...oldLines.slice(0, start).map((line): LineOp => ({ type: "ctx", line })),
    ...middle,
    ...oldLines.slice(endOld).map((line): LineOp => ({ type: "ctx", line })),
  ];
}

/** Classic Myers with backtrack trace; null when the edit distance > MAX_D. */
function myers(a: readonly string[], b: readonly string[]): LineOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ type: "add", line }) as LineOp);
  if (m === 0) return a.map((line) => ({ type: "del", line }) as LineOp);
  const max = n + m;
  const cap = Math.min(max, MAX_D);
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  v[offset + 1] = 0;
  const trace: Array<{ base: number; arr: Int32Array }> = [];
  let solvedD = -1;
  outer: for (let d = 0; d <= cap; d++) {
    // snapshot only the k-range this round reads (memory stays O(D²));
    // negative slice starts wrap in typed arrays, so clamp and keep the base
    const base = Math.max(offset - d - 1, 0);
    trace.push({ base, arr: v.slice(base, offset + d + 2) });
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        solvedD = d;
        break outer;
      }
    }
  }
  if (solvedD < 0) return null;

  // backtrack: trace[d] is v before round d, indexed [k + d + 1]
  const ops: LineOp[] = [];
  let x = n;
  let y = m;
  for (let d = solvedD; d >= 0; d--) {
    const vd = trace[d]!;
    const at = (k: number) => vd.arr[offset + k - vd.base]!;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "ctx", line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "add", line: b[prevY]! });
      else ops.push({ type: "del", line: a[prevX]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export type HunkBuild = {
  /** Git-style hunk strings ("@@ -a,b +c,d @@\n lines…"). Empty = no changes. */
  hunks: string[];
  adds: number;
  dels: number;
};

/**
 * Diff two texts into unified hunks with `context` lines of context; nearby
 * change runs (gap ≤ 2×context) merge into one hunk, exactly like git.
 */
export function buildUnifiedHunks(
  oldText: string,
  newText: string,
  context = 3,
): HunkBuild {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  let adds = 0;
  let dels = 0;
  for (const op of ops) {
    if (op.type === "add") adds++;
    else if (op.type === "del") dels++;
  }
  if (adds === 0 && dels === 0) return { hunks: [], adds, dels };

  // indices of changed ops, grouped into hunk ranges over the ops array
  const ranges: Array<{ from: number; to: number }> = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.type === "ctx") {
      i++;
      continue;
    }
    let to = i;
    let j = i + 1;
    let gap = 0;
    while (j < ops.length && gap <= 2 * context) {
      if (ops[j]!.type === "ctx") gap++;
      else {
        to = j;
        gap = 0;
      }
      j++;
    }
    ranges.push({ from: i, to });
    i = to + 1;
  }

  // old/new line numbers (0-based) at each op index
  const hunks: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  let opIdx = 0;
  for (const range of ranges) {
    // advance counters to the context start of this hunk
    const from = Math.max(range.from - context, opIdx);
    while (opIdx < from) {
      const op = ops[opIdx]!;
      if (op.type !== "add") oldLine++;
      if (op.type !== "del") newLine++;
      opIdx++;
    }
    const to = Math.min(range.to + context, ops.length - 1);
    const oldStart = oldLine;
    const newStart = newLine;
    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    while (opIdx <= to) {
      const op = ops[opIdx]!;
      if (op.type === "ctx") {
        lines.push(` ${op.line}`);
        oldCount++;
        newCount++;
        oldLine++;
        newLine++;
      } else if (op.type === "del") {
        lines.push(`-${op.line}`);
        oldCount++;
        oldLine++;
      } else {
        lines.push(`+${op.line}`);
        newCount++;
        newLine++;
      }
      opIdx++;
    }
    // git convention: a zero-count side reports the line BEFORE the hunk
    const oldHdr = oldCount === 0 ? oldStart : oldStart + 1;
    const newHdr = newCount === 0 ? newStart : newStart + 1;
    hunks.push(
      `@@ -${oldHdr},${oldCount} +${newHdr},${newCount} @@\n${lines.join("\n")}`,
    );
  }
  return { hunks, adds, dels };
}

/** +/− counts of pre-made hunk strings (pass-through patches from tools). */
export function hunkStats(hunks: readonly string[]): {
  adds: number;
  dels: number;
} {
  let adds = 0;
  let dels = 0;
  for (const hunk of hunks) {
    for (const line of hunk.split("\n")) {
      if (
        line.startsWith("@@") ||
        line.startsWith("+++") ||
        line.startsWith("---")
      ) {
        continue;
      }
      if (line.startsWith("+")) adds++;
      else if (line.startsWith("-")) dels++;
    }
  }
  return { adds, dels };
}

/**
 * Compose hunks into the one-string git-style diff @git-diff-view/core
 * actually parses: its parser requires the `--- a/… / +++ b/…` file header
 * before the first `@@` line (headerless hunk strings parse to zero lines).
 */
export function composeGitDiff(path: string, hunks: readonly string[]): string[] {
  if (hunks.length === 0) return [];
  return [`--- a/${path}\n+++ b/${path}\n${hunks.join("\n")}`];
}
