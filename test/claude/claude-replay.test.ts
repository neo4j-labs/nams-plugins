import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  claudeReplayAdapter,
  discoverClaudeReplayTranscripts,
  readClaudeReplayTranscript,
} from "../../src/platforms/claude/replay.js";

test("discovers Claude project and subagent JSONL files from CLAUDE_CONFIG_DIR", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-replay-"));
  try {
    const project = path.join(fixture, "projects", "encoded-project");
    const defaultTranscript = path.join(fixture, "home", ".claude", "projects", "default", "session-default.jsonl");
    await mkdir(path.join(project, "session-1", "subagents"), { recursive: true });
    await mkdir(path.dirname(defaultTranscript), { recursive: true });
    await writeFile(path.join(project, "session-1.jsonl"), "{}\n", "utf8");
    await writeFile(path.join(project, "session-1", "subagents", "agent-a.jsonl"), "{}\n", "utf8");
    await writeFile(defaultTranscript, "{}\n", "utf8");
    assert.deepEqual(await discoverClaudeReplayTranscripts({ CLAUDE_CONFIG_DIR: fixture }), [
      path.join(project, "session-1.jsonl"),
      path.join(project, "session-1", "subagents", "agent-a.jsonl"),
    ]);
    assert.deepEqual(await discoverClaudeReplayTranscripts({ HOME: path.join(fixture, "home") }), [defaultTranscript]);
    assert.equal(claudeReplayAdapter.platform, "claude");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("normalizes Claude visible messages and explicitly paired tool activity", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-replay-"));
  try {
    const transcriptPath = path.join(fixture, "fallback-session.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({
        type: "user",
        sessionId: "claude-session-1",
        cwd: "/workspaces/nams-hooks",
        isSidechain: true,
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { role: "user", content: [
          { type: "text", text: "Build replay." },
          { type: "image", text: "do not import", source: { type: "base64", data: "skip" } },
        ] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "I will inspect it." },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/cli.ts", result: "strip" } },
          { type: "text", text: "Inspection queued." },
        ] },
      }),
      "{malformed",
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "file contents", is_error: false },
          { type: "tool_result", tool_use_id: "orphan", content: "ignore me", is_error: true },
          { type: "text", text: "Continue." },
        ] },
      }),
      JSON.stringify({ type: "system", cwd: "/different/project", message: { role: "system", content: "ignore" } }),
    ].join("\n"), "utf8");

    assert.deepEqual(await readClaudeReplayTranscript(transcriptPath), {
      sourceSessionId: "claude-session-1",
      projectDirectory: path.normalize("/workspaces/nams-hooks"),
      sourceStartedAt: "2026-08-01T10:00:00.000Z",
      malformedLineCount: 1,
      unsupportedRecordCount: 2,
      records: [
        { kind: "message", role: "user", content: "Build replay." },
        { kind: "message", role: "assistant", content: "I will inspect it." },
        {
          kind: "tool",
          toolName: "Read",
          input: { file_path: "src/cli.ts", result: "strip" },
          output: "file contents",
          status: "success",
          reasoningStep: {
            reasoning: "Claude Code ran Read with the provided tool input.",
            actionTaken: "Ran Read",
          },
        },
        { kind: "message", role: "assistant", content: "Inspection queued." },
        { kind: "message", role: "user", content: "Continue." },
      ],
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("the first Claude cwd occurrence is authoritative even when unusable", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-replay-"));
  try {
    const transcriptPath = path.join(fixture, "session.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({ type: "user", cwd: "relative/path", message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "assistant", cwd: "/later/absolute", message: { role: "assistant", content: "second" } }),
    ].join("\n"), "utf8");
    const transcript = await readClaudeReplayTranscript(transcriptPath);
    assert.equal(transcript.projectDirectory, undefined);
    assert.equal(transcript.sourceSessionId, "session");
    assert.equal(transcript.records.length, 2);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
