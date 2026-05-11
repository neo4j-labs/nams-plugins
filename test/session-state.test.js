import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "session-state.js")).href;

test("uses session id as Gemini session key when present", async () => {
  const { resolveSessionKey } = await import(stateUrl);
  const key = resolveSessionKey({ platform: "gemini", sessionId: "session-1", projectDirectory: "/tmp/project" });

  assert.equal(key, "session-1");
});

test("falls back to cwd-derived Gemini session key when session id is missing", async () => {
  const { resolveSessionKey } = await import(stateUrl);
  const key = resolveSessionKey({ platform: "gemini", projectDirectory: "/tmp/project" });

  assert.match(key, /^cwd-[a-f0-9]{64}$/);
});

test("persists session state under .nams/state/sessions using safe session filenames", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-state-"));
  try {
    const { loadSessionState, saveSessionState } = await import(stateUrl);
    const state = {
      harness: "gemini",
      harnessSessionId: "session/1",
      sessionKey: "session/1",
      projectDirectory: projectDir,
      conversationId: "conversation-1",
      createdAt: "2026-05-11T12:00:00.000Z",
      seenTranscriptEntryIds: [],
      seenReasoningStepHashes: [],
      seenToolCallIds: [],
    };

    await saveSessionState(projectDir, "gemini", "session/1", state);

    const savedPath = path.join(projectDir, ".nams", "state", "sessions", "gemini", `${sha256("session/1")}.json`);
    assert.deepEqual(JSON.parse(await readFile(savedPath, "utf8")), state);
    assert.deepEqual(await loadSessionState(projectDir, "gemini", "session/1"), state);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("persists colliding-looking session keys in separate state files", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-state-"));
  try {
    const { loadSessionState, saveSessionState } = await import(stateUrl);
    const baseState = {
      harness: "gemini",
      projectDirectory: projectDir,
      createdAt: "2026-05-11T12:00:00.000Z",
      seenTranscriptEntryIds: [],
      seenReasoningStepHashes: [],
      seenToolCallIds: [],
    };
    const slashState = {
      ...baseState,
      harnessSessionId: "session/1",
      sessionKey: "session/1",
      conversationId: "conversation-slash",
    };
    const underscoreState = {
      ...baseState,
      harnessSessionId: "session_1",
      sessionKey: "session_1",
      conversationId: "conversation-underscore",
    };

    await saveSessionState(projectDir, "gemini", "session/1", slashState);
    await saveSessionState(projectDir, "gemini", "session_1", underscoreState);

    assert.equal((await loadSessionState(projectDir, "gemini", "session/1")).conversationId, "conversation-slash");
    assert.equal((await loadSessionState(projectDir, "gemini", "session_1")).conversationId, "conversation-underscore");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
