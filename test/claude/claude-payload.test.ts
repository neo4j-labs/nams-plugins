import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClaudePayload } from "../../src/platforms/claude/payload.js";

test("extracts Claude prompt/session fields from snake_case payload", async () => {
  const info = parseClaudePayload(
    {
      session_id: "session-1",
      cwd: "/project",
      transcript_path: "/tmp/transcript.jsonl",
      source: "claude-code",
      prompt: "Remember this",
      hook_event_name: "UserPromptSubmit",
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    sessionId: "session-1",
    projectDirectory: "/project",
    transcriptPath: "/tmp/transcript.jsonl",
    source: "claude-code",
    prompt: "Remember this",
  });
});

test("extracts Claude tool fields and numeric duration from string duration", async () => {
  const toolInput = { command: "npm test" };
  const toolResponse = { stdout: "ok" };

  const info = parseClaudePayload(
    {
      cwd: "/project",
      tool_use_id: "tool-1",
      tool_name: "Bash",
      tool_input: toolInput,
      tool_response: toolResponse,
      duration_ms: "42.5",
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    projectDirectory: "/project",
    toolUseId: "tool-1",
    toolName: "Bash",
    toolInput,
    toolResponse,
    durationMs: 42.5,
  });
});

test("extracts Claude Stop assistant message and falls back to process cwd", async () => {
  const info = parseClaudePayload(
    {
      last_assistant_message: "I updated the parser.",
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    projectDirectory: "/fallback",
    lastAssistantMessage: "I updated the parser.",
  });
});

test("ignores blank string aliases", async () => {
  const info = parseClaudePayload(
    {
      session_id: " ",
      sessionId: "",
      cwd: "",
      CLAUDE_PROJECT_DIR: "   ",
      transcript_path: " ",
      transcriptPath: "",
      source: " ",
      prompt: "",
      tool_use_id: " ",
      toolUseId: "",
      tool_name: "",
      toolName: " ",
      duration_ms: " ",
      durationMs: Number.POSITIVE_INFINITY,
      last_assistant_message: "",
      lastAssistantMessage: " ",
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    projectDirectory: "/fallback",
  });
});

test("accepts Claude camelCase aliases", async () => {
  const toolInput = ["file.txt"];
  const toolResponse = null;

  const info = parseClaudePayload(
    {
      sessionId: "session-2",
      CLAUDE_PROJECT_DIR: "/project-alias",
      transcriptPath: "/tmp/alias.jsonl",
      toolUseId: "tool-2",
      toolName: "Read",
      toolInput,
      toolResponse,
      durationMs: 18,
      lastAssistantMessage: "Done.",
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    sessionId: "session-2",
    projectDirectory: "/project-alias",
    transcriptPath: "/tmp/alias.jsonl",
    toolUseId: "tool-2",
    toolName: "Read",
    toolInput,
    toolResponse,
    durationMs: 18,
    lastAssistantMessage: "Done.",
  });
});

test("prefers snake_case tool values when both aliases are present", async () => {
  const snakeToolInput = { command: "npm test" };
  const camelToolInput = { command: "npm run build" };
  const snakeToolResponse = { stdout: "snake" };
  const camelToolResponse = { stdout: "camel" };

  const info = parseClaudePayload(
    {
      tool_input: snakeToolInput,
      toolInput: camelToolInput,
      tool_response: snakeToolResponse,
      toolResponse: camelToolResponse,
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    projectDirectory: "/fallback",
    toolInput: snakeToolInput,
    toolResponse: snakeToolResponse,
  });
});
