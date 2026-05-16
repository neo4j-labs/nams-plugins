import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";
import { namsHome, readSingleSessionLog as readRuntimeSingleSessionLog } from "../support/runtime-home.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const codexUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "codex", "index.js")).href;
const stateUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "session-state.js")).href;

function testEnv(projectDir, overrides = {}) {
  const env = { HOME: path.join(projectDir, "home"), USERPROFILE: path.join(projectDir, "home"), ...overrides };
  for (const key of ["HOME", "USERPROFILE", "NAMS_API_KEY", "NAMS_BASE_URL"]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  return env;
}

function testAdapterOptions(projectDir, overrides = {}) {
  testEnv(projectDir, overrides);
  return {};
}

test("initializes Codex session state on SessionStart without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const { CodexAdapter } = await import(codexUrl);
    const { loadSessionState } = await import(stateUrl);
    const adapter = new CodexAdapter({ ...testAdapterOptions(projectDir) });

    const result = await adapter.startConversation({
      platform: "codex",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const state = await loadSessionState("codex", "session-1");
    assert.notEqual(state, null);
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.conversationId, undefined);

    const logFileNames = await readdir(path.join(namsHome(testEnv(projectDir).HOME), "logs", "codex"));
    assert.equal(logFileNames.filter((fileName) => fileName.startsWith("session-")).length, 1);
    assert.equal(logFileNames.includes("codex-session-start.jsonl"), false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex beforeAgent with no prompt saves state, logs raw event, and does not call NAMS", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock().all({ error: "unexpected NAMS call" }, 500);
    const { CodexAdapter } = await import(codexUrl);
    const { loadSessionState } = await import(stateUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    const result = await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const state = await loadSessionState("codex", "session-1");
    assert.notEqual(state, null);
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.conversationId, undefined);
    assert.equal(nams.calls().length, 0);

    const { lines } = await readSingleSessionLog(projectDir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, "hook.event");
    assert.equal(lines[0].event, "BeforeAgent");
    assert.deepEqual(lines[0].payload, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      cwd: projectDir,
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("creates Codex conversation, recalls memory, returns context, and stores UserPromptSubmit prompt", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const prompt = "Please remember that I prefer fixture-driven tests.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User prefers fixture-driven tests." }] })
      .searchEntities({
        entities: [{ name: "Fixture-driven tests", description: "User prefers fixture-driven tests." }],
      })
      .message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    const result = await adapter.beforeAgent({
      platform: "codex",
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
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /User prefers fixture-driven tests\./);
    assert.equal(result.stdout.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.deepEqual(nams.requestBody("createConversation"), {
      metadata: {
        harness: "codex",
        projectDirectory: projectDir,
      },
    });
    assert.deepEqual(nams.requestBody("searchEntities"), {
      query: prompt,
      limit: 5,
    });
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: prompt,
    });

    const { lines } = await readSingleSessionLog(projectDir);
    assert.equal(lines[0].kind, "hook.event");
    const configDiagnostics = lines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS config loaded",
    );
    assert.equal(configDiagnostics.length, 1);
    assert.deepEqual(configDiagnostics[0].payload.configSources, {
      apiKey: "env:NAMS_API_KEY",
      baseUrl: "env:NAMS_BASE_URL",
    });
    const requestEntries = lines.filter((entry) => entry.kind === "nams.request");
    assert.deepEqual(
      requestEntries.map((entry) => entry.payload.operation),
      ["createConversation", "getConversationContext", "searchEntities", "addMessage"],
    );
    assert.deepEqual(
      requestEntries.map((entry) => ({
        method: entry.payload.method,
        path: entry.payload.path,
        status: entry.payload.status,
        ok: entry.payload.ok,
      })),
      [
        { method: "POST", path: "/v1/conversations", status: 201, ok: true },
        { method: "GET", path: "/v1/conversations/{id}/context", status: 200, ok: true },
        { method: "POST", path: "/v1/entities/search", status: 200, ok: true },
        { method: "POST", path: "/v1/conversations/{id}/messages", status: 201, ok: true },
      ],
    );
    for (const entry of requestEntries) {
      assert.equal(typeof entry.payload.durationMs, "number");
    }
    assert.match(JSON.stringify(requestEntries), /fixture-driven tests/);
    assert.doesNotMatch(JSON.stringify(requestEntries), /Authorization|Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("duplicate Codex beforeAgent prompt stores one user message", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const prompt = "Remember this only once.";
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });
    const invocation = {
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    };

    await adapter.beforeAgent(invocation);
    await adapter.beforeAgent(invocation);

    assert.equal(nams.calls("addMessage").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("missing Codex NAMS_API_KEY returns allow output and minimal diagnostic log", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({ ...testAdapterOptions(projectDir) });

    const result = await adapter.beforeAgent({
      platform: "codex",
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

test("Codex beforeAgent logs invalid config diagnostics without raw JSON contents", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await writeFile(path.join(projectDir, ".nams", "config.json"), '{"apiKey":"secret-config-value"', "utf8");
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({ ...testAdapterOptions(projectDir) });

    const result = await adapter.beforeAgent({
      platform: "codex",
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

test("Codex recall failure still stores prompt and can return entity search context", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const prompt = "Persist this even if conversation recall is unavailable.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ error: "context unavailable" }, 503)
      .searchEntities({
        entities: [{ name: "Autonomo", description: "User is exploring autonomo setup in Spain." }],
      })
      .message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    const result = await adapter.beforeAgent({
      platform: "codex",
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
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Autonomo: User is exploring autonomo setup in Spain\./);
    assert.equal(result.stdout.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: prompt,
    });
    const { lines, log } = await readSingleSessionLog(projectDir);
    assert.match(log, /NAMS request failed/);
    const diagnostics = lines.filter((entry) => entry.kind === "diagnostic");
    const failureDiagnostics = diagnostics.filter((entry) => entry.payload.message === "NAMS request failed");
    assert.deepEqual(failureDiagnostics.map((entry) => entry.payload), [{ message: "NAMS request failed" }]);
    assert.doesNotMatch(JSON.stringify(failureDiagnostics), /context unavailable|Authorization|Bearer|key/);
    assert.doesNotMatch(log, /Authorization|Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex entity search failure still stores prompt and can return conversation recall context", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const prompt = "Persist this even if entity search is unavailable.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User wants conversation recall to survive partial failures." }] })
      .searchEntities({ error: "entity search unavailable" }, 503)
      .message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    const result = await adapter.beforeAgent({
      platform: "codex",
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
    assert.match(
      result.stdout.hookSpecificOutput.additionalContext,
      /User wants conversation recall to survive partial failures\./,
    );
    assert.equal(result.stdout.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: prompt,
    });
    const { lines, log } = await readSingleSessionLog(projectDir);
    assert.match(log, /NAMS request failed/);
    const diagnostics = lines.filter((entry) => entry.kind === "diagnostic");
    const failureDiagnostics = diagnostics.filter((entry) => entry.payload.message === "NAMS request failed");
    assert.deepEqual(failureDiagnostics.map((entry) => entry.payload), [{ message: "NAMS request failed" }]);
    assert.doesNotMatch(JSON.stringify(failureDiagnostics), /entity search unavailable|Authorization|Bearer|key/);
    assert.doesNotMatch(log, /Authorization|Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex message failure returns recalled additional context and fails open", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User wants concise updates." }] })
      .searchEntities()
      .message({ error: "message write unavailable" }, 503);
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    const result = await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Hello",
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, true);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /User wants concise updates\./);
    assert.equal(result.stdout.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(nams.calls("addMessage").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("stores Codex Stop last_assistant_message as an assistant message", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Say hello.",
      },
    });

    const result = await adapter.afterAgent({
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: projectDir,
        last_assistant_message: "Hello!",
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

test("stores Codex transcript assistant message when last_assistant_message is absent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "codex-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "response_item",
          item: {
            id: "assistant-1",
            type: "message",
            role: "assistant",
            content: [{ text: "Transcript fallback response." }],
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Use transcript fallback.",
      },
    });

    const result = await adapter.afterAgent({
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBodies("addMessage").at(-1), {
      role: "assistant",
      content: "Transcript fallback response.",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("repeated Codex Stop last_assistant_message with same turn_id stores once", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Create a conversation.",
      },
    });

    const invocation = {
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: projectDir,
        last_assistant_message: "Store this once.",
      },
    };

    await adapter.afterAgent(invocation);
    await adapter.afterAgent(invocation);

    const assistantMessages = nams.requestBodies("addMessage").filter((body) => body.role === "assistant");
    assert.deepEqual(assistantMessages, [{ role: "assistant", content: "Store this once." }]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex Stop last_assistant_message with same content and different turn_id stores twice", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Create a conversation.",
      },
    });

    const firstInvocation = {
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: projectDir,
        last_assistant_message: "Done.",
      },
    };
    const secondInvocation = {
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        turn_id: "turn-2",
        cwd: projectDir,
        last_assistant_message: "Done.",
      },
    };

    await adapter.afterAgent(firstInvocation);
    await adapter.afterAgent(secondInvocation);

    const assistantMessages = nams.requestBodies("addMessage").filter((body) => body.role === "assistant");
    assert.deepEqual(assistantMessages, [
      { role: "assistant", content: "Done." },
      { role: "assistant", content: "Done." },
    ]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex transcript fallback does not duplicate an entry id", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "codex-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "response_item",
          item: { id: "assistant-1", type: "message", role: "assistant", content: "Only once." },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Create a conversation.",
      },
    });

    const invocation = {
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    };

    await adapter.afterAgent(invocation);
    await adapter.afterAgent(invocation);

    const assistantMessages = nams.requestBodies("addMessage").filter((body) => body.role === "assistant");
    assert.deepEqual(assistantMessages, [{ role: "assistant", content: "Only once." }]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex transcript fallback dedupes same assistant content when id changes", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "codex-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "response_item",
          item: { id: "assistant-1", type: "message", role: "assistant", content: "Same content." },
        }),
        JSON.stringify({
          type: "response_item",
          item: { id: "assistant-2", type: "message", role: "assistant", content: "Same content." },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Create a conversation.",
      },
    });

    await adapter.afterAgent({
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    const assistantMessages = nams.requestBodies("addMessage").filter((body) => body.role === "assistant");
    assert.deepEqual(assistantMessages, [{ role: "assistant", content: "Same content." }]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex transcript fallback does not duplicate a direct assistant response", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "codex-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "response_item",
          item: { id: "assistant-from-transcript", type: "message", role: "assistant", content: "Already stored." },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Create a conversation.",
      },
    });

    await adapter.afterAgent({
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: projectDir,
        last_assistant_message: "Already stored.",
      },
    });
    await adapter.afterAgent({
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    const assistantMessages = nams.requestBodies("addMessage").filter((body) => body.role === "assistant");
    assert.deepEqual(assistantMessages, [{ role: "assistant", content: "Already stored." }]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex transcript fallback without entry id still dedupes by assistant content", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "codex-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "response_item",
          item: { type: "message", role: "assistant", content: "No id content." },
        }),
        JSON.stringify({
          type: "response_item",
          item: { type: "message", role: "assistant", content: "No id content." },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Create a conversation.",
      },
    });

    await adapter.afterAgent({
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    const assistantMessages = nams.requestBodies("addMessage").filter((body) => body.role === "assistant");
    assert.deepEqual(assistantMessages, [{ role: "assistant", content: "No id content." }]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("records Codex transcript web search calls during AfterAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "codex-transcript.jsonl");
    const action = {
      type: "search",
      query: "Spain register as self-employed autonomo official",
      queries: ["Spain register as self-employed autonomo official"],
    };
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: "2026-05-14T17:34:59.108Z",
          type: "response_item",
          payload: {
            type: "web_search_call",
            status: "completed",
            action,
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T17:34:59.106Z",
          type: "event_msg",
          payload: {
            type: "web_search_end",
            call_id: "ws_1",
            query: action.query,
            action,
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock().message().reasoningStep({ id: "step-1" }).toolCall();
    const { CodexAdapter } = await import(codexUrl);
    await seedCodexConversation(projectDir);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    const invocation = {
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: projectDir,
        last_assistant_message: "Final answer.",
        transcript_path: transcriptPath,
      },
    };
    const result = await adapter.afterAgent(invocation);
    await adapter.afterAgent(invocation);

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBodies("addMessage"), [{ role: "assistant", content: "Final answer." }]);
    assert.deepEqual(nams.requestBody("addReasoningStep"), {
      conversationId: "conversation-1",
      reasoning: "Codex exposed web_search from the session transcript.",
      actionTaken: "Ran web_search",
      result: "Codex transcript recorded status: completed.",
    });
    assert.deepEqual(nams.requestBody("addToolCall"), {
      stepId: "step-1",
      toolName: "web_search",
      input: JSON.stringify(action),
      output: "",
      status: "completed",
    });
    assert.equal(nams.calls("addReasoningStep").length, 1);
    assert.equal(nams.calls("addToolCall").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex afterAgent with no conversationId returns allow output and does not call NAMS", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock().all({ error: "unexpected NAMS call" }, 500);
    const { CodexAdapter } = await import(codexUrl);
    const { loadSessionState } = await import(stateUrl);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    const result = await adapter.afterAgent({
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: projectDir,
        last_assistant_message: "No conversation yet.",
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.equal(nams.calls().length, 0);
    const state = await loadSessionState("codex", "session-1");
    assert.notEqual(state, null);
    assert.equal(state.conversationId, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex afterAgent missing config and failed NAMS calls allow and log minimal diagnostics", async () => {
  const missingConfigDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  const namsFailureDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const { CodexAdapter } = await import(codexUrl);
    const { createInitialSessionState, saveSessionState } = await import(stateUrl);

    const missingConfigState = createInitialSessionState({
      platform: "codex",
      sessionId: "session-1",
      projectDirectory: missingConfigDir,
    });
    missingConfigState.conversationId = "conversation-1";
    testEnv(missingConfigDir);
    await saveSessionState("codex", missingConfigState.sessionKey, missingConfigState);

    testEnv(missingConfigDir);
    const missingConfigResult = await new CodexAdapter().afterAgent({
      platform: "codex",
      event: "AfterAgent",
      processCwd: missingConfigDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: missingConfigDir,
        last_assistant_message: "Config is missing.",
      },
    });

    assert.deepEqual(missingConfigResult.stdout, { continue: true, suppressOutput: true });
    const { log: missingConfigLog, lines: missingConfigLines } = await readSingleSessionLog(missingConfigDir);
    assert.match(missingConfigLog, /NAMS apiKey missing/);
    const missingConfigDiagnostics = missingConfigLines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS apiKey missing",
    );
    assert.equal(missingConfigDiagnostics.length, 1);
    assert.deepEqual(missingConfigDiagnostics[0].payload.configSources, {
      apiKey: "missing",
      baseUrl: "default",
    });
    assert.doesNotMatch(missingConfigLog, /Authorization|Bearer|key/);

    const namsFailureState = createInitialSessionState({
      platform: "codex",
      sessionId: "session-1",
      projectDirectory: namsFailureDir,
    });
    namsFailureState.conversationId = "conversation-1";
    testEnv(namsFailureDir);
    await saveSessionState("codex", namsFailureState.sessionKey, namsFailureState);

    const nams = createNamsFetchMock().message({ error: "assistant write unavailable" }, 503);
    testEnv(namsFailureDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const namsFailureResult = await new CodexAdapter({
      fetch: nams.fetch,
    }).afterAgent({
      platform: "codex",
      event: "AfterAgent",
      processCwd: namsFailureDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: namsFailureDir,
        last_assistant_message: "NAMS is unavailable.",
      },
    });

    assert.deepEqual(namsFailureResult.stdout, { continue: true, suppressOutput: true });
    const { lines: namsFailureLines, log: namsFailureLog } = await readSingleSessionLog(namsFailureDir);
    assert.match(namsFailureLog, /NAMS request failed/);
    const diagnostics = namsFailureLines.filter((entry) => entry.kind === "diagnostic");
    const failureDiagnostics = diagnostics.filter((entry) => entry.payload.message === "NAMS request failed");
    assert.deepEqual(failureDiagnostics.map((entry) => entry.payload), [{ message: "NAMS request failed" }]);
    assert.doesNotMatch(JSON.stringify(failureDiagnostics), /assistant write unavailable|Authorization|Bearer|key/);
    assert.doesNotMatch(namsFailureLog, /Authorization|Bearer|key/);
  } finally {
    await rm(missingConfigDir, { recursive: true, force: true });
    await rm(namsFailureDir, { recursive: true, force: true });
  }
});

test("records Codex PostToolUse as reasoning step and tool call", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock().reasoningStep({ id: "step-1" }).toolCall();
    const { CodexAdapter } = await import(codexUrl);
    await seedCodexConversation(projectDir);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "test-api-key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    const result = await adapter.afterTool({
      platform: "codex",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: projectDir,
        tool_name: "shell",
        tool_use_id: "tool-use-1",
        tool_input: { command: "pwd" },
        tool_response: "printed working directory",
      },
    });

    assert.deepEqual(result.stdout, { continue: true });
    assert.equal(Object.hasOwn(result.stdout, "suppressOutput"), false);
    assert.deepEqual(nams.requestBody("addReasoningStep"), {
      conversationId: "conversation-1",
      reasoning: "Codex ran shell for the current turn.",
      actionTaken: "Ran shell",
      result: "Codex exposed post-tool output.",
    });
    assert.deepEqual(nams.requestBody("addToolCall"), {
      stepId: "step-1",
      toolName: "shell",
      input: JSON.stringify({ command: "pwd" }),
      output: "printed working directory",
    });

    const { lines, log } = await readSingleSessionLog(projectDir);
    assert.equal(lines[0].kind, "hook.event");
    assert.equal(lines[0].event, "AfterTool");
    assert.equal(lines[0].payload.hook_event_name, "PostToolUse");
    assert.deepEqual(
      lines.filter((entry) => entry.kind === "nams.request").map((entry) => entry.payload.operation),
      ["recordReasoningStep", "recordToolCall"],
    );
    assert.doesNotMatch(log, /Authorization|Bearer|test-api-key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex afterTool sanitizes output-like fields from tool input", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock().reasoningStep({ id: "step-1" }).toolCall();
    const { CodexAdapter } = await import(codexUrl);
    await seedCodexConversation(projectDir);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    await adapter.afterTool({
      platform: "codex",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        cwd: projectDir,
        tool_name: "shell",
        tool_use_id: "tool-use-1",
        tool_input: {
          command: "cat package.json",
          output: "raw output",
          result: "raw result",
          nested: {
            responseBody: "raw response body",
            keep: "metadata",
          },
        },
        tool_response: "done",
      },
    });

    const body = nams.requestBody("addToolCall");
    assert.match(body.input, /"command":"cat package\.json"/);
    assert.match(body.input, /"keep":"metadata"/);
    assert.doesNotMatch(body.input, /raw output|raw result|raw response body/);
    assert.doesNotMatch(body.input, /"output"|"result"|"responseBody"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("repeated Codex afterTool with same tool_use_id records one tool call", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock().reasoningStep({ id: "step-1" }).toolCall();
    const { CodexAdapter } = await import(codexUrl);
    await seedCodexConversation(projectDir);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });
    const invocation = {
      platform: "codex",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        cwd: projectDir,
        tool_name: "shell",
        tool_use_id: "tool-use-1",
        tool_input: { command: "pwd" },
        tool_response: "done",
      },
    };

    await adapter.afterTool(invocation);
    await adapter.afterTool(invocation);

    assert.equal(nams.calls("addReasoningStep").length, 1);
    assert.equal(nams.calls("addToolCall").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex afterTool without tool_use_id dedupes by fallback hash", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock().reasoningStep({ id: "step-1" }).toolCall();
    const { CodexAdapter } = await import(codexUrl);
    await seedCodexConversation(projectDir);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });
    const invocation = {
      platform: "codex",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: projectDir,
        tool_name: "shell",
        tool_input: { command: "pwd", result: "do not hash raw result" },
        tool_response: "done",
      },
    };

    await adapter.afterTool(invocation);
    await adapter.afterTool(invocation);

    assert.equal(nams.calls("addReasoningStep").length, 1);
    assert.equal(nams.calls("addToolCall").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex afterTool records distinct tool_use_id values with same input", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock().reasoningStep({ id: "step-1" }).toolCall();
    const { CodexAdapter } = await import(codexUrl);
    await seedCodexConversation(projectDir);
    const adapter = new CodexAdapter({
      ...testAdapterOptions(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });
    const basePayload = {
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: projectDir,
      tool_name: "shell",
      tool_input: { command: "pwd" },
      tool_response: "done",
    };

    await adapter.afterTool({
      platform: "codex",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: { ...basePayload, tool_use_id: "tool-use-1" },
    });
    await adapter.afterTool({
      platform: "codex",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: { ...basePayload, tool_use_id: "tool-use-2" },
    });

    assert.equal(nams.calls("addReasoningStep").length, 1);
    assert.equal(nams.calls("addToolCall").length, 2);
    assert.deepEqual(
      nams.requestBodies("addToolCall").map((body) => body.stepId),
      ["step-1", "step-1"],
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex afterTool missing config and failed NAMS calls allow and log minimal diagnostics", async () => {
  const missingConfigDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  const namsFailureDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const { CodexAdapter } = await import(codexUrl);
    await seedCodexConversation(missingConfigDir);
    await seedCodexConversation(namsFailureDir);

    const missingConfigResult = await new CodexAdapter({ ...testAdapterOptions(missingConfigDir) }).afterTool({
      platform: "codex",
      event: "AfterTool",
      processCwd: missingConfigDir,
      rawPayload: {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        cwd: missingConfigDir,
        tool_name: "shell",
        tool_use_id: "tool-use-1",
        tool_input: { command: "pwd" },
        tool_response: "done",
      },
    });

    assert.deepEqual(missingConfigResult.stdout, { continue: true });
    const { log: missingConfigLog, lines: missingConfigLines } = await readSingleSessionLog(missingConfigDir);
    assert.match(missingConfigLog, /NAMS apiKey missing/);
    const missingConfigDiagnostics = missingConfigLines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS apiKey missing",
    );
    assert.equal(missingConfigDiagnostics.length, 1);
    assert.deepEqual(missingConfigDiagnostics[0].payload.configSources, {
      apiKey: "missing",
      baseUrl: "default",
    });
    assert.doesNotMatch(missingConfigLog, /Authorization|Bearer|test-api-key/);

    const nams = createNamsFetchMock().reasoningStep({ error: "reasoning step unavailable" }, 503);
    const namsFailureResult = await new CodexAdapter({
      ...testAdapterOptions(namsFailureDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    }).afterTool({
      platform: "codex",
      event: "AfterTool",
      processCwd: namsFailureDir,
      rawPayload: {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        cwd: namsFailureDir,
        tool_name: "shell",
        tool_use_id: "tool-use-1",
        tool_input: { command: "pwd" },
        tool_response: "done",
      },
    });

    assert.deepEqual(namsFailureResult.stdout, { continue: true });
    const { lines: namsFailureLines, log: namsFailureLog } = await readSingleSessionLog(namsFailureDir);
    assert.match(namsFailureLog, /NAMS request failed/);
    const diagnostics = namsFailureLines.filter((entry) => entry.kind === "diagnostic");
    const failureDiagnostics = diagnostics.filter((entry) => entry.payload.message === "NAMS request failed");
    assert.deepEqual(failureDiagnostics.map((entry) => entry.payload), [{ message: "NAMS request failed" }]);
    assert.doesNotMatch(JSON.stringify(failureDiagnostics), /reasoning step unavailable|Authorization|Bearer|key/);
    assert.doesNotMatch(namsFailureLog, /Authorization|Bearer|key/);
  } finally {
    await rm(missingConfigDir, { recursive: true, force: true });
    await rm(namsFailureDir, { recursive: true, force: true });
  }
});

