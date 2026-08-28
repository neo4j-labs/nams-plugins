import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { ClaudeReplayOutboxRecord } from "../../src/platforms/claude/replay-model.js";
import { sendClaudeReplayOutbox } from "../../src/platforms/claude/replay-sender.js";
import { withClaudeNamsReplayEnvironment } from "../support/claude-nams-replay-environment.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";

async function writeOutbox(
  fixture: string,
  records: ClaudeReplayOutboxRecord[],
): Promise<string> {
  const directory = path.join(fixture, "claude-outbox-fixture");
  const outboxPath = path.join(directory, "outbox.jsonl");
  await mkdir(directory, { recursive: true });
  await writeFile(
    outboxPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return outboxPath;
}

function completeRecords(): ClaudeReplayOutboxRecord[] {
  return [{
    kind: "conversation.create",
    localConversationId: "conversation:session-1",
    sourceSessionId: "session-1",
    projectDirectory: "/project",
    sourceStartedAt: "2026-08-26T12:00:00.000Z",
  }, {
    kind: "message.add",
    localConversationId: "conversation:session-1",
    role: "user",
    content: "Build it.",
  }, {
    kind: "reasoningStep.create",
    localConversationId: "conversation:session-1",
    localStepId: "session-1:root:message-1",
    reasoning: "Visible operation",
    actionTaken: "Ran 1 tool call: Read",
    result: "Tool statuses: success",
  }, {
    kind: "toolCall.create",
    localStepId: "session-1:root:message-1",
    toolName: "Read",
    input: { file_path: "src/a.ts", output: "strip this field" },
    output: "first\n\nsecond",
    status: "success",
    durationMs: 25,
  }];
}

test("sends a complete Claude outbox sequentially with shared remote ids", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock()
      .createConversation({ id: "conversation-1" })
      .message()
      .reasoningStep({ id: "step-1" })
      .toolCall();
    const outboxPath = await writeOutbox(fixture, completeRecords());

    const summary = await sendClaudeReplayOutbox({
      outboxPath,
      importRoot: "/project",
      fetch: nams.fetch,
    });

    assert.deepEqual(summary, {
      conversations: 1,
      messages: 1,
      reasoningSteps: 1,
      toolCalls: 1,
    });
    assert.deepEqual(nams.calls().map((call) => new URL(call.url).pathname), [
      "/v1/conversations",
      "/v1/conversations/conversation-1/messages",
      "/v1/reasoning/steps",
      "/v1/reasoning/tool-calls",
    ]);
    assert.deepEqual(nams.requestBodies("createConversation")[0].metadata, {
      harness: "claude",
      projectDirectory: "/project",
      sourceSessionId: "session-1",
      importSource: "nams-hooks-replay",
      sourceStartedAt: "2026-08-26T12:00:00.000Z",
    });
    assert.equal(nams.requestBodies("addToolCall")[0].stepId, "step-1");
    assert.equal(nams.requestBodies("addToolCall")[0].input, "{\"file_path\":\"src/a.ts\"}");
    assert.equal(nams.requestBodies("addToolCall")[0].output, "first\n\nsecond");
  });
});

test("validates all Claude outbox references before configuration or network access", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock().all({ error: "must not be called" }, 500);
    const outboxPath = await writeOutbox(fixture, [{
      kind: "message.add",
      localConversationId: "conversation:missing",
      role: "assistant",
      content: "not deliverable",
    }]);
    await assert.rejects(
      sendClaudeReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
      new Error("Invalid Claude replay outbox conversation reference at line 1"),
    );
    assert.equal(nams.calls().length, 0);
  });
});

test("stops after the first failed Claude write without retry or live state", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock()
      .createConversation({ id: "conversation-1" })
      .message({ error: "failed" }, 500)
      .reasoningStep({ id: "step-1" })
      .toolCall();
    const outboxPath = await writeOutbox(fixture, completeRecords());
    await assert.rejects(
      sendClaudeReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
      new Error("NAMS request failed during Claude replay"),
    );
    assert.equal(nams.calls().length, 2);
    assert.equal(nams.calls("addMessage").length, 1);
    assert.equal(nams.calls("addReasoningStep").length, 0);
    await assert.rejects(access(path.join(fixture, ".nams", "state")), { code: "ENOENT" });
    await assert.rejects(access(path.join(fixture, ".nams", "logs")), { code: "ENOENT" });
  });
});

test("uses Claude plugin configuration and auto-selects one workspace", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock()
      .workspaces({ workspaces: [{ id: "workspace-auto", name: "Auto" }] })
      .createConversation();
    const outboxPath = await writeOutbox(fixture, [completeRecords()[0]]);
    await sendClaudeReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch });
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 1);
  }, {
    NAMS_API_KEY: undefined,
    NAMS_WORKSPACE_ID: undefined,
    NAMS_BASE_URL: undefined,
    CLAUDE_PLUGIN_OPTION_NAMS_API_KEY: "plugin-key",
    CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID: undefined,
    CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL: "https://memory.example.test",
  });
});
