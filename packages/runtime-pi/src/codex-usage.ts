import type { SubscriptionUsage } from "@agena/protocol";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CACHE_MS = 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resetDate(window: Record<string, unknown>): string | undefined {
  const raw =
    window.reset_at ??
    window.resets_at ??
    window.reset_time ??
    window.end_time ??
    window.ends_at ??
    window.expires_at;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw < 1_000_000_000_000 ? raw * 1000 : raw).toISOString();
  }
  if (typeof raw === "string") {
    const time = Date.parse(raw);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  const delay = window.reset_after_seconds;
  return typeof delay === "number" && Number.isFinite(delay)
    ? new Date(Date.now() + delay * 1000).toISOString()
    : undefined;
}

export function parseCodexWeeklyUsage(
  payload: unknown,
): SubscriptionUsage | undefined {
  const limit = record(record(payload)?.rate_limit);
  const weekly =
    record(limit?.secondary_window) ?? record(limit?.primary_window);
  if (!weekly) return undefined;
  const used = weekly?.used_percent;
  if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
  const resetsAt = resetDate(weekly);
  return {
    period: "weekly",
    remainingPercent: Math.round(Math.max(0, Math.min(100, 100 - used))),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

export class CodexUsageReader {
  #cached: { expiresAt: number; value: SubscriptionUsage | undefined } | null =
    null;
  #pending: Promise<SubscriptionUsage | undefined> | null = null;

  invalidate(): void {
    this.#cached = null;
  }

  async read(
    registry: ModelRegistry,
    model: Model<Api> | undefined,
  ): Promise<SubscriptionUsage | undefined> {
    if (model?.provider !== "openai-codex") return undefined;
    if (this.#cached && this.#cached.expiresAt > Date.now()) {
      return this.#cached.value;
    }
    this.#pending ??= this.#fetch(registry, model).finally(() => {
      this.#pending = null;
    });
    const value = await this.#pending;
    this.#cached = { expiresAt: Date.now() + CACHE_MS, value };
    return value;
  }

  async #fetch(
    registry: ModelRegistry,
    model: Model<Api>,
  ): Promise<SubscriptionUsage | undefined> {
    try {
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth.ok) return undefined;
      const headers = new Headers();
      for (const [name, value] of Object.entries(auth.headers ?? {})) {
        if (value !== null && value !== undefined) headers.set(name, value);
      }
      if (!headers.has("authorization") && auth.apiKey) {
        headers.set("authorization", `Bearer ${auth.apiKey}`);
      }
      if (!headers.has("authorization")) return undefined;
      const response = await fetch(USAGE_URL, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok
        ? parseCodexWeeklyUsage(await response.json())
        : undefined;
    } catch {
      return undefined;
    }
  }
}