test("Codex afterTool without conversationId or toolName saves state and does not call NAMS", async () => {
  const noConversationDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  const noToolNameDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock().all({ error: "unexpected NAMS call" }, 500);
    const { CodexAdapter } = await import(codexUrl);
    await seedCodexConversation(noToolNameDir);
    const noConversationAdapter = new CodexAdapter({
      ...testAdapterOptions(noConversationDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });
    const noToolNameAdapter = new CodexAdapter({
      ...testAdapterOptions(noToolNameDir, {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      }),
      fetch: nams.fetch,
    });

    testEnv(noConversationDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const noConversationResult = await noConversationAdapter.afterTool({
      platform: "codex",
      event: "AfterTool",
      processCwd: noConversationDir,
      rawPayload: {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        cwd: noConversationDir,
        tool_name: "shell",
        tool_use_id: "tool-use-1",
        tool_input: { command: "pwd" },
      },
    });
    testEnv(noToolNameDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const noToolNameResult = await noToolNameAdapter.afterTool({
      platform: "codex",
      event: "AfterTool",
      processCwd: noToolNameDir,
      rawPayload: {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        cwd: noToolNameDir,
        tool_use_id: "tool-use-1",
        tool_input: { command: "pwd" },
      },
    });

    assert.deepEqual(noConversationResult.stdout, { continue: true });
    assert.deepEqual(noToolNameResult.stdout, { continue: true });
    assert.equal(nams.calls().length, 0);
  } finally {
    await rm(noConversationDir, { recursive: true, force: true });
    await rm(noToolNameDir, { recursive: true, force: true });
  }
});

test("raw Codex hook logs are session-scoped and include raw UserPromptSubmit payload fields", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({ ...testAdapterOptions(projectDir) });

    await adapter.startConversation({
      platform: "codex",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        source: "startup",
      },
    });
    await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "raw prompt text",
        source: "codex-cli",
        model: "gpt-5",
        permission_mode: "ask",
      },
    });

    const { fileName, lines, log } = await readSingleSessionLog(projectDir);
    assert.match(fileName, /^session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-[a-f0-9]{8}\.jsonl$/);
    assert.ok(lines.length >= 3);
    assert.equal(lines[0].kind, "hook.event");
    assert.match(log, /session-1/);
    assert.match(log, new RegExp(escapeRegExp(projectDir)));
    assert.match(log, /"event":"SessionStart"/);
    assert.match(log, /"event":"BeforeAgent"/);
    assert.match(log, /"hook_event_name":"UserPromptSubmit"/);
    assert.match(log, /"prompt":"raw prompt text"/);
    assert.match(log, /"source":"codex-cli"/);
    assert.match(log, /"model":"gpt-5"/);
    assert.match(log, /"permission_mode":"ask"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex observability log write failure does not block response", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const homeDir = testEnv(projectDir).HOME;
    await mkdir(namsHome(homeDir), { recursive: true });
    await writeFile(path.join(namsHome(homeDir), "logs"), "not a directory", "utf8");

    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({ ...testAdapterOptions(projectDir) });

    const result = await adapter.beforeAgent({
      platform: "codex",
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
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

async function readSingleSessionLog(projectDir) {
  const { logPath, lines } = await readRuntimeSingleSessionLog(testEnv(projectDir).HOME, "codex");
  const log = await readFile(logPath, "utf8");
  return { fileName: path.basename(logPath), lines, log };
}

async function seedCodexConversation(projectDir, sessionId = "session-1", conversationId = "conversation-1") {
  const { createInitialSessionState, saveSessionState } = await import(stateUrl);
  const state = createInitialSessionState({
    platform: "codex",
    sessionId,
    projectDirectory: projectDir,
  });
  state.conversationId = conversationId;
  testEnv(projectDir);
  await saveSessionState("codex", state.sessionKey, state);
  return state;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
