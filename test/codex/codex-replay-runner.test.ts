import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runCodexReplay } from "../../src/platforms/codex/replay-runner.js";
import {
  completedItem,
  jsonl,
  responseItem,
  sessionMeta,
  taskComplete,
} from "../support/codex-rollout-fixture.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";
import { withNamsReplayEnvironment } from "../support/nams-replay-environment.js";

async function writeRunnerRollouts(fixture: string): Promise<{
  project: string;
  temporaryRoot: string;
  rootPath: string;
  childPath: string;
  skippedPath: string;
}> {
  const project = path.join(fixture, "project");
  const temporaryRoot = path.join(fixture, "outboxes");
  const sessionsRoot = path.join(process.env.CODEX_HOME as string, "sessions", "2026", "08");
  const rootPath = path.join(sessionsRoot, "root.jsonl");
  const childPath = path.join(sessionsRoot, "subagents", "child.jsonl");
  const skippedPath = path.join(sessionsRoot, "outside.jsonl");
  await mkdir(path.dirname(childPath), { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  await writeFile(rootPath, jsonl([
    sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
    completedItem(1, "thread-root", "turn-1", {
      type: "UserMessage",
      content: [{ type: "text", text: "Build it." }],
    }),
    responseItem(2, "turn-1", {
      type: "reasoning",
      id: "reasoning-1",
      summary: [],
      encrypted_content: "private",
    }),
    responseItem(3, "turn-1", {
      type: "custom_tool_call",
      call_id: "call-1",
      name: "exec",
      input: "pwd",
    }),
    responseItem(4, "turn-1", {
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: [
        { type: "input_text", text: "Script completed\nOutput:\n" },
        { type: "input_text", text: project },
      ],
    }),
    taskComplete(5, "thread-root", "turn-1"),
  ]), "utf8");
  await writeFile(childPath, jsonl([
    sessionMeta({
      sessionId: "session-1",
      threadId: "thread-child",
      cwd: project,
      threadSource: "subagent",
    }),
  ]), "utf8");
  await writeFile(skippedPath, jsonl([
    sessionMeta({
      sessionId: "outside-session",
      cwd: path.join(fixture, "outside-project"),
      threadSource: "user",
    }),
  ]), "utf8");
  return { project, temporaryRoot, rootPath, childPath, skippedPath };
}

test("imports one grouped session and cleans the successful outbox", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const {
      project,
      temporaryRoot,
      rootPath,
      childPath,
      skippedPath,
    } = await writeRunnerRollouts(fixture);
    const nams = createNamsFetchMock()
      .createConversation()
      .message()
      .reasoningStep()
      .toolCall();

    const progress: string[] = [];
    const summary = await runCodexReplay({
      importRoot: project,
      temporaryRoot,
      fetch: nams.fetch,
      onProgress: (line) => progress.push(line),
    });

    assert.deepEqual(summary, {
      discoveredFiles: 3,
      matchedFiles: 2,
      skippedFiles: 1,
      sessions: 1,
      conversations: 1,
      messages: 1,
      reasoningSteps: 1,
      toolCalls: 1,
      malformedLines: 0,
      unsupportedRecords: 0,
    });
    assert.deepEqual(progress.slice(0, 3), [
      `Codex replay file skipped: ${skippedPath}`,
      `Codex replay file imported: ${rootPath}`,
      `Codex replay file imported: ${childPath}`,
    ]);
    assert.equal(
      progress[3].startsWith(
        `Codex replay outbox: ${temporaryRoot}${path.sep}nams-hooks-codex-replay-`,
      ),
      true,
    );
    assert.equal(progress[3].endsWith(`${path.sep}outbox.jsonl`), true);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("stops on NAMS failure and still cleans the handled-run outbox", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const { project, temporaryRoot } = await writeRunnerRollouts(fixture);
    const nams = createNamsFetchMock()
      .createConversation()
      .message({ error: "failed" }, 500)
      .reasoningStep()
      .toolCall();

    await assert.rejects(
      runCodexReplay({ importRoot: project, temporaryRoot, fetch: nams.fetch }),
      new Error("NAMS request failed during Codex replay"),
    );
    assert.equal(nams.calls().length, 2);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("a fresh restart recreates and resends the complete outbox", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const { project, temporaryRoot } = await writeRunnerRollouts(fixture);
    const nams = createNamsFetchMock()
      .createConversation()
      .message()
      .reasoningStep()
      .toolCall();

    await runCodexReplay({ importRoot: project, temporaryRoot, fetch: nams.fetch });
    await runCodexReplay({ importRoot: project, temporaryRoot, fetch: nams.fetch });

    assert.equal(nams.calls("createConversation").length, 2);
    assert.equal(nams.calls("addMessage").length, 2);
    assert.equal(nams.calls("addReasoningStep").length, 2);
    assert.equal(nams.calls("addToolCall").length, 2);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});
