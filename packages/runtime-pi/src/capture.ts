// Opt-in raw Pi event tee (P15, §8.7) — wired into the subscribe path but OFF
// by default; AGENA_RAW_CAPTURE=1 turns it on (the daemon's rawCapture.enabled
// maps to the same switch upstream). One JSON line per raw Pi event, exactly as
// received, at <capturesDir>/<sessionId>/<startedAt>.jsonl (§3.3).
// Fire-and-forget: an I/O error disables capture for the session, never the pump.
// ponytail: no 64 MB rotation / TTL cleanup yet — M2 hardening (§8.7).
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

export function captureEnabled(): boolean {
  return process.env.AGENA_RAW_CAPTURE === "1";
}

export function createCaptureTee(
  sessionId: string,
  capturesDir: string,
  piSdkVersion: string,
): (event: unknown) => void {
  let stream: WriteStream | null = null;
  let disabled = false;
  const disable = (err: unknown): void => {
    disabled = true;
    console.warn(
      `[agena-runtime-pi] capture tee disabled for ${sessionId}:`,
      err,
    );
  };
  return (event) => {
    if (disabled) return;
    try {
      if (!stream) {
        const dir = join(capturesDir, sessionId);
        mkdirSync(dir, { recursive: true });
        const startedAt = new Date().toISOString().replaceAll(":", "-");
        stream = createWriteStream(join(dir, `${startedAt}.jsonl`), {
          flags: "a",
        });
        stream.on("error", disable);
      }
      stream.write(
        `${JSON.stringify({ ts: new Date().toISOString(), sessionId, piSdkVersion, event })}\n`,
      );
    } catch (err) {
      disable(err);
    }
  };
}
