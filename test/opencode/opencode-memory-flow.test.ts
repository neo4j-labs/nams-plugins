import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { OpenCodeAdapter } from "../../src/platforms/opencode/index.js";
import { loadSessionState } from "../../src/runtime/session-state.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";
import { readSingleSessionLog as readRuntimeSingleSessionLog } from "../support/runtime-home.js";

type TestEnvOverrides = Record<string, string | undefined>;
type TestPayload = Record<string, unknown>;
interface TestEnv extends TestEnvOverrides {
  HOME: string;
  USERPROFILE: string;
}

function testEnv(projectDir: string, overrides: TestEnvOverrides = {}): TestEnv {
  const env = { HOME: path.join(projectDir, "home"), USERPROFILE: path.join(projectDir, "home"), ...overrides };
  for (const key of ["HOME", "USERPROFILE", "NAMS_API_KEY", "NAMS_BASE_URL"]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  return env;
}

function hookSpecificOutput(result: { stdout: Record<string, unknown> }): Record<string, any> {
  return result.stdout.hookSpecificOutput as Record<string, any>;
}

test("initializes OpenCode session state on session.created without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    testEnv(projectDir);
    const adapter = new OpenCodeAdapter();

    const result = await adapter.startSession({
      platform: "opencode",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: {
        hook: "event",
        directory: projectDir,
        event: {
          type: "session.created",
          properties: {
            info: {
              id: "session-1",
              directory: projectDir,
            },
          },
        },
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const state = (await loadSessionState("opencode", "session-1"))!;
    assert.notEqual(state, null);
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.conversationId, undefined);

    const { lines } = await readSingleSessionLog(projectDir);
    assert.equal(lines[0].kind, "hook.event");
    assert.equal(lines[0].harness, "opencode");
    assert.equal(lines[0].event, "SessionStart");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode chat.message creates conversation, recalls memory, and stores user prompt", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const prompt = "Remember fixture tests.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User prefers fixture-driven tests." }] })
      .searchEntities({ entities: [{ name: "Fixtures", description: "User prefers fixture-driven tests." }] })
      .message();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const adapter = new OpenCodeAdapter();

    const result = await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", prompt),
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBody("createConversation"), {
      metadata: { harness: "opencode", projectDirectory: projectDir },
    });
    assert.deepEqual(nams.requestBody("searchEntities"), {
      query: prompt,
      limit: 5,
    });
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: prompt,
    });

    const state = (await loadSessionState("opencode", "session-1"))!;
    assert.ok(state.pendingMemoryContext);
    assert.match(state.pendingMemoryContext.content, /User prefers fixture-driven tests\./);
    assert.equal(state.pendingMemoryContext.messageId, "user-1");

    const { lines } = await readSingleSessionLog(projectDir);
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

test("OpenCode system transform returns and consumes pending memory context", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User wants concise answers." }] })
      .searchEntities()
      .message();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const adapter = new OpenCodeAdapter();

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Hello."),
    });

    const first = await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: systemTransformPayload(projectDir, "session-1"),
    });
    assert.equal(first.stdout.continue, true);
    assert.equal(first.stdout.suppressOutput, true);
    assert.equal(hookSpecificOutput(first).hookEventName, "BeforeAgent");
    assert.match(hookSpecificOutput(first).additionalContext, /User wants concise answers\./);

    const second = await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: systemTransformPayload(projectDir, "session-1"),
    });
    assert.deepEqual(second.stdout, { continue: true, suppressOutput: true });

    const { lines } = await readSingleSessionLog(projectDir);
    assert.ok(
      lines.some(
        (line) =>
          line.kind === "hook.event" &&
          line.event === "BeforeAgent" &&
          line.payload.hook === "experimental.chat.system.transform",
      ),
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode BeforeAgent continues when NAMS_API_KEY is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    testEnv(projectDir);
    const adapter = new OpenCodeAdapter();

    const result = await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Hello"),
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const { log, lines } = await readSingleSessionLog(projectDir);
    assert.match(log, /NAMS apiKey missing/);
    const diagnostics = lines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS apiKey missing",
    );
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0].payload.configSources, {
      apiKey: "missing",
      baseUrl: "default",
    });
    assert.doesNotMatch(log, /Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode BeforeAgent logs invalid config diagnostics without raw JSON contents", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await writeFile(path.join(projectDir, ".nams", "config.json"), '{"apiKey":"secret-config-value"', "utf8");
    testEnv(projectDir);
    const adapter = new OpenCodeAdapter();

    const result = await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Hello"),
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const { log, lines } = await readSingleSessionLog(projectDir);
    const diagnostics = lines.filter((entry) => entry.kind === "diagnostic");
    assert.deepEqual(diagnostics.map((entry) => entry.payload), [
      {
        message: "NAMS config invalid",
        configSources: {
          apiKey: "missing",
          baseUrl: "default",
        },
        errorSource: "project:.nams/config.json",
      },
    ]);
    assert.doesNotMatch(log, /secret-config-value/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode BeforeAgent continues when NAMS request fails", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    createNamsFetchMock().all({ error: "service unavailable" }, 503);
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new OpenCodeAdapter();

    const result = await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Hello"),
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /NAMS request failed/);
    assert.doesNotMatch(log, /Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode NAMS failure diagnostics do not include arbitrary error text", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    createNamsFetchMock()
        .throws(new Error('Authorization: Bearer secret NAMS_API_KEY {"prompt":"do not log me"}'))
        ;
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new OpenCodeAdapter();

    const result = await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Hello"),
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /NAMS request failed/);
    assert.doesNotMatch(log, /Authorization|Bearer|do not log me/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Duplicate OpenCode chat.message does not store user prompt twice", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const adapter = new OpenCodeAdapter();
    const invocation = {
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Remember this once."),
    } as const;

    await adapter.beforeAgent(invocation);
    await adapter.beforeAgent(invocation);

    assert.equal(nams.calls("addMessage").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode chat.message stores same content for distinct message ids", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const prompt = "Same content can be a new user turn.";
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const adapter = new OpenCodeAdapter();

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", prompt),
    });
    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-2", prompt),
    });

    assert.equal(nams.calls("addMessage").length, 2);
    assert.deepEqual(nams.requestBodies("addMessage"), [
      { role: "user", content: prompt },
      { role: "user", content: prompt },
    ]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode chat.message stores repeated template-shaped input for distinct message ids", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const prompt = "Same template-shaped user prompt.";
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const adapter = new OpenCodeAdapter();

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessageTemplatePayload(projectDir, "session-1", "user-1", prompt),
    });
    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessageTemplatePayload(projectDir, "session-1", "user-2", prompt),
    });

    assert.equal(nams.calls("addMessage").length, 2);
    assert.deepEqual(nams.requestBodies("addMessage"), [
      { role: "user", content: prompt },
      { role: "user", content: prompt },
    ]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode experimental.text.complete stores assistant text", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const adapter = new OpenCodeAdapter();

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Say hello."),
    });

    const result = await adapter.afterAgent({
      platform: "opencode",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook: "experimental.text.complete",
        directory: projectDir,
        input: { sessionID: "session-1", messageID: "assistant-1", partID: "part-1" },
        output: { text: "Hello!" },
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBodies("addMessage").at(-1), {
      role: "assistant",
      content: "Hello!",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode AfterAgent ignores non text-complete output text", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const adapter = new OpenCodeAdapter();

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Say hello."),
    });

    const result = await adapter.afterAgent({
      platform: "opencode",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook: "custom.assistant.surface",
        directory: projectDir,
        input: { sessionID: "session-1", messageID: "assistant-1", partID: "part-1" },
        output: { text: "Not an assistant completion." },
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBodies("addMessage"), [{ role: "user", content: "Say hello." }]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Duplicate OpenCode experimental.text.complete does not store assistant text twice", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const adapter = new OpenCodeAdapter();

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Say hello."),
    });
    const invocation = {
      platform: "opencode",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook: "experimental.text.complete",
        directory: projectDir,
        input: { sessionID: "session-1", messageID: "assistant-1", partID: "part-1" },
        output: { text: "Hello!" },
      },
    } as const;

    await adapter.afterAgent(invocation);
    await adapter.afterAgent(invocation);

    assert.deepEqual(
      nams.requestBodies("addMessage").filter((body) => body.role === "assistant"),
      [{ role: "assistant", content: "Hello!" }],
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode tool.execute.after records sanitized tool metadata", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-1" })
      .toolCall();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const adapter = new OpenCodeAdapter();

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Run tests."),
    });

    const result = await adapter.afterTool({
      platform: "opencode",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook: "tool.execute.after",
        directory: projectDir,
        input: {
          sessionID: "session-1",
          callID: "call-1",
          tool: "bash",
          args: { command: "npm test", output: "must be sanitized", keep: "metadata" },
        },
        output: { title: "npm test", output: "69 tests pass", metadata: { exit: 0 } },
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBody("addReasoningStep"), {
      conversationId: "conversation-1",
      reasoning: "OpenCode invoked bash with the provided tool input.",
      actionTaken: "Ran bash",
      result: "npm test",
    });

    const toolBodies = nams.requestBodies("addToolCall");
    assert.equal(toolBodies.length, 1);
    assert.equal(toolBodies[0].toolName, "bash");
    assert.equal(toolBodies[0].stepId, "step-1");
    assert.equal(toolBodies[0].status, "completed");
    assert.equal(toolBodies[0].output, "69 tests pass");
    assert.match(toolBodies[0].input, /"command":"npm test"/);
    assert.match(toolBodies[0].input, /"keep":"metadata"/);
    assert.doesNotMatch(toolBodies[0].input, /"output"|must be sanitized/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Duplicate OpenCode tool.execute.after does not store tool metadata twice", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-1" })
      .toolCall();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const adapter = new OpenCodeAdapter();

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Run tests."),
    });

    const invocation = {
      platform: "opencode",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook: "tool.execute.after",
        directory: projectDir,
        input: { sessionID: "session-1", callID: "call-1", tool: "bash", args: { command: "npm test" } },
        output: { title: "npm test", output: "69 tests pass" },
      },
    } as const;

    await adapter.afterTool(invocation);
    await adapter.afterTool(invocation);

    assert.equal(nams.calls("addToolCall").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode tool.execute.after fallback dedupe uses sanitized input", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-1" })
      .toolCall();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const adapter = new OpenCodeAdapter();

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Run tests."),
    });

    await adapter.afterTool({
      platform: "opencode",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook: "tool.execute.after",
        directory: projectDir,
        input: {
          sessionID: "session-1",
          tool: "bash",
          args: { command: "npm test", output: "first output", result: "first result", response: "first response" },
        },
        output: { title: "npm test", output: "69 tests pass" },
      },
    });
    await adapter.afterTool({
      platform: "opencode",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook: "tool.execute.after",
        directory: projectDir,
        input: {
          sessionID: "session-1",
          tool: "bash",
          args: { command: "npm test", output: "second output", result: "second result", response: "second response" },
        },
        output: { title: "npm test", output: "69 tests pass" },
      },
    });

    assert.equal(nams.calls("addToolCall").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("OpenCode assistant part dedupe does not collide on raw delimiters", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const adapter = new OpenCodeAdapter();

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Say hello."),
    });

    await adapter.afterAgent({
      platform: "opencode",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook: "experimental.text.complete",
        directory: projectDir,
        input: { sessionID: "session-1", messageID: "assistant-1:a", partID: "b" },
        output: { text: "First assistant part." },
      },
    });
    await adapter.afterAgent({
      platform: "opencode",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook: "experimental.text.complete",
        directory: projectDir,
        input: { sessionID: "session-1", messageID: "assistant-1", partID: "a:b" },
        output: { text: "Second assistant part." },
      },
    });

    assert.deepEqual(
      nams.requestBodies("addMessage").filter((body) => body.role === "assistant"),
      [
        { role: "assistant", content: "First assistant part." },
        { role: "assistant", content: "Second assistant part." },
      ],
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

async function readSingleSessionLog(projectDir: string): Promise<{ log: string; lines: Array<Record<string, any>> }> {
  const { logPath, lines } = await readRuntimeSingleSessionLog(testEnv(projectDir).HOME, "opencode");
  const log = await readFile(logPath, "utf8");
  return {
    log,
    lines,
  };
}

function chatMessagePayload(projectDir: string, sessionID: string, messageID: string, text: string): TestPayload {
  return {
    hook: "chat.message",
    directory: projectDir,
    input: { sessionID, messageID },
    output: {
      message: { id: messageID, sessionID, role: "user" },
      parts: [{ id: "part-1", sessionID, messageID, type: "text", text }],
    },
  };
}

function chatMessageTemplatePayload(
  projectDir: string,
  sessionID: string,
  messageID: string,
  text: string,
): TestPayload {
  return {
    hook: "chat.message",
    directory: projectDir,
    input: {
      sessionID,
      message: {
        id: messageID,
        sessionID,
        role: "user",
        parts: [{ id: "part-1", sessionID, messageID, type: "text", text }],
      },
    },
    output: {},
  };
}

function systemTransformPayload(projectDir: string, sessionID: string): TestPayload {
  return {
    hook: "experimental.chat.system.transform",
    directory: projectDir,
    input: { sessionID },
    output: { system: [] },
  };
}
