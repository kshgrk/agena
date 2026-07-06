import { readFileSync } from "node:fs";
import type { RuntimeEvent } from "@agena/core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { createMapperState, mapPiEvent } from "../src/event-map.ts";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(new URL(path, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as T);
}

test("replays recorded plain-text Pi fixture to stable RuntimeEvents", () => {
  const fixture = readJsonl<AgentSessionEvent>(
    "./fixtures/pi/0.80.3/plain-text.jsonl",
  );
  const expected = readJson<RuntimeEvent[]>(
    "./fixtures/pi/0.80.3/plain-text.expected.json",
  );
  let n = 0;
  const state = createMapperState(() => `id-${++n}`);
  state.triggerMessageId = "m-user";

  expect(fixture.flatMap((ev) => mapPiEvent(state, ev))).toEqual(expected);
});
