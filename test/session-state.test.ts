import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { sessionStatePath } from "../src/runtime/paths.js";

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

test("initializes workspace as undefined for new session state", async () => {
  const state = createInitialSessionState({
    platform: "gemini",
    sessionId: "session-1",
    projectDirectory: "/tmp/project",
  });

  assert.equal(state.workspace, undefined);
});

test("persists session state under user-local .nams/state using timestamped session filenames", async () => {
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

    const savedPath = path.join(
      homeDir,
      ".nams",
      "state",
      "gemini",
      `session-2026-05-11T120000.000Z--${sha256("session/1")}.json`,
    );
    assert.deepEqual(JSON.parse(await readFile(savedPath, "utf8")), state);
    assert.equal(await fileMode(savedPath), 0o600);
    assert.deepEqual(await loadSessionState("gemini", "session/1"), state);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("preserves selected workspace state when saving and loading session state", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-state-"));
  try {
    useRuntimeHome(homeDir);
    const state: SessionState = {
      harness: "gemini",
      harnessSessionId: "session-1",
      sessionKey: "session-1",
      projectDirectory: projectDir,
      createdAt: "2026-05-11T12:00:00.000Z",
      workspace: {
        id: "workspace-1",
        source: "runtime-single-workspace",
        selectedAt: "2026-05-11T12:01:00.000Z",
      },
      seenAssistantMessageHashes: [],
      seenTranscriptEntryIds: [],
      seenReasoningStepHashes: [],
      seenToolCallIds: [],
      reasoningStepIdsByHash: {},
    };

    await saveSessionState("gemini", state.sessionKey, state);

    assert.deepEqual(await loadSessionState("gemini", state.sessionKey), state);
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
    const statePath = sessionStatePath("gemini", "session-1", "2026-05-11T12:00:00.000Z");
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

test("loads the newest timestamped state file when duplicate session keys exist", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-state-"));
  try {
    useRuntimeHome(homeDir);
    const oldState: SessionState = {
      harness: "gemini",
      harnessSessionId: "session-1",
      sessionKey: "session-1",
      projectDirectory: projectDir,
      conversationId: "conversation-old",
      createdAt: "2026-05-11T12:00:00.000Z",
      seenAssistantMessageHashes: [],
      seenTranscriptEntryIds: [],
      seenReasoningStepHashes: [],
      seenToolCallIds: [],
      reasoningStepIdsByHash: {},
    };
    const newState: SessionState = {
      ...oldState,
      conversationId: "conversation-new",
      createdAt: "2026-05-11T12:05:00.000Z",
    };

    await saveSessionState("gemini", oldState.sessionKey, oldState);
    await saveSessionState("gemini", newState.sessionKey, newState);

    const loadedState = await loadSessionState("gemini", "session-1");

    assert.ok(loadedState);
    assert.equal(loadedState.conversationId, "conversation-new");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not load legacy hash-only state filenames", async () => {
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
        seenAssistantMessageHashes: [],
        seenTranscriptEntryIds: [],
        seenReasoningStepHashes: [],
        seenToolCallIds: [],
        reasoningStepIdsByHash: {},
      })}\n`,
      "utf8",
    );

    assert.equal(await loadSessionState("gemini", "session-1"), null);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileMode(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
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

test("loadSessionState normalizes missing seen collections from legacy state files", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-session-state-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    const statePath = sessionStatePath("claude", "legacy-session", "2026-01-01T00:00:00.000Z");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        harness: "claude",
        sessionKey: "legacy-session",
        projectDirectory: "/tmp/project",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const state = (await loadSessionState("claude", "legacy-session"))!;

    assert.notEqual(state, null);
    assert.deepEqual(state.seenAssistantMessageHashes, []);
    assert.deepEqual(state.seenTranscriptEntryIds, []);
    assert.deepEqual(state.seenReasoningStepHashes, []);
    assert.deepEqual(state.seenToolCallIds, []);
    assert.deepEqual(state.reasoningStepIdsByHash, {});
  } finally {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousProfile;
    await rm(homeDir, { recursive: true, force: true });
  }
});
