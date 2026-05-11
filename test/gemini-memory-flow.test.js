import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const geminiUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "gemini.js")).href;
const stateUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "session-state.js")).href;

test("initializes Gemini session state on SessionStart without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const { GeminiAdapter } = await import(geminiUrl);
    const { loadSessionState } = await import(stateUrl);
    const adapter = new GeminiAdapter();

    const result = await adapter.startConversation({
      platform: "gemini",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const state = await loadSessionState(projectDir, "gemini", "session-1");
    assert.notEqual(state, null);
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.conversationId, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
