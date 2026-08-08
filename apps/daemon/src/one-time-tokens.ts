import { createHash, randomBytes } from "node:crypto";

type TokenRecord = { audience: string; expiresAt: number };

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** In-memory by design: restarts invalidate pairing and socket credentials. */
export class OneTimeTokenStore {
  private readonly records = new Map<string, TokenRecord>();

  create(audience: string, ttlMs: number): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMs);
    this.records.set(digest(token), {
      audience,
      expiresAt: expiresAt.getTime(),
    });
    return { token, expiresAt };
  }

  consume(token: string, audience: string): boolean {
    return this.take(token) === audience;
  }

  take(token: string): string | null {
    const key = digest(token);
    const record = this.records.get(key);
    this.records.delete(key);
    return record !== undefined && record.expiresAt > Date.now()
      ? record.audience
      : null;
  }
}
