/** Human-readable message from anything a bridge call can reject with. */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === "string" ? msg : "Something went wrong";
}
