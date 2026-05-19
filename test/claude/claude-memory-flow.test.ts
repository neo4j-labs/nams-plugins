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

function hookSpecificOutput(result: { stdout: Record<string, unknown> }): Record<string, any> {
  return result.stdout.hookSpecificOutput as Record<string, any>;
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

test("creates Claude conversation, recalls memory, injects additionalContext, and stores UserPromptSubmit prompt", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const prompt = "Please remember that I prefer fixture-driven tests.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User prefers fixture-driven tests." }] })
      .searchEntities({
        entities: [{ name: "Fixture-driven tests", description: "User prefers fixture-driven tests." }],
      })
      .message();
    const env = testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, true);
    assert.equal(Object.hasOwn(result.stdout, "additionalContext"), false);
    assert.equal(hookSpecificOutput(result).hookEventName, "UserPromptSubmit");
    assert.match(hookSpecificOutput(result).additionalContext, /User prefers fixture-driven tests\./);
    assert.match(hookSpecificOutput(result).additionalContext, /Fixture-driven tests: User prefers fixture-driven tests\./);
    assert.deepEqual(nams.requestBody("createConversation"), {
      metadata: {
        harness: "claude",
        projectDirectory: projectDir,
      },
    });
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: prompt,
    });

    const { lines } = await readSingleSessionLog(env.HOME, "claude");
    assert.equal(lines[0].kind, "hook.event");
    const configDiagnostics = lines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS config loaded",
    );
    assert.equal(configDiagnostics.length, 1);
    assert.deepEqual(configDiagnostics[0].payload.configSources, {
      apiKey: "env:NAMS_API_KEY",
      baseUrl: "env:NAMS_BASE_URL",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not store duplicate Claude UserPromptSubmit prompt twice through BeforeAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const prompt = "Remember this only once.";
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();
    const invocation = {
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    } as const;

    await adapter.beforeAgent(invocation);
    await adapter.beforeAgent(invocation);

    assert.equal(nams.calls("addMessage").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("continues when Claude NAMS apiKey is missing and logs sanitized config diagnostic", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const env = testEnv(projectDir);
    const adapter = new ClaudeAdapter();

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Hello",
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const { lines } = await readSingleSessionLog(env.HOME, "claude");
    const log = JSON.stringify(lines);
    const diagnostics = lines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS apiKey missing",
    );
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0].payload.configSources, {
      apiKey: "missing",
      baseUrl: "default",
    });
    assert.doesNotMatch(log, /Authorization|Bearer|secret|NAMS_API_KEY/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Claude BeforeAgent uses entity search context when conversation recall fails and still stores prompt", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const prompt = "Persist this even if conversation recall is unavailable.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ error: "context unavailable" }, 503)
      .searchEntities({
        entities: [{ name: "Autonomo", description: "User is exploring autonomo setup in Spain." }],
      })
      .message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, true);
    assert.equal(Object.hasOwn(result.stdout, "additionalContext"), false);
    assert.equal(hookSpecificOutput(result).hookEventName, "UserPromptSubmit");
    assert.match(hookSpecificOutput(result).additionalContext, /Autonomo: User is exploring autonomo setup in Spain\./);
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: prompt,
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
