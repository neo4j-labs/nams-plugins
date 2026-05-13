import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const payloadUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "opencode", "payload.js")).href;

test("extracts OpenCode event session metadata", async () => {
  const { parseOpenCodePayload } = await import(payloadUrl);
  const info = parseOpenCodePayload(
    {
      hook: "event",
      directory: "/project",
      event: {
        type: "session.created",
        properties: { info: { id: "session-1", directory: "/project-from-session" } },
      },
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    hookName: "event",
    eventType: "session.created",
    sessionId: "session-1",
    projectDirectory: "/project",
  });
});

test("extracts OpenCode chat message prompt from non-ignored text parts", async () => {
  const { parseOpenCodePayload } = await import(payloadUrl);
  const info = parseOpenCodePayload(
    {
      hook: "chat.message",
      cwd: "/project",
      input: {
        messageID: "message-1",
      },
      output: {
        message: { id: "message-1", sessionID: "session-2" },
        parts: [
          { type: "text", ignored: true, text: "ignored" },
          { type: "text", text: "First prompt" },
          { type: "file", text: "not prompt text" },
          { type: "text", text: "   " },
          { type: "text", text: "Second prompt" },
        ],
      },
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    hookName: "chat.message",
    sessionId: "session-2",
    messageId: "message-1",
    projectDirectory: "/project",
    userPrompt: "First prompt\nSecond prompt",
  });
});

test("extracts OpenCode assistant text completion metadata", async () => {
  const { parseOpenCodePayload } = await import(payloadUrl);
  const info = parseOpenCodePayload(
    {
      hook: "experimental.text.complete",
      worktree: "/project",
      input: {
        sessionId: "session-3",
        partId: "part-1",
      },
      output: {
        message: { id: "message-2" },
        text: "Assistant response",
      },
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    hookName: "experimental.text.complete",
    sessionId: "session-3",
    messageId: "message-2",
    partId: "part-1",
    projectDirectory: "/project",
    assistantText: "Assistant response",
  });
});

test("extracts OpenCode tool execution fields with completed status by default", async () => {
  const { parseOpenCodePayload } = await import(payloadUrl);
  const toolInput = { command: "npm test" };
  const info = parseOpenCodePayload(
    {
      hook: "tool.execute.after",
      input: {
        sessionID: "session-4",
        tool: "bash",
        callID: "tool-call-1",
        args: toolInput,
      },
      output: {
        title: "Run tests",
        output: "Tests passed",
      },
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    hookName: "tool.execute.after",
    sessionId: "session-4",
    projectDirectory: "/fallback",
    toolName: "bash",
    toolCallId: "tool-call-1",
    toolInput,
    toolTitle: "Run tests",
    toolOutput: "Tests passed",
    toolStatus: "completed",
  });
});
