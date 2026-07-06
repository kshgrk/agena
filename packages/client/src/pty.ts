// Shared helpers for the §9.5 dedicated PTY WS, used by both the standalone
// `agena shell` attach loop and the TUI's embedded shell split.
import { ptyDaemonControlFrameSchema } from "@agena/protocol";

/**
 * Parse a text frame from the PTY WS. Returns the shell's exit code when the
 * frame is a §9.5 exit control frame, undefined otherwise. Malformed frames
 * never crash the client (§11.7) — they are simply not exit frames.
 */
export function parsePtyExit(raw: string): number | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = ptyDaemonControlFrameSchema.safeParse(json);
  if (!parsed.success) return undefined;
  if (typeof parsed.data.exitCode === "number") return parsed.data.exitCode;
  return parsed.data.signal ? 1 : 0;
}

/** Daemon close reasons that mean "the PTY is gone — do not reattach" (§11.5). */
export function isTerminalPtyClose(code: number, reason: string): boolean {
  return (
    code === 1000 && (reason === "pty ended" || reason === "pty not found")
  );
}

/** Normalize a binary PTY WS frame to bytes across Node/Bun socket flavors. */
export async function ptyDataToBytes(data: unknown): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return new Uint8Array(0);
}
