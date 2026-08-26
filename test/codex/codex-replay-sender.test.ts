import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { CodexReplayOutboxRecord } from "../../src/platforms/codex/replay-model.js";
import { sendCodexReplayOutbox } from "../../src/platforms/codex/replay-sender.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";
import { withNamsReplayEnvironment } from "../support/nams-replay-environment.js";

async function writeOutbox(
  fixture: string,
  records: CodexReplayOutboxRecord[],
): Promise<string> {
  const directory = path.join(fixture, "outbox-fixture");
  const outboxPath = path.join(directory, "outbox.jsonl");
  await mkdir(directory, { recursive: true });
  await writeFile(
    outboxPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return outboxPath;
}

function completeRecords(): CodexReplayOutboxRecord[] {
  return [
    {
      kind: "conversation.create",
      localConversationId: "conversation:session-1",
      sourceSessionId: "session-1",
      projectDirectory: "/project",
      sourceStartedAt: "2026-08-26T12:00:00.000Z",
    },
    {
      kind: "message.add",
      localConversationId: "conversation:session-1",
      role: "user",
      content: "Build it.",
    },
    {
      kind: "reasoningStep.create",
      localConversationId: "conversation:session-1",
      localStepId: "step:local-1",
      reasoning: "Visible operation",
      actionTaken: "Ran 2 tool calls: exec, wait_agent",
      result: "Tool statuses: success, timeout",
    },
    {
      kind: "toolCall.create",
      localStepId: "step:local-1",
      toolName: "exec",
      input: { command: "pwd", output: "strip this field" },
      output: "Script completed\nOutput:\nfirst second",
      status: "success",
    },
    {
      kind: "toolCall.create",
      localStepId: "step:local-1",
      toolName: "wait_agent",
      input: { namespace: "collaboration", input: { timeout_ms: 1000 } },
      output: "{\"timed_out\":true}",
      status: "timeout",
      durationMs: 25,
    },
  ];
}

test("sends a complete outbox sequentially with shared remote step ids", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock()
      .createConversation({ id: "conversation-1" })
      .message()
      .reasoningStep({ id: "step-1" })
      .toolCall();
    const outboxPath = await writeOutbox(fixture, completeRecords());

    const summary = await sendCodexReplayOutbox({
      outboxPath,
      importRoot: "/project",
      fetch: nams.fetch,
    });

    assert.deepEqual(summary, {
      conversations: 1,
      messages: 1,
      reasoningSteps: 1,
      toolCalls: 2,
    });
    assert.deepEqual(nams.calls().map((call) => new URL(call.url).pathname), [
      "/v1/conversations",
      "/v1/conversations/conversation-1/messages",
      "/v1/reasoning/steps",
      "/v1/reasoning/tool-calls",
      "/v1/reasoning/tool-calls",
    ]);
    assert.deepEqual(nams.requestBodies("createConversation")[0].metadata, {
      harness: "codex",
      projectDirectory: "/project",
      sourceSessionId: "session-1",
      importSource: "nams-hooks-replay",
      sourceStartedAt: "2026-08-26T12:00:00.000Z",
    });
    assert.deepEqual(nams.requestBodies("addReasoningStep"), [{
      conversationId: "conversation-1",
      reasoning: "Visible operation",
      actionTaken: "Ran 2 tool calls: exec, wait_agent",
      result: "Tool statuses: success, timeout",
    }]);
    assert.deepEqual(
      nams.requestBodies("addToolCall").map((body) => body.stepId),
      ["step-1", "step-1"],
    );
    assert.equal(nams.requestBodies("addToolCall")[0].input, "{\"command\":\"pwd\"}");
    assert.equal(
      nams.requestBodies("addToolCall")[0].output,
      "Script completed\nOutput:\nfirst second",
    );
  });
});

