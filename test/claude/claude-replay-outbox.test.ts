import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ClaudeReplaySession } from "../../src/platforms/claude/replay-model.js";
import {
  createClaudeReplayOutbox,
  readClaudeReplayOutbox,
  removeClaudeReplayOutbox,
  validateClaudeReplayOutboxReferences,
} from "../../src/platforms/claude/replay-outbox.js";

function sessions(): ClaudeReplaySession[] {
  return [{
    sourceSessionId: "session-1",
    projectDirectory: "/project",
    sourceStartedAt: "2026-08-26T12:00:00.000Z",
    messages: [{
      role: "user",
      content: "Build it.",
      timestamp: "2026-08-26T12:00:01.000Z",
      ordinal: 1,
      streamId: "root",
    }],
    steps: [{
      localStepId: "session-1:root:message-1",
      sourceAssistantMessageId: "message-1",
      streamId: "root",
      timestamp: "2026-08-26T12:00:02.000Z",
      ordinal: 2,
      reasoning: "Visible operation",
      actionTaken: "Ran 2 tool calls: Agent, Read",
      result: "Tool statuses: success, success",
      toolCalls: [{
        sourceCallId: "call-1",
        toolName: "Agent",
        input: { prompt: "inspect" },
        output: "Agent launched.\n\nAgent completed.",
        status: "success",
        durationMs: 5000,
        timestamp: "2026-08-26T12:00:02.100Z",
        ordinal: 3,
      }, {
        sourceCallId: "call-2",
        toolName: "Read",
        input: { file_path: "src/a.ts" },
        output: "contents",
        status: "success",
        timestamp: "2026-08-26T12:00:02.200Z",
        ordinal: 4,
      }],
    }],
  }];
}

test("writes validates and removes a private deterministic Claude outbox", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-outbox-"));
  const temporaryRoot = path.join(fixture, "temporary-root");
  await mkdir(temporaryRoot);
  const outbox = await createClaudeReplayOutbox({ sessions: sessions(), temporaryRoot });
  try {
    const records = await readClaudeReplayOutbox(outbox.path);
    validateClaudeReplayOutboxReferences(records);
    assert.deepEqual(records.map((record) => record.kind), [
      "conversation.create",
      "message.add",
      "reasoningStep.create",
      "toolCall.create",
      "toolCall.create",
    ]);
    assert.equal((await stat(outbox.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(outbox.path)).mode & 0o777, 0o600);
    assert.equal(path.basename(outbox.directory).startsWith("nams-hooks-claude-replay-"), true);
    assert.equal(outbox.recordCount, 5);
  } finally {
    await removeClaudeReplayOutbox(outbox);
    await rm(fixture, { recursive: true, force: true });
  }
  await assert.rejects(access(outbox.directory), { code: "ENOENT" });
});

test("rejects invalid shapes and forward references before delivery", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-outbox-invalid-"));
  try {
    const invalidShapePath = path.join(fixture, "invalid-shape.jsonl");
    await writeFile(invalidShapePath, [
      JSON.stringify({
        kind: "conversation.create",
        localConversationId: "conversation:session-1",
        sourceSessionId: "session-1",
        projectDirectory: "/project",
      }),
      JSON.stringify({ kind: "unknown" }),
      "",
    ].join("\n"), "utf8");
    await assert.rejects(
      readClaudeReplayOutbox(invalidShapePath),
      new Error("Invalid Claude replay outbox record at line 2"),
    );

    assert.throws(
      () => validateClaudeReplayOutboxReferences([{
        kind: "message.add",
        localConversationId: "conversation:missing",
        role: "assistant",
        content: "not deliverable",
      }]),
      new Error("Invalid Claude replay outbox conversation reference at line 1"),
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
