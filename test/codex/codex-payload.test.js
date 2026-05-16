import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const payloadUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "codex", "payload.js")).href;

test("extracts Codex common and prompt fields from hook payload", async () => {
  const { parseCodexPayload } = await import(payloadUrl);
  const info = parseCodexPayload(
    {
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: "/project",
      transcript_path: "/tmp/transcript.jsonl",
      hook_event_name: "UserPromptSubmit",
      source: "codex-cli",
      model: "gpt-5",
      permission_mode: "ask",
      prompt: "Remember this",
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    sessionId: "session-1",
    turnId: "turn-1",
    projectDirectory: "/project",
    transcriptPath: "/tmp/transcript.jsonl",
    hookEventName: "UserPromptSubmit",
    source: "codex-cli",
    model: "gpt-5",
    permissionMode: "ask",
    prompt: "Remember this",
  });
});

test("extracts Codex stop and post-tool fields from hook payload", async () => {
  const { parseCodexPayload } = await import(payloadUrl);
  const toolInput = { command: "npm test" };
  const info = parseCodexPayload(
    {
      cwd: "/project",
      last_assistant_message: "I updated the parser.",
      stop_hook_active: true,
      tool_name: "shell",
      tool_use_id: "tool-1",
      tool_input: toolInput,
      tool_response: null,
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    projectDirectory: "/project",
    lastAssistantMessage: "I updated the parser.",
    stopHookActive: true,
    toolName: "shell",
    toolUseId: "tool-1",
    toolInput,
    toolResponse: null,
  });
});

test("falls back to process cwd, ignores blank strings, and accepts camelCase aliases", async () => {
  const { parseCodexPayload } = await import(payloadUrl);
  const info = parseCodexPayload(
    {
      session_id: " ",
      sessionId: "session-2",
      turnId: "turn-2",
      cwd: "",
      transcriptPath: "/tmp/alias.jsonl",
      hookEventName: "Stop",
      permissionMode: "full-access",
      lastAssistantMessage: "Done.",
      toolName: "read",
      toolUseId: "tool-2",
      toolInput: ["file.txt"],
      toolResponse: { ok: true },
      source: " ",
      model: "",
      prompt: "   ",
      stop_hook_active: "true",
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    sessionId: "session-2",
    turnId: "turn-2",
    projectDirectory: "/fallback",
    transcriptPath: "/tmp/alias.jsonl",
    hookEventName: "Stop",
    permissionMode: "full-access",
    lastAssistantMessage: "Done.",
    toolName: "read",
    toolUseId: "tool-2",
    toolInput: ["file.txt"],
    toolResponse: { ok: true },
  });
});
