import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  collectClaudeReplaySessions,
  discoverClaudeTranscriptPaths,
} from "../../src/platforms/claude/replay-collector.js";
import {
  assistantBlock,
  claudeRecord,
  humanMessage,
  jsonl,
  taskNotification,
  toolResult,
} from "../support/claude-rollout-fixture.js";

test("groups a root and linked subagent while preserving the active root conversation", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-collector-"));
  try {
    const project = path.join(fixture, "project");
    const projectDir = path.join(fixture, "claude", "projects", "encoded-project");
    const sessionId = "session-1";
    const rootPath = path.join(projectDir, `${sessionId}.jsonl`);
    const agentId = "agent-1";
    const childPath = path.join(projectDir, sessionId, "subagents", `${agentId}.jsonl`);
    await mkdir(path.dirname(childPath), { recursive: true });
    await mkdir(project, { recursive: true });

    await writeFile(rootPath, jsonl([
      claudeRecord({
        type: "system", uuid: "root", parentUuid: null, sessionId, cwd: project,
        isSidechain: false, message: { role: "system", content: "ignore" },
      }),
      humanMessage({
        sessionId, cwd: project, uuid: "user-1", parentUuid: "root",
        content: "<command-message>run</command-message><command-name>/run</command-name><command-args>the plan</command-args>",
        timestamp: "2026-08-26T12:00:01.000Z",
      }),
      assistantBlock({
        sessionId, cwd: project, uuid: "assistant-1", parentUuid: "user-1",
        messageId: "message-1", block: { type: "thinking", thinking: "", signature: "do-not-store" },
        timestamp: "2026-08-26T12:00:02.000Z",
      }),
      assistantBlock({
        sessionId, cwd: project, uuid: "assistant-2", parentUuid: "assistant-1",
        messageId: "message-1", block: { type: "text", text: "I will delegate and inspect." },
        timestamp: "2026-08-26T12:00:02.100Z",
      }),
      assistantBlock({
        sessionId, cwd: project, uuid: "assistant-3", parentUuid: "assistant-2",
        messageId: "message-1", block: {
          type: "tool_use", id: "call-agent", name: "Agent", input: { prompt: "inspect" },
        },
        timestamp: "2026-08-26T12:00:02.200Z",
      }),
      assistantBlock({
        sessionId, cwd: path.join(project, "src"), uuid: "assistant-4", parentUuid: "assistant-3",
        messageId: "message-1", block: {
          type: "tool_use", id: "call-read", name: "Read", input: { file_path: "src/a.ts" },
        },
        timestamp: "2026-08-26T12:00:02.300Z",
      }),
      toolResult({
        sessionId, cwd: project, uuid: "result-agent", parentUuid: "assistant-3",
        toolUseId: "call-agent", content: [{ type: "text", text: "Agent launched." }],
        toolUseResult: { isAsync: true, status: "async_launched", agentId },
        timestamp: "2026-08-26T12:00:03.000Z",
      }),
      toolResult({
        sessionId, cwd: project, uuid: "result-read", parentUuid: "assistant-4",
        toolUseId: "call-read", content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
        timestamp: "2026-08-26T12:00:03.100Z",
      }),
      humanMessage({
        sessionId, cwd: project, uuid: "abandoned", parentUuid: "result-read",
        content: "incomplete replacement", timestamp: "2026-08-26T12:00:04.000Z",
      }),
      humanMessage({
        sessionId, cwd: project, uuid: "user-2", parentUuid: "result-read",
        content: "Continue with the complete request.", timestamp: "2026-08-26T12:00:05.000Z",
      }),
      assistantBlock({
        sessionId, cwd: project, uuid: "assistant-final", parentUuid: "user-2",
        messageId: "message-final", block: { type: "text", text: "Completed." },
        timestamp: "2026-08-26T12:00:06.000Z",
      }),
      taskNotification({
        sessionId, cwd: project, uuid: "notification", parentUuid: "assistant-final",
        toolUseId: "call-agent", status: "completed", result: "Agent completed.",
        timestamp: "2026-08-26T12:00:07.000Z",
      }),
    ]), "utf8");

    await writeFile(childPath, jsonl([
      claudeRecord({
        type: "user", uuid: "child-root", parentUuid: null, sessionId, cwd: path.join(project, "src"),
        isSidechain: true, agentId, message: { role: "user", content: "internal assignment" },
      }),
      assistantBlock({
        sessionId, cwd: path.join(project, "src"), uuid: "child-assistant-1", parentUuid: "child-root",
        messageId: "child-message", isSidechain: true, agentId,
        block: { type: "tool_use", id: "child-call", name: "Bash", input: { command: "pwd" } },
        timestamp: "2026-08-26T12:00:04.100Z",
      }),
      toolResult({
        sessionId, cwd: path.join(project, "src"), uuid: "child-result", parentUuid: "child-assistant-1",
        toolUseId: "child-call", content: "child output", isSidechain: true, agentId, isError: true,
        timestamp: "2026-08-26T12:00:04.200Z",
      }),
      assistantBlock({
        sessionId, cwd: project, uuid: "child-final", parentUuid: "child-result",
        messageId: "child-final-message", isSidechain: true, agentId,
        block: { type: "text", text: "Do not flatten this child response." },
        timestamp: "2026-08-26T12:00:04.300Z",
      }),
    ]), "utf8");
    await writeFile(path.join(path.dirname(childPath), `${agentId}.meta.json`), JSON.stringify({
      agentType: "general-purpose",
      description: "inspect",
      toolUseId: "call-agent",
      spawnDepth: 1,
      model: "claude",
    }), "utf8");

    const collection = await collectClaudeReplaySessions({
      importRoot: project,
      transcriptPaths: [childPath, rootPath],
    });

    assert.equal(collection.discoveredFiles, 2);
    assert.equal(collection.matchedFiles, 2);
    assert.equal(collection.skippedFiles, 0);
    assert.equal(collection.sessions.length, 1);
    const [session] = collection.sessions;
    assert.deepEqual(
      session.messages.map(({ timestamp: _timestamp, ordinal: _ordinal, streamId: _streamId, ...message }) => message),
      [
        { role: "user", content: "/run the plan" },
        { role: "assistant", content: "I will delegate and inspect." },
        { role: "user", content: "Continue with the complete request." },
        { role: "assistant", content: "Completed." },
      ],
    );
    assert.equal(session.messages.some((message) => message.content.includes("incomplete")), false);
    assert.equal(session.messages.some((message) => message.content.includes("child response")), false);
    assert.equal(session.steps.length, 2);
    const rootStep = session.steps.find((step) => step.streamId === "root");
    const childStep = session.steps.find((step) => step.streamId === `agent:${agentId}`);
    assert.ok(rootStep);
    assert.ok(childStep);
    assert.equal(rootStep.sourceAssistantMessageId, "message-1");
    assert.equal(rootStep.reasoning, "I will delegate and inspect.");
    assert.deepEqual(rootStep.toolCalls.map((call) => ({
      name: call.toolName,
      output: call.output,
      status: call.status,
      durationMs: call.durationMs,
    })), [
      { name: "Agent", output: "Agent launched.\n\nAgent completed.", status: "success", durationMs: 4800 },
      { name: "Read", output: "first\n\nsecond", status: "success", durationMs: 800 },
    ]);
    assert.equal(childStep.toolCalls[0].output, "child output");
    assert.equal(childStep.toolCalls[0].status, "error");
    assert.equal(JSON.stringify(session).includes("do-not-store"), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("discovers root and subagent JSONL only beneath the Claude projects directory", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-discovery-"));
  try {
    const projects = path.join(fixture, "projects", "encoded");
    const rootPath = path.join(projects, "session-1.jsonl");
    const childPath = path.join(projects, "session-1", "subagents", "agent-1.jsonl");
    await mkdir(path.dirname(childPath), { recursive: true });
    await writeFile(rootPath, "{}\n", "utf8");
    await writeFile(childPath, "{}\n", "utf8");
    await writeFile(path.join(projects, "session-1", "subagents", "agent-1.meta.json"), "{}\n", "utf8");
    await mkdir(path.join(projects, "session-1", "tool-results"), { recursive: true });
    await writeFile(path.join(projects, "session-1", "tool-results", "large.txt"), "not-jsonl", "utf8");
    await mkdir(path.join(projects, "memory"), { recursive: true });
    await writeFile(path.join(projects, "memory", "history.jsonl"), "{}\n", "utf8");

    assert.deepEqual(await discoverClaudeTranscriptPaths({ CLAUDE_CONFIG_DIR: fixture }), [
      rootPath,
      childPath,
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("does not read a persisted companion outside the transcript corpus", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-persisted-adversarial-"));
  try {
    const project = path.join(fixture, "project");
    const projectDir = path.join(fixture, "projects", "encoded");
    const rootPath = path.join(projectDir, "session-1.jsonl");
    const externalOutput = path.join(fixture, "projects", "external", "tool-results", "large.txt");
    await mkdir(projectDir, { recursive: true });
    await mkdir(path.dirname(externalOutput), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(externalOutput, "external secret", "utf8");
    await writeFile(rootPath, jsonl([
      humanMessage({ sessionId: "../external", cwd: project, uuid: "user", parentUuid: "root", content: "Run it." }),
      assistantBlock({
        sessionId: "../external", cwd: project, uuid: "call", parentUuid: "user", messageId: "message-1",
        block: { type: "tool_use", id: "call-1", name: "Bash", input: { command: "run" } },
      }),
      toolResult({
        sessionId: "../external", cwd: project, uuid: "result", parentUuid: "call", toolUseId: "call-1",
        content: "safe preview",
        toolUseResult: {
          persistedOutputPath: "/untrusted/original/large.txt",
          persistedOutputSize: Buffer.byteLength("external secret"),
        },
      }),
    ]), "utf8");

    const collection = await collectClaudeReplaySessions({ importRoot: project, transcriptPaths: [rootPath] });
    assert.equal(collection.sessions[0].steps[0].toolCalls[0].output, "safe preview");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("preserves direct result order and appends root notification output", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-output-order-"));
  try {
    const project = path.join(fixture, "project");
    const rootPath = path.join(fixture, "projects", "encoded", "session-1.jsonl");
    await mkdir(path.dirname(rootPath), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(rootPath, jsonl([
      humanMessage({ sessionId: "session-1", cwd: project, uuid: "user", parentUuid: "root", content: "Run it." }),
      assistantBlock({
        sessionId: "session-1", cwd: project, uuid: "call", parentUuid: "user", messageId: "message-1",
        block: { type: "tool_use", id: "call-1", name: "Bash", input: { command: "run" } },
        timestamp: "2026-08-26T12:00:03.000Z",
      }),
      toolResult({
        sessionId: "session-1", cwd: project, uuid: "result", parentUuid: "call", toolUseId: "call-1",
        content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
        timestamp: "2026-08-26T12:00:04.000Z",
      }),
      taskNotification({
        sessionId: "session-1", cwd: project, uuid: "notification", parentUuid: "result",
        toolUseId: "call-1", status: "completed", result: "late completion",
        timestamp: "2026-08-26T12:00:01.000Z",
      }),
    ]), "utf8");

    const collection = await collectClaudeReplaySessions({ importRoot: project, transcriptPaths: [rootPath] });
    assert.equal(
      collection.sessions[0].steps[0].toolCalls[0].output,
      "first\n\nsecond\n\nlate completion",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("uses only root notifications when a linked sidechain reuses a call id", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-root-notification-"));
  try {
    const project = path.join(fixture, "project");
    const projectDir = path.join(fixture, "projects", "encoded");
    const rootPath = path.join(projectDir, "session-1.jsonl");
    const childPath = path.join(projectDir, "session-1", "subagents", "agent-1.jsonl");
    await mkdir(path.dirname(childPath), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(rootPath, jsonl([
      humanMessage({ sessionId: "session-1", cwd: project, uuid: "user", parentUuid: "root", content: "Run it." }),
      assistantBlock({
        sessionId: "session-1", cwd: project, uuid: "root-call", parentUuid: "user", messageId: "root-message",
        block: { type: "tool_use", id: "same-call", name: "Agent", input: {} },
      }),
      toolResult({
        sessionId: "session-1", cwd: project, uuid: "root-result", parentUuid: "root-call", toolUseId: "same-call",
        content: "root immediate",
      }),
      taskNotification({
        sessionId: "session-1", cwd: project, uuid: "root-notification", parentUuid: "root-result",
        toolUseId: "same-call", status: "completed", result: "root completion",
      }),
    ]), "utf8");
    await writeFile(childPath, jsonl([
      claudeRecord({
        type: "user", uuid: "child-root", parentUuid: null, sessionId: "session-1", cwd: project,
        isSidechain: true, agentId: "agent-1", message: { role: "user", content: "assignment" },
      }),
      assistantBlock({
        sessionId: "session-1", cwd: project, uuid: "child-call", parentUuid: "child-root", messageId: "child-message",
        isSidechain: true, agentId: "agent-1",
        block: { type: "tool_use", id: "same-call", name: "Bash", input: {} },
      }),
      toolResult({
        sessionId: "session-1", cwd: project, uuid: "child-result", parentUuid: "child-call", toolUseId: "same-call",
        content: "child immediate", isSidechain: true, agentId: "agent-1",
      }),
      claudeRecord({
        type: "user", uuid: "child-notification", parentUuid: "child-result", sessionId: "session-1", cwd: project,
        isSidechain: true, agentId: "agent-1", origin: { kind: "task-notification" },
        message: { role: "user", content: "<task-notification>\n<tool-use-id>same-call</tool-use-id>\n<status>completed</status>\n<result>sidechain completion</result>\n</task-notification>" },
      }),
    ]), "utf8");
    await writeFile(path.join(path.dirname(childPath), "agent-1.meta.json"), JSON.stringify({ toolUseId: "same-call" }), "utf8");

    const collection = await collectClaudeReplaySessions({ importRoot: project, transcriptPaths: [rootPath, childPath] });
    const rootStep = collection.sessions[0].steps.find((step) => step.streamId === "root");
    assert.ok(rootStep);
    assert.equal(rootStep.toolCalls[0].output, "root immediate\n\nroot completion");
    assert.equal(rootStep.toolCalls[0].status, "success");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("skips transcript records when no active UUID spine is available", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-no-active-spine-"));
  try {
    const project = path.join(fixture, "project");
    const rootPath = path.join(fixture, "projects", "encoded", "session-1.jsonl");
    await mkdir(path.dirname(rootPath), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(rootPath, `${[
      { type: "user", sessionId: "session-1", cwd: project, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "uuid-less user" } },
      { type: "assistant", sessionId: "session-1", cwd: project, isSidechain: false, message: { id: "message-1", role: "assistant", content: [{ type: "text", text: "uuid-less assistant" }] } },
    ].map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

    const collection = await collectClaudeReplaySessions({ importRoot: project, transcriptPaths: [rootPath] });
    assert.equal(collection.sessions.length, 0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("does not normalize human-origin metadata as a root user message", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-meta-user-"));
  try {
    const project = path.join(fixture, "project");
    const rootPath = path.join(fixture, "projects", "encoded", "session-1.jsonl");
    await mkdir(path.dirname(rootPath), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(rootPath, jsonl([
      claudeRecord({
        type: "user", uuid: "meta", parentUuid: "root", sessionId: "session-1", cwd: project,
        isSidechain: false, isMeta: true, origin: { kind: "human" },
        message: { role: "user", content: "must not persist" },
      }),
      assistantBlock({
        sessionId: "session-1", cwd: project, uuid: "assistant", parentUuid: "meta", messageId: "message-1",
        block: { type: "text", text: "visible assistant" },
      }),
    ]), "utf8");

    const collection = await collectClaudeReplaySessions({ importRoot: project, transcriptPaths: [rootPath] });
    assert.deepEqual(collection.sessions[0].messages.map((message) => message.content), ["visible assistant"]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("uses a validated session-local companion for persisted Bash output", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-persisted-"));
  try {
    const project = path.join(fixture, "project");
    const projectDir = path.join(fixture, "projects", "encoded");
    const sessionId = "session-1";
    const rootPath = path.join(projectDir, `${sessionId}.jsonl`);
    const outputPath = path.join(projectDir, sessionId, "tool-results", "large.txt");
    const completeOutput = "complete output from companion";
    await mkdir(path.dirname(outputPath), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(outputPath, completeOutput, "utf8");
    await writeFile(rootPath, jsonl([
      humanMessage({ sessionId, cwd: project, uuid: "user", parentUuid: "root", content: "Run it." }),
      assistantBlock({
        sessionId, cwd: project, uuid: "call-row", parentUuid: "user", messageId: "message-1",
        block: { type: "tool_use", id: "call-1", name: "Bash", input: { command: "run" } },
      }),
      toolResult({
        sessionId, cwd: project, uuid: "result", parentUuid: "call-row", toolUseId: "call-1",
        content: "<persisted-output>preview only</persisted-output>",
        toolUseResult: {
          stdout: "truncated",
          stderr: "",
          persistedOutputPath: "/untrusted/original/large.txt",
          persistedOutputSize: Buffer.byteLength(completeOutput),
        },
      }),
    ]), "utf8");

    const collection = await collectClaudeReplaySessions({
      importRoot: project,
      transcriptPaths: [rootPath],
    });
    assert.equal(collection.sessions[0].steps[0].toolCalls[0].output, completeOutput);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("skips a cleared active branch and counts malformed and orphan output", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-empty-"));
  try {
    const project = path.join(fixture, "project");
    const rootPath = path.join(fixture, "projects", "session-1.jsonl");
    await mkdir(path.dirname(rootPath), { recursive: true });
    await mkdir(project, { recursive: true });
    const records = [
      claudeRecord({
        type: "system", uuid: "root", parentUuid: null, sessionId: "session-1", cwd: project,
        isSidechain: false, message: { role: "system", content: "start" },
      }),
      humanMessage({
        sessionId: "session-1", cwd: project, uuid: "abandoned", parentUuid: "root",
        content: "abandoned command",
      }),
      claudeRecord({
        type: "user", uuid: "control", parentUuid: "root", sessionId: "session-1", cwd: project,
        isSidechain: false, isMeta: true, message: { role: "user", content: "<local-command-caveat>clear</local-command-caveat>" },
      }),
      toolResult({
        sessionId: "session-1", cwd: project, uuid: "orphan", parentUuid: "control",
        toolUseId: "missing", content: "orphan",
      }),
    ];
    await writeFile(rootPath, [
      JSON.stringify(records[0]),
      "{malformed",
      ...records.slice(1).map((record) => JSON.stringify(record)),
      "",
    ].join("\n"), "utf8");

    const progress: Array<{ path: string; status: "imported" | "skipped" }> = [];
    const collection = await collectClaudeReplaySessions({
      importRoot: project,
      transcriptPaths: [rootPath],
      onFileProcessed: (event) => progress.push(event),
    });
    assert.equal(collection.malformedLines, 1);
    assert.equal(collection.unsupportedRecords, 1);
    assert.equal(collection.sessions.length, 0);
    assert.deepEqual(progress, [{ path: rootPath, status: "skipped" }]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
