import assert from "node:assert/strict";
import test from "node:test";
import { composerTokens, resolveComposerAutocomplete } from "./language.ts";

test("composer autocomplete follows OpenChamber trigger precedence", () => {
  assert.deepEqual(resolveComposerAutocomplete("/fast", 5), {
    kind: "command",
    query: "fast",
    from: 0,
    to: 5,
  });
  assert.deepEqual(
    resolveComposerAutocomplete("ask @agen", 9)?.kind,
    "mention",
  );
  assert.equal(resolveComposerAutocomplete("email@test.com", 14), null);
});

test("composer prompt tokens preserve sigil ranges", () => {
  assert.deepEqual(
    composerTokens("/fast ask @agent use #brief").map(({ kind, from }) => ({
      kind,
      from,
    })),
    [
      { kind: "command", from: 0 },
      { kind: "mention", from: 10 },
      { kind: "snippet", from: 21 },
    ],
  );
});
