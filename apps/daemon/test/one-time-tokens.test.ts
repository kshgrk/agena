import { describe, expect, it } from "vitest";
import { OneTimeTokenStore } from "../src/one-time-tokens.ts";

describe("OneTimeTokenStore", () => {
  it("consumes a token once for its exact audience", () => {
    const store = new OneTimeTokenStore();
    const { token } = store.create("/v1/ws", 1_000);

    expect(store.consume(token, "/v1/ptys/1/ws")).toBe(false);
    expect(store.consume(token, "/v1/ws")).toBe(false);

    const second = store.create("/v1/ws", 1_000).token;
    expect(store.consume(second, "/v1/ws")).toBe(true);
    expect(store.consume(second, "/v1/ws")).toBe(false);
  });

  it("rejects expired tokens", () => {
    const store = new OneTimeTokenStore();
    const { token } = store.create("/v1/ws", -1);
    expect(store.consume(token, "/v1/ws")).toBe(false);
  });
});
