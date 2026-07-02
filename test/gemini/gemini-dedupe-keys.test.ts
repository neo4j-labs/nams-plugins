import assert from "node:assert/strict";
import { test } from "node:test";
import { hasSeenAny, markSeen } from "../../src/runtime/dedupe.js";
import { geminiToolCallDedupeKeys } from "../../src/platforms/gemini/index.js";

const sessionKey = "session-1";
const toolName = "read_file";
const input = { path: "/tmp/a.txt" };

test("an id-less mark dedupes a later id-bearing replay of the same call", () => {
  const seen: string[] = [];
  markSeen(seen, geminiToolCallDedupeKeys(sessionKey, toolName, input).markKeys);

  const withId = geminiToolCallDedupeKeys(sessionKey, toolName, input, "call-1");

  assert.equal(hasSeenAny(seen, withId.lookupKeys), true);
});

test("an id-bearing mark dedupes a later id-less replay of the same call", () => {
  const seen: string[] = [];
  markSeen(seen, geminiToolCallDedupeKeys(sessionKey, toolName, input, "call-1").markKeys);

  const withoutId = geminiToolCallDedupeKeys(sessionKey, toolName, input);

  assert.equal(hasSeenAny(seen, withoutId.lookupKeys), true);
});

test("a second id-bearing call with identical input is not deduped", () => {
  const seen: string[] = [];
  markSeen(seen, geminiToolCallDedupeKeys(sessionKey, toolName, input, "call-1").markKeys);

  const secondCall = geminiToolCallDedupeKeys(sessionKey, toolName, input, "call-2");

  assert.equal(hasSeenAny(seen, secondCall.lookupKeys), false);
});
