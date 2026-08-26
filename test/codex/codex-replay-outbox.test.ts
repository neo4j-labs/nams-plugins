import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CodexReplaySession } from "../../src/platforms/codex/replay-model.js";
import {
  createCodexReplayOutbox,
  readCodexReplayOutbox,
  removeCodexReplayOutbox,
} from "../../src/platforms/codex/replay-outbox.js";

test("writes a private deterministic outbox and removes it", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-outbox-test-"));
  const temporaryRoot = path.join(fixture, "temporary-root");
  await mkdir(temporaryRoot);
  const sessions: CodexReplaySession[] = [{
    sourceSessionId: "session-1",
    projectDirectory: "/project",
    sourceStartedAt: "2026-08-26T12:00:00.000Z",
    messages: [{
      role: "user",
      content: "Build it.",
      timestamp: "2026-08-26T12:00:01.000Z",
      ordinal: 1,
      threadId: "thread-1",
    }],
    steps: [{
      localStepId: "session-1:thread-1:turn-1:reasoning-1",
      sourceReasoningId: "reasoning-1",
      threadId: "thread-1",
      turnId: "turn-1",
      timestamp: "2026-08-26T12:00:02.000Z",
      ordinal: 2,
      reasoning: "Visible operation",
      actionTaken: "Ran 2 tool calls: exec, wait_agent",
      result: "Tool statuses: success, timeout",
      toolCalls: [
        {
          sourceCallId: "call-1",
          toolName: "exec",
          input: "pwd",
          output: "Script completed\nOutput:\n/project",
          status: "success",
          timestamp: "2026-08-26T12:00:03.000Z",
          ordinal: 3,
        },
        {
          sourceCallId: "call-2",
          toolName: "wait_agent",
          input: { namespace: "collaboration", input: { timeout_ms: 1000 } },
          output: "{\"timed_out\":true}",
          status: "timeout",
          durationMs: 25,
          timestamp: "2026-08-26T12:00:04.000Z",
          ordinal: 4,
        },
      ],
    }],
  }];

  const outbox = await createCodexReplayOutbox({ sessions, temporaryRoot });
  try {
    const records = await readCodexReplayOutbox(outbox.path);
    assert.deepEqual(records.map((record) => record.kind), [
      "conversation.create",
      "message.add",
      "reasoningStep.create",
      "toolCall.create",
      "toolCall.create",
    ]);
    assert.equal((await stat(outbox.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(outbox.path)).mode & 0o777, 0o600);
    assert.equal(outbox.path.startsWith(temporaryRoot), true);
    assert.equal(outbox.recordCount, 5);
    const toolRecords = records.filter((record) => record.kind === "toolCall.create");
    assert.deepEqual(
      toolRecords.map((record) => record.localStepId),
      ["session-1:thread-1:turn-1:reasoning-1", "session-1:thread-1:turn-1:reasoning-1"],
    );
  } finally {
    await removeCodexReplayOutbox(outbox);
    await rm(fixture, { recursive: true, force: true });
  }
  await assert.rejects(access(outbox.directory), { code: "ENOENT" });
});

test("rejects an invalid outbox record with its line number", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-outbox-invalid-"));
  try {
    const outboxPath = path.join(fixture, "outbox.jsonl");
    await writeFile(outboxPath, [
      JSON.stringify({
        kind: "conversation.create",
        localConversationId: "conversation:session-1",
        sourceSessionId: "session-1",
        projectDirectory: "/project",
      }),
      JSON.stringify({ kind: "unknown" }),
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    await assert.rejects(
      readCodexReplayOutbox(outboxPath),
      new Error("Invalid Codex replay outbox record at line 2"),
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
