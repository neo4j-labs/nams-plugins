import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const payloadUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "gemini-payload.js")).href;

test("extracts Gemini prompt and response fields from hook payload", async () => {
  const { parseGeminiPayload } = await import(payloadUrl);
  const info = parseGeminiPayload(
    {
      session_id: "session-1",
      cwd: "/project",
      transcript_path: "/tmp/transcript.jsonl",
      prompt: "Say hello",
      prompt_response: "Hello!",
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    sessionId: "session-1",
    projectDirectory: "/project",
    transcriptPath: "/tmp/transcript.jsonl",
    prompt: "Say hello",
    promptResponse: "Hello!",
  });
});

test("falls back to process cwd when Gemini cwd is absent", async () => {
  const { parseGeminiPayload } = await import(payloadUrl);
  const info = parseGeminiPayload({ session_id: "session-1" }, "/fallback");

  assert.equal(info.projectDirectory, "/fallback");
});

test("accepts camelCase aliases and ignores blank values", async () => {
  const { parseGeminiPayload } = await import(payloadUrl);
  const info = parseGeminiPayload(
    {
      session_id: " ",
      sessionId: "session-2",
      cwd: "",
      GEMINI_PROJECT_DIR: "/project-alias",
      transcriptPath: "/tmp/alias.jsonl",
      userPrompt: "Alias prompt",
      promptResponse: "Alias response",
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    sessionId: "session-2",
    projectDirectory: "/project-alias",
    transcriptPath: "/tmp/alias.jsonl",
    prompt: "Alias prompt",
    promptResponse: "Alias response",
  });
});