test("stops on the first failed write without retry or state files", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock()
      .createConversation({ id: "conversation-1" })
      .message({ error: "failed" }, 500)
      .reasoningStep({ id: "step-1" })
      .toolCall();
    const outboxPath = await writeOutbox(fixture, completeRecords());

    await assert.rejects(
      sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
      new Error("NAMS request failed during Codex replay"),
    );

    assert.equal(nams.calls().length, 2);
    assert.equal(nams.calls("addMessage").length, 1);
    assert.equal(nams.calls("addReasoningStep").length, 0);
    assert.equal(nams.calls("addToolCall").length, 0);
    await assert.rejects(access(path.join(fixture, ".nams", "state")), { code: "ENOENT" });
    await assert.rejects(access(path.join(fixture, ".nams", "logs")), { code: "ENOENT" });
  });
});

test("uses an explicit workspace without listing workspaces", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock().createConversation();
    const outboxPath = await writeOutbox(fixture, [completeRecords()[0]]);
    await sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch });
    assert.equal(nams.calls("listMyWorkspaces").length, 0);
    assert.equal(nams.calls("createConversation").length, 1);
  });
});

test("auto-selects exactly one available workspace", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock()
      .workspaces({ workspaces: [{ id: "workspace-auto", name: "Auto" }] })
      .createConversation();
    const outboxPath = await writeOutbox(fixture, [completeRecords()[0]]);
    await sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch });
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 1);
  }, { NAMS_WORKSPACE_ID: undefined });
});

test("rejects zero or multiple available workspaces", async (context) => {
  await context.test("zero", async () => {
    await withNamsReplayEnvironment(async (fixture) => {
      const nams = createNamsFetchMock().workspaces({ workspaces: [] });
      const outboxPath = await writeOutbox(fixture, [completeRecords()[0]]);
      await assert.rejects(
        sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
        new Error("No NAMS workspace is available for replay"),
      );
    }, { NAMS_WORKSPACE_ID: undefined });
  });
  await context.test("multiple", async () => {
    await withNamsReplayEnvironment(async (fixture) => {
      const nams = createNamsFetchMock().workspaces({
        workspaces: [{ id: "one" }, { id: "two" }],
      });
      const outboxPath = await writeOutbox(fixture, [completeRecords()[0]]);
      await assert.rejects(
        sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
        new Error("NAMS workspace selection is required before replay"),
      );
    }, { NAMS_WORKSPACE_ID: undefined });
  });
});

test("validates the complete outbox before any remote request", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock().all({ error: "must not be called" }, 500);
    const directory = path.join(fixture, "invalid-outbox");
    const outboxPath = path.join(directory, "outbox.jsonl");
    await mkdir(directory, { recursive: true });
    await writeFile(outboxPath, "{not json\n", "utf8");
    await assert.rejects(
      sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
      new Error("Invalid Codex replay outbox record at line 1"),
    );
    assert.equal(nams.calls().length, 0);
  });
});

test("rejects late unknown references before any remote request", async (context) => {
  await context.test("conversation reference", async () => {
    await withNamsReplayEnvironment(async (fixture) => {
      const nams = createNamsFetchMock().all({ error: "must not be called" }, 500);
      const records: CodexReplayOutboxRecord[] = [
        ...completeRecords(),
        {
          kind: "message.add",
          localConversationId: "conversation:unknown-sensitive-id",
          role: "assistant",
          content: "must not be sent",
        },
      ];
      const outboxPath = await writeOutbox(fixture, records);

      await assert.rejects(
        sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
        new Error("Invalid Codex replay outbox conversation reference at line 6"),
      );
      assert.equal(nams.calls().length, 0);
    });
  });

  await context.test("reasoning step reference", async () => {
    await withNamsReplayEnvironment(async (fixture) => {
      const nams = createNamsFetchMock().all({ error: "must not be called" }, 500);
      const records: CodexReplayOutboxRecord[] = [
        ...completeRecords(),
        {
          kind: "toolCall.create",
          localStepId: "step:unknown-sensitive-id",
          toolName: "exec",
          input: {},
        },
      ];
      const outboxPath = await writeOutbox(fixture, records);

      await assert.rejects(
        sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
        new Error("Invalid Codex replay outbox reasoning step reference at line 6"),
      );
      assert.equal(nams.calls().length, 0);
    });
  });
});
