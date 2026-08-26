import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectCodexReplaySessions } from "../../src/platforms/codex/replay-collector.js";
import {
  completedItem,
  jsonl,
  responseItem,
  sessionMeta,
  taskComplete,
  type RolloutRecord,
} from "../support/codex-rollout-fixture.js";

test("groups root and subagent rollouts by session and assembles tool-bearing steps", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-collector-"));
  try {
    const project = path.join(fixture, "project");
    const rootPath = path.join(fixture, "sessions", "root.jsonl");
    const childPath = path.join(fixture, "sessions", "subagents", "child.jsonl");
    const outsidePath = path.join(fixture, "sessions", "outside.jsonl");
    await mkdir(path.dirname(childPath), { recursive: true });
    await mkdir(project, { recursive: true });

    const sessionId = "session-1";
    const rootThread = "thread-root";
    const childThread = "thread-child";
    const rootTurn = "turn-root";
    const childTurn = "turn-child";

    await writeFile(rootPath, jsonl([
      sessionMeta({ sessionId, cwd: project, threadSource: "user" }),
      completedItem(1, rootThread, rootTurn, {
        type: "UserMessage",
        id: "user-1",
        content: [{ type: "text", text: "Build it." }],
      }),
      responseItem(2, rootTurn, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>do not import</environment_context>" }],
      }),
      responseItem(3, rootTurn, {
        type: "reasoning",
        id: "reasoning-1",
        summary: [],
        encrypted_content: "do-not-store",
      }),
      completedItem(4, rootThread, rootTurn, {
        type: "AgentMessage",
        id: "assistant-1",
        phase: "commentary",
        content: [{ type: "Text", text: "I will inspect and test." }],
      }),
      responseItem(5, rootTurn, {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "I will inspect and test." }],
      }),
      responseItem(6, rootTurn, {
        type: "custom_tool_call",
        id: "custom-item-1",
        call_id: "call-1",
        name: "exec",
        input: "run first",
        status: "completed",
      }),
      responseItem(7, rootTurn, {
        type: "custom_tool_call_output",
        call_id: "call-1",
        output: [
          { type: "input_text", text: "Script completed\nOutput:\n" },
          { type: "input_text", text: "first" },
          { type: "input_text", text: " second" },
        ],
      }),
      responseItem(8, rootTurn, {
        type: "function_call",
        id: "function-item-1",
        call_id: "call-2",
        namespace: "collaboration",
        name: "wait_agent",
        arguments: "{\"timeout_ms\":60000}",
        duration_ms: 25,
      }),
      responseItem(9, rootTurn, {
        type: "function_call_output",
        call_id: "call-2",
        output: "{\"message\":\"Wait timed out.\",\"timed_out\":true}",
      }),
      responseItem(10, rootTurn, {
        type: "reasoning",
        id: "reasoning-empty",
        summary: [],
        encrypted_content: "do-not-store",
      }),
      taskComplete(11, rootThread, rootTurn),
    ]), "utf8");

    await writeFile(childPath, jsonl([
      sessionMeta({ sessionId, cwd: project, threadSource: "subagent" }),
      completedItem(1, childThread, childTurn, {
        type: "AgentMessage",
        id: "child-assistant",
        phase: "final_answer",
        content: [{ type: "Text", text: "Do not flatten this child message." }],
      }),
      responseItem(2, childTurn, { type: "reasoning", id: "child-reasoning", summary: [], encrypted_content: "private" }),
      responseItem(3, childTurn, {
        type: "custom_tool_call",
        id: "custom-item-2",
        call_id: "call-3",
        name: "exec",
        input: "run child",
        status: "completed",
      }),
      responseItem(4, childTurn, {
        type: "custom_tool_call_output",
        call_id: "call-3",
        output: [
          { type: "input_text", text: "Script failed\nOutput:\n" },
          { type: "input_text", text: "failure detail" },
        ],
      }),
      taskComplete(5, childThread, childTurn),
    ]), "utf8");

    await writeFile(outsidePath, jsonl([
      sessionMeta({ sessionId: "outside", cwd: path.join(fixture, "other"), threadSource: "user" }),
    ]), "utf8");

    const collection = await collectCodexReplaySessions({
      importRoot: project,
      transcriptPaths: [outsidePath, childPath, rootPath],
    });

    assert.equal(collection.discoveredFiles, 3);
    assert.equal(collection.matchedFiles, 2);
    assert.equal(collection.skippedFiles, 1);
    assert.equal(collection.sessions.length, 1);
    const [session] = collection.sessions;
    assert.equal(session.sourceSessionId, sessionId);
    assert.equal(session.projectDirectory, project);
    assert.deepEqual(session.messages.map(({ timestamp: _timestamp, ordinal: _ordinal, threadId: _threadId, ...message }) => message), [
      { role: "user", content: "Build it." },
      { role: "assistant", content: "I will inspect and test." },
    ]);
    assert.equal(session.steps.length, 2);
    const rootStep = session.steps.find((step) => step.threadId === rootThread);
    const childStep = session.steps.find((step) => step.threadId === childThread);
    assert.ok(rootStep);
    assert.ok(childStep);
    assert.deepEqual(rootStep.toolCalls.map((call) => ({
      toolName: call.toolName,
      input: call.input,
      output: call.output,
      status: call.status,
      durationMs: call.durationMs,
    })), [
      {
        toolName: "exec",
        input: "run first",
        output: "Script completed\nOutput:\nfirst second",
        status: "success",
        durationMs: 1000,
      },
      {
        toolName: "wait_agent",
        input: { namespace: "collaboration", input: { timeout_ms: 60000 } },
        output: "{\"message\":\"Wait timed out.\",\"timed_out\":true}",
        status: "timeout",
        durationMs: 25,
      },
    ]);
    assert.equal(rootStep.reasoning, "I will inspect and test.");
    assert.equal(rootStep.actionTaken, "Ran 2 tool calls: exec, wait_agent");
    assert.equal(childStep.toolCalls[0].output, "Script failed\nOutput:\nfailure detail");
    assert.equal(childStep.toolCalls[0].status, "failure");
    assert.equal(session.messages.some((message) => message.content.includes("environment_context")), false);
    assert.equal(session.messages.some((message) => message.content.includes("child message")), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("does not replace the first absolute cwd when its metadata lacks session identity", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-collector-cwd-"));
  try {
    const project = path.join(fixture, "project");
    const outsideProject = path.join(fixture, "outside");
    const rolloutPath = path.join(fixture, "sessions", "rollout.jsonl");
    await mkdir(path.dirname(rolloutPath), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(rolloutPath, jsonl([
      {
        timestamp: "2026-08-26T12:00:00.000Z",
        ordinal: 0,
        type: "session_meta",
        payload: { cwd: outsideProject },
      },
      sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
    ]), "utf8");

    const collection = await collectCodexReplaySessions({
      importRoot: project,
      transcriptPaths: [rolloutPath],
    });

    assert.equal(collection.matchedFiles, 0);
    assert.equal(collection.skippedFiles, 1);
    assert.deepEqual(collection.sessions, []);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("reports an absolute path for an injected relative rollout path", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-relative-path-"));
  try {
    const project = path.join(fixture, "project");
    const rolloutPath = path.join(fixture, "sessions", "rollout.jsonl");
    await mkdir(path.dirname(rolloutPath), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(rolloutPath, jsonl([
      sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
    ]), "utf8");
    const progress: Array<{ path: string; status: "imported" | "skipped" }> = [];

    const collection = await collectCodexReplaySessions({
      importRoot: project,
      transcriptPaths: [path.relative(process.cwd(), rolloutPath)],
      onFileProcessed: (event) => progress.push(event),
    });

    assert.equal(collection.matchedFiles, 1);
    assert.deepEqual(progress, [{ path: rolloutPath, status: "imported" }]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function withSingleRollout(
  recordsFor: (project: string) => RolloutRecord[],
  assertion: (
    collection: Awaited<ReturnType<typeof collectCodexReplaySessions>>,
  ) => void | Promise<void>,
): Promise<void> {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-edge-"));
  try {
    const project = path.join(fixture, "project");
    const rolloutPath = path.join(fixture, "sessions", "rollout.jsonl");
    await mkdir(path.dirname(rolloutPath), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(rolloutPath, jsonl(recordsFor(project)), "utf8");
    await assertion(await collectCodexReplaySessions({
      importRoot: project,
      transcriptPaths: [rolloutPath],
    }));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test("keeps output on the originating step when a later reasoning boundary appears", async () => {
  await withSingleRollout((project) => [
    sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
    responseItem(1, "turn-1", {
      type: "reasoning",
      id: "reasoning-1",
      summary: [],
      encrypted_content: "private",
    }),
    responseItem(2, "turn-1", {
      type: "custom_tool_call",
      call_id: "call-1",
      name: "exec",
      input: "first command",
    }),
    responseItem(3, "turn-1", {
      type: "reasoning",
      id: "reasoning-2",
      summary: [],
      encrypted_content: "private",
    }),
    responseItem(4, "turn-1", {
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: [
        { type: "input_text", text: "Script completed\nOutput:\n" },
        { type: "input_text", text: "late" },
      ],
    }),
    responseItem(5, "turn-1", {
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: [
        { type: "input_text", text: " output" },
        { type: "input_text", text: " from every part" },
      ],
    }),
    taskComplete(6, "thread-1", "turn-1"),
  ], (collection) => {
    const [session] = collection.sessions;
    assert.equal(session.steps.length, 1);
    assert.equal(session.steps[0].sourceReasoningId, "reasoning-1");
    assert.equal(
      session.steps[0].toolCalls[0].output,
      "Script completed\nOutput:\nlate output from every part",
    );
    assert.equal(session.steps[0].toolCalls[0].status, "success");
  });
});

test("creates one fallback step for calls before the first reasoning item", async () => {
  await withSingleRollout((project) => [
    sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
    responseItem(1, "turn-1", {
      type: "custom_tool_call",
      call_id: "call-1",
      name: "exec",
      input: "first command",
    }),
    responseItem(2, "turn-1", {
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: [{ type: "input_text", text: "Script completed\nOutput:\nfirst" }],
    }),
    responseItem(3, "turn-1", {
      type: "function_call",
      call_id: "call-2",
      namespace: "collaboration",
      name: "wait_agent",
      arguments: "{\"timeout_ms\":1000}",
    }),
    responseItem(4, "turn-1", {
      type: "function_call_output",
      call_id: "call-2",
      output: "{\"message\":\"done\",\"timed_out\":false}",
    }),
    taskComplete(5, "thread-1", "turn-1"),
  ], (collection) => {
    const [session] = collection.sessions;
    assert.equal(session.steps.length, 1);
    assert.equal(session.steps[0].localStepId.endsWith(":fallback"), true);
    assert.deepEqual(
      session.steps[0].toolCalls.map((call) => call.sourceCallId),
      ["call-1", "call-2"],
    );
    assert.equal(session.steps[0].toolCalls[0].status, "success");
    assert.equal(session.steps[0].toolCalls[1].status, undefined);
  });
});

test("prefers explicit output duration over timestamps without replacing call duration", async () => {
  await withSingleRollout((project) => [
    sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
    responseItem(1, "turn-1", {
      type: "custom_tool_call",
      call_id: "call-output-duration",
      name: "exec",
      input: "first command",
    }),
    responseItem(2, "turn-1", {
      type: "custom_tool_call_output",
      call_id: "call-output-duration",
      output: "first output",
      durationMs: 37,
    }),
    responseItem(3, "turn-1", {
      type: "custom_tool_call",
      call_id: "call-duration",
      name: "exec",
      input: "second command",
      duration_ms: 11,
    }),
    responseItem(4, "turn-1", {
      type: "custom_tool_call_output",
      call_id: "call-duration",
      output: "second output",
      duration_ms: 99,
    }),
    taskComplete(5, "thread-1", "turn-1"),
  ], (collection) => {
    assert.deepEqual(
      collection.sessions[0].steps[0].toolCalls.map((call) => call.durationMs),
      [37, 11],
    );
  });
});

test("rejects one session id with conflicting project directories", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-conflict-"));
  try {
    const importRoot = path.join(fixture, "project");
    const firstProject = path.join(importRoot, "first");
    const secondProject = path.join(importRoot, "second");
    const firstPath = path.join(fixture, "sessions", "first.jsonl");
    const secondPath = path.join(fixture, "sessions", "second.jsonl");
    await mkdir(path.dirname(firstPath), { recursive: true });
    await mkdir(firstProject, { recursive: true });
    await mkdir(secondProject, { recursive: true });
    await writeFile(firstPath, jsonl([
      sessionMeta({ sessionId: "session-1", cwd: firstProject, threadSource: "user" }),
    ]), "utf8");
    await writeFile(secondPath, jsonl([
      sessionMeta({ sessionId: "session-1", cwd: secondProject, threadSource: "subagent" }),
    ]), "utf8");

    await assert.rejects(
      collectCodexReplaySessions({
        importRoot,
        transcriptPaths: [firstPath, secondPath],
      }),
      new Error("Codex session session-1 has conflicting project directories"),
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("counts malformed lines and orphan outputs as unsupported records", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-malformed-"));
  try {
    const project = path.join(fixture, "project");
    const rolloutPath = path.join(fixture, "sessions", "rollout.jsonl");
    await mkdir(path.dirname(rolloutPath), { recursive: true });
    await mkdir(project, { recursive: true });
    const records = [
      sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
      completedItem(1, "thread-1", "turn-1", {
        type: "UserMessage",
        content: [{ type: "text", text: "Keep parsing." }],
      }),
      responseItem(2, "turn-1", {
        type: "function_call_output",
        call_id: "missing-call",
        output: "orphaned",
      }),
      taskComplete(3, "thread-1", "turn-1"),
    ];
    const contents = [
      JSON.stringify(records[0]),
      "{not valid json",
      ...records.slice(1).map((record) => JSON.stringify(record)),
      "",
    ].join("\n");
    await writeFile(rolloutPath, contents, "utf8");

    const collection = await collectCodexReplaySessions({
      importRoot: project,
      transcriptPaths: [rolloutPath],
    });

    assert.equal(collection.malformedLines, 1);
    assert.equal(collection.unsupportedRecords, 1);
    assert.equal(collection.sessions[0].messages[0].content, "Keep parsing.");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
