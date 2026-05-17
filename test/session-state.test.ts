import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createInitialSessionState,
  loadSessionState,
  resolveSessionKey,
  saveSessionState,
  type SessionState,
} from "../src/runtime/session-state.js";

function useRuntimeHome(homeDir: string): void {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
}

test("uses session id as Gemini session key when present", async () => {
  const key = resolveSessionKey({ platform: "gemini", sessionId: "session-1", projectDirectory: "/tmp/project" });

  assert.equal(key, "session-1");
});

test("falls back to cwd-derived Gemini session key when session id is missing", async () => {
  const key = resolveSessionKey({ platform: "gemini", projectDirectory: "/tmp/project" });

  assert.match(key, /^cwd-[a-f0-9]{64}$/);
});

test("initializes reasoning step id map for new session state", async () => {
  const state = createInitialSessionState({
    platform: "gemini",
    sessionId: "session-1",
    projectDirectory: "/tmp/project",
  });

  assert.deepEqual(state.reasoningStepIdsByHash, {});
});

test("persists session state under user-local .nams/state using safe session filenames", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-state-"));
  try {
    useRuntimeHome(homeDir);
    const state: SessionState = {
      harness: "gemini",
      harnessSessionId: "session/1",
      sessionKey: "session/1",
      projectDirectory: projectDir,
      conversationId: "conversation-1",
      createdAt: "2026-05-11T12:00:00.000Z",
      seenAssistantMessageHashes: [],
      seenTranscriptEntryIds: [],
      seenReasoningStepHashes: [],
      seenToolCallIds: [],
      reasoningStepIdsByHash: {},
    };

    await saveSessionState("gemini", "session/1", state);

    const savedPath = path.join(homeDir, ".nams", "state", "gemini", `${sha256("session/1")}.json`);
    assert.deepEqual(JSON.parse(await readFile(savedPath, "utf8")), state);
    assert.deepEqual(await loadSessionState("gemini", "session/1"), state);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("loads legacy lastMemorySearchAt as lastRecallAt", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-state-"));
  try {
    useRuntimeHome(homeDir);
    const statePath = path.join(homeDir, ".nams", "state", "gemini", `${sha256("session-1")}.json`);
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify({
        harness: "gemini",
        sessionKey: "session-1",
        projectDirectory: projectDir,
        createdAt: "2026-05-11T12:00:00.000Z",
        lastMemorySearchAt: "2026-05-11T12:01:00.000Z",
        seenAssistantMessageHashes: [],
        seenTranscriptEntryIds: [],
        seenReasoningStepHashes: [],
        seenToolCallIds: [],
        reasoningStepIdsByHash: {},
      })}\n`,
      "utf8",
    );

    const state = await loadSessionState("gemini", "session-1");

    assert.ok(state);
    assert.equal(state.lastRecallAt, "2026-05-11T12:01:00.000Z");
    assert.equal(Object.hasOwn(state, "lastMemorySearchAt"), false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("persists colliding-looking session keys in separate state files", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-state-"));
  try {
    useRuntimeHome(homeDir);
    const baseState: Omit<SessionState, "harnessSessionId" | "sessionKey" | "conversationId"> = {
      harness: "gemini",
      projectDirectory: projectDir,
      createdAt: "2026-05-11T12:00:00.000Z",
      seenAssistantMessageHashes: [],
      seenTranscriptEntryIds: [],
      seenReasoningStepHashes: [],
      seenToolCallIds: [],
      reasoningStepIdsByHash: {},
    };
    const slashState: SessionState = {
      ...baseState,
      harnessSessionId: "session/1",
      sessionKey: "session/1",
      conversationId: "conversation-slash",
    };
    const underscoreState: SessionState = {
      ...baseState,
      harnessSessionId: "session_1",
      sessionKey: "session_1",
      conversationId: "conversation-underscore",
    };

    await saveSessionState("gemini", "session/1", slashState);
    await saveSessionState("gemini", "session_1", underscoreState);

    const loadedSlashState = await loadSessionState("gemini", "session/1");
    const loadedUnderscoreState = await loadSessionState("gemini", "session_1");
    assert.ok(loadedSlashState);
    assert.ok(loadedUnderscoreState);
    assert.equal(loadedSlashState.conversationId, "conversation-slash");
    assert.equal(loadedUnderscoreState.conversationId, "conversation-underscore");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});
