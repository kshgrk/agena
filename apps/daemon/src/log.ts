// Structured minimal logging (§9.9): JSON lines on stdout, no dependency.
// ponytail: pino + file rotation + redaction list land with the M2 state tree
export function log(
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields }),
  );
}
