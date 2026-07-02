import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HookInvocation } from "../src/interfaces.js";
import { createNamsMemoryService } from "../src/runtime/memory-service.js";
import {
  ensureConversation,
  loadHookSessionState,
  recallMemoryContextOnce,
  storeUserPromptOnce,
  withHookSessionState,
} from "../src/runtime/memory-turn.js";
import { createInitialSessionState, loadSessionState, type SessionState } from "../src/runtime/session-state.js";
import { createNamsFetchMock, namsBaseUrl } from "./support/nams-fetch-mock.js";
import { readSingleSessionLog } from "./support/runtime-home.js";

const config = { apiKey: "key", workspaceId: "workspace-1", baseUrl: namsBaseUrl };

function invocation(event: "SessionStart" | "BeforeAgent" = "BeforeAgent"): HookInvocation {
  return { platform: "claude", event, rawPayload: {}, processCwd: "/tmp" };
}

function freshState(): SessionState {
  return createInitialSessionState({
    platform: "claude",
    sessionId: "session-1",
    projectDirectory: "/tmp/project",
  });
}

async function withTempHome(run: () => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-memory-turn-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    await run();
  } finally {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousProfile;
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("ensureConversation creates one conversation and reuses it", async () => {
  await withTempHome(async () => {
    const nams = createNamsFetchMock().createConversation();
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);

    const first = await ensureConversation(memory, invocation(), state, "/tmp/project");
    const second = await ensureConversation(memory, invocation(), state, "/tmp/project");

    assert.equal(first, "conversation-1");
    assert.equal(second, "conversation-1");
    assert.equal(state.conversationId, "conversation-1");
    assert.equal(nams.calls().length, 1);
  });
});

test("recallMemoryContextOnce recalls once and returns combined context", async () => {
  await withTempHome(async () => {
    const nams = createNamsFetchMock()
      .context({ observations: [{ content: "User prefers tabs." }] })
      .searchEntities({ entities: [{ name: "Tabs", description: "User prefers tabs." }] });
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);

    const context = await recallMemoryContextOnce(memory, invocation(), state, "conversation-1", "hello");

    assert.ok(context !== undefined);
    assert.match(context, /Relevant memory context:/);
    assert.match(context, /User prefers tabs\./);
    assert.ok(state.lastRecallAt !== undefined);

    const again = await recallMemoryContextOnce(memory, invocation(), state, "conversation-1", "hello");
    assert.equal(again, undefined);
    assert.equal(nams.calls().length, 2);
  });
});

test("recallMemoryContextOnce survives NAMS failures and still marks recall done", async () => {
  await withTempHome(async () => {
    createNamsFetchMock().all({ error: "unavailable" }, 500);
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);

    const context = await recallMemoryContextOnce(memory, invocation(), state, "conversation-1", "hello");

    assert.equal(context, undefined);
    assert.ok(state.lastRecallAt !== undefined);
  });
});

test("storeUserPromptOnce stores each distinct prompt once", async () => {
  await withTempHome(async () => {
    const nams = createNamsFetchMock().message();
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);

    await storeUserPromptOnce(memory, invocation(), state, "conversation-1", "hello");
    await storeUserPromptOnce(memory, invocation(), state, "conversation-1", "hello");

    assert.equal(nams.calls().length, 1);
    assert.deepEqual(nams.requestBody(), { role: "user", content: "hello" });
  });
});

test("loadHookSessionState creates initial state and logs the raw payload", async () => {
  await withTempHome(async () => {
    const hookInvocation: HookInvocation = {
      platform: "claude",
      event: "SessionStart",
      rawPayload: { session_id: "session-1" },
      processCwd: "/tmp",
    };

    const state = await loadHookSessionState(hookInvocation, {
      sessionId: "session-1",
      projectDirectory: "/tmp/project",
    });

    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.projectDirectory, "/tmp/project");
    const { lines } = await readSingleSessionLog(process.env.HOME!, "claude");
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0].payload, { session_id: "session-1" });
  });
});

test("withHookSessionState persists state mutations after the run", async () => {
  await withTempHome(async () => {
    const result = await withHookSessionState(
      invocation("SessionStart"),
      { sessionId: "session-1", projectDirectory: "/tmp/project" },
      async (state) => {
        state.conversationId = "conversation-9";
        return { stdout: { continue: true, suppressOutput: true } };
      },
    );

    assert.deepEqual(result, { stdout: { continue: true, suppressOutput: true } });
    const reloaded = await loadSessionState("claude", "session-1");
    assert.equal(reloaded?.conversationId, "conversation-9");
  });
});

test("withHookSessionState persists state even when the run throws", async () => {
  await withTempHome(async () => {
    await assert.rejects(
      withHookSessionState(
        invocation("BeforeAgent"),
        { sessionId: "session-1", projectDirectory: "/tmp/project" },
        async (state) => {
          state.conversationId = "conversation-9";
          throw new Error("boom");
        },
      ),
      /boom/,
    );

    const reloaded = await loadSessionState("claude", "session-1");
    assert.equal(reloaded?.conversationId, "conversation-9");
  });
});
