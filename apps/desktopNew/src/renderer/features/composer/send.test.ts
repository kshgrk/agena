import assert from "node:assert/strict";
import { test } from "node:test";
import { errCode, errText, performSend, type SendApi } from "./send.ts";

function api(overrides: Partial<SendApi> = {}): SendApi & { calls: string[] } {
  const calls: string[] = [];
  const ok = (mode: string) => (text: string) => {
    calls.push(`${mode}:${text}`);
    return Promise.resolve({});
  };
  return {
    calls,
    prompt: overrides.prompt ?? ok("prompt"),
    steer: overrides.steer ?? ok("steer"),
    followUp: overrides.followUp ?? ok("followUp"),
  };
}

const reject = (code: string) => () =>
  Promise.reject(Object.assign(new Error(code), { code, retryable: false }));

test("idle sends a prompt", async () => {
  const a = api();
  const out = await performSend(a, { active: false, queueMode: "steer", text: "hi" });
  assert.deepEqual(out, { sentAs: "prompt" });
  assert.deepEqual(a.calls, ["prompt:hi"]);
});

test("idle + SESSION_BUSY auto-converts to steer with a notice", async () => {
  const a = api({ prompt: reject("SESSION_BUSY") });
  const out = await performSend(a, { active: false, queueMode: "followUp", text: "hi" });
  assert.equal(out.sentAs, "steer");
  assert.ok(out.notice);
  assert.deepEqual(a.calls, ["steer:hi"]);
});

test("active sends per queue mode", async () => {
  const a = api();
  assert.deepEqual(
    await performSend(a, { active: true, queueMode: "steer", text: "s" }),
    { sentAs: "steer" },
  );
  assert.deepEqual(
    await performSend(a, { active: true, queueMode: "followUp", text: "f" }),
    { sentAs: "followUp" },
  );
  assert.deepEqual(a.calls, ["steer:s", "followUp:f"]);
});

test("active + TURN_NOT_ACTIVE silently resends as prompt", async () => {
  const a = api({ steer: reject("TURN_NOT_ACTIVE") });
  const out = await performSend(a, { active: true, queueMode: "steer", text: "x" });
  assert.deepEqual(out, { sentAs: "prompt" });
  assert.deepEqual(a.calls, ["prompt:x"]);
});

test("other errors rethrow in both branches", async () => {
  await assert.rejects(
    performSend(api({ prompt: reject("PAYLOAD_TOO_LARGE") }), {
      active: false,
      queueMode: "steer",
      text: "x",
    }),
    (e: unknown) => errCode(e) === "PAYLOAD_TOO_LARGE",
  );
  await assert.rejects(
    performSend(api({ followUp: reject("INTERNAL") }), {
      active: true,
      queueMode: "followUp",
      text: "x",
    }),
    (e: unknown) => errCode(e) === "INTERNAL",
  );
});

test("errCode / errText narrow unknowns safely", () => {
  assert.equal(errCode(null), "");
  assert.equal(errCode({ code: 5 }), "");
  assert.equal(errCode({ code: "TIMEOUT" }), "TIMEOUT");
  assert.equal(errText(null), "Something went wrong");
  assert.equal(errText(new Error("boom")), "boom");
});
