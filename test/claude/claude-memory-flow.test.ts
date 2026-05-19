import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ClaudeAdapter } from "../../src/platforms/claude/index.js";
import { sha256 } from "../../src/runtime/hashing.js";
import { loadSessionState } from "../../src/runtime/session-state.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";
import { namsHome, readSingleSessionLog } from "../support/runtime-home.js";

type TestEnvOverrides = Record<string, string | undefined>;
interface TestEnv extends TestEnvOverrides {
  HOME: string;
  USERPROFILE: string;
}

function testEnv(projectDir: string, overrides: TestEnvOverrides = {}): TestEnv {
  const homeDir = path.join(projectDir, "home");
  const env = { HOME: homeDir, USERPROFILE: homeDir, ...overrides };
  for (const key of ["HOME", "USERPROFILE", "NAMS_API_KEY", "NAMS_BASE_URL"]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  return env;
}

test("initializes Claude session state on SessionStart without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock().all({ error: "unexpected NAMS call" }, 500);
    const env = testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();
    const payload = {
      session_id: "session-1",
      cwd: projectDir,
      transcript_path: path.join(projectDir, "transcript.jsonl"),
    };

    const result = await adapter.startSession({
      platform: "claude",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: payload,
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const state = (await loadSessionState("claude", "session-1"))!;
    assert.notEqual(state, null);
    assert.equal(state.harness, "claude");
    assert.equal(state.harnessSessionId, "session-1");
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.projectDirectory, projectDir);
    assert.equal(state.conversationId, undefined);
    assert.equal(nams.calls().length, 0);

    const statePath = path.join(namsHome(env.HOME), "state", "claude", `${sha256("session-1")}.json`);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);

    const { lines } = await readSingleSessionLog(env.HOME, "claude");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].harness, "claude");
    assert.equal(lines[0].event, "SessionStart");
    assert.equal(lines[0].kind, "hook.event");
    assert.deepEqual(lines[0].payload, payload);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
