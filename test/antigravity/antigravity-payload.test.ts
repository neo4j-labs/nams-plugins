import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAntigravityPayload } from "../../src/platforms/antigravity/payload.js";

const processCwd = "/repo/from-cwd";

test("maps documented Antigravity common payload fields", () => {
  const info = parseAntigravityPayload(
    {
      conversationId: "conversation-123",
      workspacePaths: ["", "  ", "/workspace/one", "/workspace/two", 42, null],
      transcriptPath: "/tmp/transcript.jsonl",
      artifactDirectoryPath: "/tmp/artifacts",
      invocationNum: 7,
      initialNumSteps: 3,
    },
    processCwd,
  );

  assert.equal(info.conversationId, "conversation-123");
  assert.equal(info.projectDirectory, "/workspace/one");
  assert.deepEqual(info.workspacePaths, ["/workspace/one", "/workspace/two"]);
  assert.equal(info.transcriptPath, "/tmp/transcript.jsonl");
  assert.equal(info.artifactDirectoryPath, "/tmp/artifacts");
  assert.equal(info.invocationNum, 7);
  assert.equal(info.initialNumSteps, 3);
});

test("maps documented PostToolUse-like Antigravity payload fields", () => {
  const error = { message: "tool failed" };

  const info = parseAntigravityPayload(
    {
      workspacePaths: ["/workspace/project"],
      stepIdx: 12,
      error,
    },
    processCwd,
  );

  assert.equal(info.stepIdx, 12);
  assert.equal(info.error, error);
});

test("maps documented Stop-like Antigravity payload fields", () => {
  const info = parseAntigravityPayload(
    {
      workspacePaths: ["/workspace/project"],
      executionNum: 4,
      terminationReason: "complete",
      fullyIdle: true,
    },
    processCwd,
  );

  assert.equal(info.executionNum, 4);
  assert.equal(info.terminationReason, "complete");
  assert.equal(info.fullyIdle, true);
});

test("falls back to process cwd when workspace paths are omitted or invalid", () => {
  for (const payload of [
    {},
    { workspacePaths: undefined },
    { workspacePaths: "not-an-array" },
    { workspacePaths: [null, 1, false, {}, []] },
    { workspacePaths: ["", "  ", "\t"] },
  ]) {
    const info = parseAntigravityPayload(payload, processCwd);

    assert.equal(info.projectDirectory, processCwd);
    assert.deepEqual(info.workspacePaths, []);
  }
});

test("ignores invalid workspace entries and non-integer numeric fields", () => {
  const info = parseAntigravityPayload(
    {
      workspacePaths: ["/workspace/one", "", "  ", 13, "/workspace/two"],
      invocationNum: 1.5,
      initialNumSteps: "3",
      stepIdx: Number.NaN,
      executionNum: Number.POSITIVE_INFINITY,
    },
    processCwd,
  );

  assert.deepEqual(info.workspacePaths, ["/workspace/one", "/workspace/two"]);
  assert.equal(info.projectDirectory, "/workspace/one");
  assert.equal(info.invocationNum, undefined);
  assert.equal(info.initialNumSteps, undefined);
  assert.equal(info.stepIdx, undefined);
  assert.equal(info.executionNum, undefined);
});

test("does not expose undocumented native event, prompt, assistant, or tool fields", () => {
  const info = parseAntigravityPayload(
    {
      conversationId: "conversation-123",
      workspacePaths: ["/workspace/project"],
      event: "Stop",
      hook_event_name: "PostToolUse",
      hookEventName: "PreToolUse",
      prompt: "summarize this",
      assistantResponse: "summary",
      toolInput: { command: "echo secret" },
      toolOutput: "secret",
      toolName: "Shell",
      toolCallId: "call-123",
    },
    processCwd,
  );

  assert.deepEqual(Object.keys(info).sort(), [
    "conversationId",
    "projectDirectory",
    "workspacePaths",
  ]);
});
