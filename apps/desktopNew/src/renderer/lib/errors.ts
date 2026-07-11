// BridgeError narrowing/formatting. Every bridge rejection is BridgeError-shaped
// (code/message/retryable as own props on an Error) — callers check `err.code`,
// never `instanceof` (docs/contracts/bridge.md §4/§8.7).
import type { BridgeError } from "../../shared/bridge.ts";

export const DESKTOP_ONLY_CODE = "DESKTOP_ONLY";

/** Mint a BridgeError-shaped Error (the same shape AgenaClientError crosses IPC as). */
export function bridgeError(
  code: string,
  message: string,
  retryable = false,
): Error & BridgeError {
  return Object.assign(new Error(message), { code, retryable });
}

/** Narrow an unknown rejection to the BridgeError shape. */
export function isBridgeError(err: unknown): err is Error & BridgeError {
  if (!(err instanceof Error)) return false;
  const e = err as Partial<BridgeError>;
  return typeof e.code === "string" && typeof e.retryable === "boolean";
}

/**
 * Normalize any rejection into a BridgeError-shaped Error. Already-shaped
 * errors (AgenaClientError and friends) pass through untouched; everything
 * else wraps as non-retryable INTERNAL.
 */
export function toBridgeError(err: unknown): Error & BridgeError {
  if (isBridgeError(err)) return err;
  return bridgeError(
    "INTERNAL",
    err instanceof Error ? err.message : String(err),
    false,
  );
}

/** Rejection for methods that need Electron main (local scans, native pickers, browser pane). */
export function desktopOnlyError(method: string): Error & BridgeError {
  return bridgeError(
    DESKTOP_ONLY_CODE,
    `${method} is only available in the desktop app — this browser session talks directly to the daemon`,
    false,
  );
}

/** For the settings UI: did this call fail only because we're not in Electron? */
export function isDesktopOnlyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === DESKTOP_ONLY_CODE
  );
}

/** Human-readable one-liner for toasts/statusbar. */
export function formatBridgeError(err: unknown): string {
  if (isBridgeError(err)) {
    const retry = err.retryable ? " — safe to retry" : "";
    return `${err.message} (${err.code})${retry}`;
  }
  return err instanceof Error ? err.message : String(err);
}
