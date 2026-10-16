import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runClaudeReplay } from "../../src/platforms/claude/replay-runner.js";
import {
  assistantBlock,
  humanMessage,
  jsonl,
  toolResult,
} from "../support/claude-rollout-fixture.js";
import { withClaudeNamsReplayEnvironment } from "../support/claude-nams-replay-environment.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";

async function writeRunnerTranscripts(fixture: string): Promise<{
  project: string;
  temporaryRoot: string;
  rootPath: string;
  skippedPath: string;
}> {
  const project = path.join(fixture, "project");
  const temporaryRoot = path.join(fixture, "outboxes");
  const projectsRoot = path.join(process.env.CLAUDE_CONFIG_DIR as string, "projects", "encoded");
  const rootPath = path.join(projectsRoot, "a-session.jsonl");
  const skippedPath = path.join(projectsRoot, "z-outside.jsonl");
  await mkdir(projectsRoot, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  await writeFile(rootPath, jsonl([
    humanMessage({
      sessionId: "session-1", cwd: project, uuid: "user", parentUuid: "root",
      content: "Build it.", timestamp: "2026-08-26T12:00:01.000Z",
    }),
    assistantBlock({
      sessionId: "session-1", cwd: project, uuid: "call-row", parentUuid: "user",
      messageId: "message-1", block: {
        type: "tool_use", id: "call-1", name: "Read", input: { file_path: "src/a.ts" },
      }, timestamp: "2026-08-26T12:00:02.000Z",
    }),
    toolResult({
      sessionId: "session-1", cwd: project, uuid: "result", parentUuid: "call-row",
      toolUseId: "call-1", content: "contents", timestamp: "2026-08-26T12:00:03.000Z",
    }),
  ]), "utf8");
  await writeFile(skippedPath, jsonl([
    humanMessage({
      sessionId: "outside", cwd: path.join(fixture, "outside"), uuid: "outside-user",
      parentUuid: "outside-root", content: "outside",
    }),
  ]), "utf8");
  return { project, temporaryRoot, rootPath, skippedPath };
}

test("imports Claude sessions and cleans the successful outbox", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const { project, temporaryRoot, rootPath, skippedPath } = await writeRunnerTranscripts(fixture);
    const nams = createNamsFetchMock()
      .createConversation()
      .message()
      .reasoningStep()
      .toolCall();
    const progress: string[] = [];
    const summary = await runClaudeReplay({
      importRoot: project,
      temporaryRoot: path.relative(process.cwd(), temporaryRoot),
      fetch: nams.fetch,
      onProgress: (line) => progress.push(line),
    });

    assert.deepEqual(summary, {
      discoveredFiles: 2,
      matchedFiles: 1,
      skippedFiles: 1,
      sessions: 1,
      conversations: 1,
      messages: 1,
      reasoningSteps: 1,
      toolCalls: 1,
      malformedLines: 0,
      unsupportedRecords: 0,
    });
    assert.deepEqual(progress.slice(0, 2), [
      `Claude replay file imported: ${rootPath}`,
      `Claude replay file skipped: ${skippedPath}`,
    ]);
    assert.equal(
      progress[2].startsWith(
        `Claude replay outbox: ${temporaryRoot}${path.sep}nams-hooks-claude-replay-`,
      ),
      true,
    );
    assert.equal(progress[2].endsWith(`${path.sep}outbox.jsonl`), true);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("cleans a Claude outbox after fail-fast delivery", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const { project, temporaryRoot } = await writeRunnerTranscripts(fixture);
    const nams = createNamsFetchMock()
      .createConversation()
      .message({ error: "failed" }, 500)
      .reasoningStep()
      .toolCall();
    await assert.rejects(
      runClaudeReplay({ importRoot: project, temporaryRoot, fetch: nams.fetch }),
      new Error("NAMS request failed during Claude replay"),
    );
    assert.equal(nams.calls().length, 2);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("a fresh Claude restart recreates and resends the complete outbox", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const { project, temporaryRoot } = await writeRunnerTranscripts(fixture);
    const nams = createNamsFetchMock()
      .createConversation()
      .message()
      .reasoningStep()
      .toolCall();
    await runClaudeReplay({ importRoot: project, temporaryRoot, fetch: nams.fetch });
    await runClaudeReplay({ importRoot: project, temporaryRoot, fetch: nams.fetch });
    assert.equal(nams.calls("createConversation").length, 2);
    assert.equal(nams.calls("addMessage").length, 2);
    assert.equal(nams.calls("addReasoningStep").length, 2);
    assert.equal(nams.calls("addToolCall").length, 2);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});
