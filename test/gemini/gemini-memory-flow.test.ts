import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GeminiAdapter } from "../../src/platforms/gemini/index.js";
import { loadSessionState } from "../../src/runtime/session-state.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";
import { namsHome, readSingleSessionLog as readRuntimeSingleSessionLog } from "../support/runtime-home.js";

type TestEnvOverrides = Record<string, string | undefined>;
interface TestEnv extends TestEnvOverrides {
  HOME: string;
  USERPROFILE: string;
}

function testEnv(projectDir: string, overrides: TestEnvOverrides = {}): TestEnv {
  const env = { HOME: path.join(projectDir, "home"), USERPROFILE: path.join(projectDir, "home"), ...overrides };
  for (const key of [
    "HOME",
    "USERPROFILE",
    "NAMS_API_KEY",
    "NAMS_WORKSPACE_ID",
    "NAMS_BASE_URL",
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  return env;
}

function hookSpecificOutput(result: { stdout: Record<string, unknown> }): Record<string, any> {
  return result.stdout.hookSpecificOutput as Record<string, any>;
}

test("initializes Gemini session state on SessionStart without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    testEnv(projectDir);
    const adapter = new GeminiAdapter();

    const result = await adapter.startSession({
      platform: "gemini",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const state = (await loadSessionState("gemini", "session-1"))!;
    assert.notEqual(state, null);
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.conversationId, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("creates Gemini conversation, recalls memory, and stores first BeforeAgent user prompt", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const prompt = "Please remember that I prefer fixture-driven tests.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User prefers fixture-driven tests." }] })
      .searchEntities({
        entities: [{ name: "Fixture-driven tests", description: "User prefers fixture-driven tests." }],
      })
      .message();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, true);
    assert.equal(Object.hasOwn(result.stdout, "additionalContext"), false);
    assert.match(hookSpecificOutput(result).additionalContext, /User prefers fixture-driven tests\./);
    assert.equal(Object.hasOwn(hookSpecificOutput(result), "hookEventName"), false);
    assert.deepEqual(nams.requestBody("createConversation"), {
      metadata: {
        harness: "gemini",
        projectDirectory: projectDir,
      },
    });
    const createConversationHeaders = nams.calls("createConversation")[0].options.headers as Record<string, string>;
    assert.equal(createConversationHeaders["x-nams-hooks-harness"], "gemini");
    assert.equal(createConversationHeaders["x-nams-hooks-version"], "0.1.0");
    assert.equal(createConversationHeaders["x-nams-hooks-platform"], process.platform);
    assert.equal(createConversationHeaders["x-nams-hooks-node-version"], process.version);
    assert.equal(createConversationHeaders["x-nams-hooks-event"], "BeforeAgent");
    assert.equal(createConversationHeaders["x-workspace-id"], "workspace-1");
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
    const workspaceDiagnostics = lines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS workspace loaded from config",
    );
    assert.equal(workspaceDiagnostics.length, 1);
    assert.deepEqual(workspaceDiagnostics[0].payload.configSources, {
      apiKey: "env:NAMS_API_KEY",
      workspaceId: "env:NAMS_WORKSPACE_ID",
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
    assert.deepEqual(requestEntries[0].payload.request.body, {
      metadata: {
        harness: "gemini",
        projectDirectory: projectDir,
      },
    });
    assert.deepEqual(requestEntries[0].payload.response.body, { id: "conversation-1" });
    assert.equal(requestEntries[1].payload.request.url, "https://memory.example.test/v1/conversations/conversation-1/context");
    assert.equal(requestEntries[1].payload.request.body, undefined);
    assert.deepEqual(requestEntries[1].payload.response.body, {
      observations: [{ content: "User prefers fixture-driven tests." }],
    });
    assert.deepEqual(requestEntries[2].payload.request.body, {
      query: prompt,
      limit: 5,
    });
    assert.deepEqual(requestEntries[2].payload.response.body, {
      entities: [{ name: "Fixture-driven tests", description: "User prefers fixture-driven tests." }],
    });
    assert.deepEqual(requestEntries[3].payload.request.body, {
      role: "user",
      content: prompt,
    });
    assert.deepEqual(requestEntries[3].payload.response.body, { id: "message-1" });
    assert.match(JSON.stringify(requestEntries), /fixture-driven tests/);
    assert.doesNotMatch(JSON.stringify(requestEntries), /Authorization|Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini BeforeAgent uses entity search context when conversation context fails", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const prompt = "Persist this even if recall is unavailable.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ error: "context unavailable" }, 503)
      .searchEntities({
        entities: [{ name: "Autonomo", description: "User is exploring autonomo setup in Spain." }],
      })
      .message();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, true);
    assert.equal(Object.hasOwn(result.stdout, "additionalContext"), false);
    assert.match(hookSpecificOutput(result).additionalContext, /Autonomo: User is exploring autonomo setup in Spain\./);
    assert.equal(Object.hasOwn(hookSpecificOutput(result), "hookEventName"), false);
    assert.deepEqual(nams.requestBody("searchEntities"), {
      query: prompt,
      limit: 5,
    });
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: prompt,
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not store duplicate Gemini BeforeAgent user prompt twice", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const prompt = "Remember this only once.";
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();
    const invocation = {
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
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

test("allows Gemini BeforeAgent when NAMS returns an error", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    createNamsFetchMock().all({ error: "service unavailable" }, 503);
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Keep going even if memory is unavailable.",
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini BeforeAgent returns recalled context when user message persistence fails", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User wants concise updates." }] })
      .searchEntities()
      .message({ error: "message write unavailable" }, 503);
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Hello",
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, true);
    assert.equal(Object.hasOwn(result.stdout, "additionalContext"), false);
    assert.match(hookSpecificOutput(result).additionalContext, /User wants concise updates\./);
    assert.equal(Object.hasOwn(hookSpecificOutput(result), "hookEventName"), false);
    assert.equal(nams.calls("addMessage").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini BeforeAgent continues when NAMS_API_KEY is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    testEnv(projectDir);
    const adapter = new GeminiAdapter();

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
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
      workspaceId: "missing",
      baseUrl: "missing",
    });
    assert.doesNotMatch(log, /Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini BeforeAgent uses auto-selected workspace when NAMS_WORKSPACE_ID is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const selectedWorkspaceId = "workspace-auto";
    const prompt = "remember this";
    const nams = createNamsFetchMock()
      .workspaces({
        workspaces: [{ id: selectedWorkspaceId, name: "Engineering", role: "owner", status: "active" }],
      })
      .createConversation()
      .context()
      .searchEntities()
      .message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new GeminiAdapter();
    const invocation = {
      platform: "gemini" as const,
      event: "BeforeAgent" as const,
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    };

    const result = await adapter.beforeAgent(invocation);

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 1);
    const createConversationHeaders = nams.calls("createConversation")[0].options.headers as Record<string, string>;
    assert.equal(createConversationHeaders["x-workspace-id"], selectedWorkspaceId);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini BeforeAgent notifies and continues when multiple workspaces are available", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const nams = createNamsFetchMock().workspaces({
      workspaces: [
        { id: "workspace-1", name: "Default", role: "owner", status: "active" },
        { id: "workspace-2", name: "test2", role: "owner", status: "active" },
      ],
    });
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new GeminiAdapter();

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "remember this",
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, false);
    assert.equal(Object.hasOwn(result.stdout, "decision"), false);
    assert.match(String(result.stdout.systemMessage), /NAMS memory is inactive/);
    assert.match(String(result.stdout.systemMessage), /\/nams:workspace use <workspace-id-or-name>/);
    assert.match(
      String(result.stdout.systemMessage),
      /nams-hooks workspaces configure gemini --scope session --session-id session-1 --workspace <workspace-id-or-name>/,
    );
    assert.match(String(result.stdout.systemMessage), /workspace-1/);
    assert.match(String(result.stdout.systemMessage), /workspace-2/);
    assert.match(String(hookSpecificOutput(result).additionalContext), /Multiple NAMS workspaces are available/);
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 0);
    const markerPath = path.join(namsHome(testEnv(projectDir).HOME), "state", "gemini", "active-workspace-sessions.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(marker.sessions.length, 1);
    assert.equal(marker.sessions[0].sessionId, "session-1");
    assert.equal(marker.sessions[0].sessionKey, "session-1");
    assert.equal(marker.sessions[0].projectDirectory, path.resolve(projectDir));
    assert.equal(typeof marker.sessions[0].touchedAt, "string");
    assert.equal(Object.hasOwn(marker, "version"), false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini BeforeAgent logs invalid config diagnostics without raw JSON contents", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await writeFile(path.join(projectDir, ".nams", "config.json"), '{"apiKey":"secret-config-value"', "utf8");
    testEnv(projectDir);
    const adapter = new GeminiAdapter();

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
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
          workspaceId: "missing",
          baseUrl: "missing",
        },
        errorSource: "project:.nams/config.json",
      },
    ]);
    assert.doesNotMatch(log, /secret-config-value/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini BeforeAgent continues when NAMS request fails", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    createNamsFetchMock().all({ error: "service unavailable" }, 503);
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Hello",
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /NAMS request failed/);
    assert.doesNotMatch(log, /Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini NAMS failure diagnostics do not include arbitrary error text", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    createNamsFetchMock()
        .throws(
          new Error(
            'Authorization: Bearer secret NAMS_API_KEY {"body":"content secret","prompt":"do not log me"}',
          ),
        )
        ;
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Hello",
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /NAMS request failed/);
    assert.doesNotMatch(log, /Authorization|Bearer|content secret|do not log me/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini session log keeps hook events together and includes user prompt fields", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    testEnv(projectDir);
    const adapter = new GeminiAdapter();

    await adapter.startSession({
      platform: "gemini",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
      },
    });
    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "raw prompt text",
        hook_event_name: "BeforeAgent",
      },
    });

    const { fileName, lines, log } = await readSingleSessionLog(projectDir);
    assert.match(fileName, /^session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-[a-f0-9]{8}\.jsonl$/);
    assert.ok(lines.length >= 3);
    assert.match(log, /session-1/);
    assert.match(log, new RegExp(escapeRegExp(projectDir)));
    assert.equal(lines[0].kind, "hook.event");
    assert.match(log, /"event":"SessionStart"/);
    assert.match(log, /"event":"BeforeAgent"/);
    assert.match(log, /NAMS apiKey missing/);
    const diagnostics = lines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS apiKey missing",
    );
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0].payload.configSources, {
      apiKey: "missing",
      workspaceId: "missing",
      baseUrl: "missing",
    });
    assert.match(log, /"prompt":"raw prompt text"/);
    assert.match(log, /"hook_event_name":"BeforeAgent"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini AfterAgent platform log keeps raw assistant response fields", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    testEnv(projectDir);
    const adapter = new GeminiAdapter();

    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt_response: "raw assistant response text",
        stop_hook_active: false,
      },
    });

    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /session-1/);
    assert.match(log, new RegExp(escapeRegExp(projectDir)));
    assert.match(log, /"prompt_response":"raw assistant response text"/);
    assert.match(log, /"stop_hook_active":false/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini AfterTool platform log keeps raw tool output fields", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    testEnv(projectDir);
    const adapter = new GeminiAdapter();

    const result = await adapter.afterTool({
      platform: "gemini",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        tool_name: "read_file",
        tool_input: { path: "notes.md" },
        tool_output: "raw tool output text",
        output: "raw output text",
        result: "raw result text",
        resultDisplay: "raw display text",
        functionResponse: { output: "raw function response text" },
        nested: {
          args: { keep: "metadata" },
          output: "nested output text",
          result: "nested result text",
        },
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /read_file/);
    assert.match(log, /metadata/);
    assert.match(log, /"tool_output":"raw tool output text"/);
    assert.match(log, /"output":"raw output text"/);
    assert.match(log, /"result":"raw result text"/);
    assert.match(log, /"resultDisplay":"raw display text"/);
    assert.match(log, /"functionResponse":\{"output":"raw function response text"\}/);
    assert.match(log, /"output":"nested output text"/);
    assert.match(log, /"result":"nested result text"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini platform log keeps nested non-sensitive payload fields", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    testEnv(projectDir);
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "raw prompt text",
        request: {
          id: "request-1",
          headers: {
            accept: "application/json",
          },
          metadata: {
            project: "nams-hooks",
          },
        },
      },
    });

    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /session-1/);
    assert.match(log, /"prompt":"raw prompt text"/);
    assert.match(log, /"id":"request-1"/);
    assert.match(log, /"accept":"application\/json"/);
    assert.match(log, /"project":"nams-hooks"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini hooks continue when observability log writes fail", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    const homeDir = testEnv(projectDir).HOME;
    await mkdir(namsHome(homeDir), { recursive: true });
    await writeFile(path.join(namsHome(homeDir), "logs"), "not a directory", "utf8");
    createNamsFetchMock().all({ error: "service unavailable" }, 503);
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    const beforeAgentResult = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Hello",
      },
    });
    const afterToolResult = await adapter.afterTool({
      platform: "gemini",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        tool_name: "read_file",
        result: "raw result text",
      },
    });

    assert.deepEqual(beforeAgentResult.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(afterToolResult.stdout, { continue: true, suppressOutput: true });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("records Gemini AfterTool payload as a reasoning step with tool output", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-after-tool-1" })
      .toolCall();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Read a file.",
      },
    });

    const result = await adapter.afterTool({
      platform: "gemini",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        tool_name: "read_file",
        tool_input: { path: "notes.md", keep: "metadata" },
        tool_response: {
          llmContent: "raw tool output text",
          returnDisplay: "Tool returned a display summary.",
        },
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const reasoningBodies = nams.requestBodies("addReasoningStep");
    assert.deepEqual(reasoningBodies, [
      {
        conversationId: "conversation-1",
        reasoning: "Gemini invoked read_file with the provided tool input.",
        actionTaken: "Ran read_file",
        result: "Tool returned a display summary.",
      },
    ]);

    const toolBodies = nams.requestBodies("addToolCall");
    assert.equal(toolBodies.length, 1);
    assert.equal(toolBodies[0].toolName, "read_file");
    assert.equal(toolBodies[0].stepId, "step-after-tool-1");
    assert.equal(Object.hasOwn(toolBodies[0], "status"), false);
    assert.equal(Object.hasOwn(toolBodies[0], "durationMs"), false);
    assert.equal(toolBodies[0].output, "raw tool output text");
    assert.match(toolBodies[0].input, /"path":"notes.md"/);
    assert.match(toolBodies[0].input, /"keep":"metadata"/);
    assert.doesNotMatch(toolBodies[0].input, /raw tool output text|Tool returned a display summary/);
    assert.doesNotMatch(toolBodies[0].input, /"tool_response"|"llmContent"|"returnDisplay"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("ignores undocumented Gemini AfterTool output fallback fields", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-after-tool-1" })
      .toolCall();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Read a file.",
      },
    });

    await adapter.afterTool({
      platform: "gemini",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        tool_name: "read_file",
        tool_input: { path: "notes.md" },
        output: "undocumented payload output",
        result: "undocumented payload result",
        toolResponse: { llmContent: "undocumented camel response output" },
        tool_response: {
          returnDisplay: "Documented display summary only.",
        },
      },
    });

    const reasoningBodies = nams.requestBodies("addReasoningStep");
    assert.equal(reasoningBodies[0].result, "Documented display summary only.");

    const toolBodies = nams.requestBodies("addToolCall");
    assert.equal(toolBodies.length, 1);
    assert.equal(toolBodies[0].output, "");
    assert.doesNotMatch(JSON.stringify(toolBodies[0]), /undocumented payload|undocumented camel/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("ignores undocumented Gemini AfterTool tool name aliases", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-after-tool-1" })
      .toolCall();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Search once.",
      },
    });

    await adapter.afterTool({
      platform: "gemini",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        toolName: "google_web_search",
        tool_input: { query: "nams" },
        tool_response: { llmContent: "search result text" },
      },
    });

    assert.equal(nams.calls("addReasoningStep").length, 0);
    assert.equal(nams.calls("addToolCall").length, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not duplicate Gemini AfterTool metadata for the same documented tool input", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-after-tool-1" })
      .toolCall();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Search once.",
      },
    });

    const invocation = {
      platform: "gemini",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        tool_name: "google_web_search",
        tool_input: { query: "nams" },
      },
    } as const;

    await adapter.afterTool(invocation);
    await adapter.afterTool(invocation);

    assert.equal(nams.calls("addToolCall").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("records distinct Gemini AfterTool calls with different documented tool inputs", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-after-tool-1" })
      .toolCall();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Search twice.",
      },
    });

    for (const query of ["nams", "nams hooks"]) {
      await adapter.afterTool({
        platform: "gemini",
        event: "AfterTool",
        processCwd: projectDir,
        rawPayload: {
          session_id: "session-1",
          cwd: projectDir,
          tool_name: "google_web_search",
          tool_input: { query },
        },
      });
    }

    const toolBodies = nams.requestBodies("addToolCall");
    assert.equal(toolBodies.length, 2);
    assert.match(toolBodies[0].input, /"query":"nams"/);
    assert.match(toolBodies[1].input, /"query":"nams hooks"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not duplicate AfterTool when transcript later contains the same tool call", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "gemini-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1" }),
        JSON.stringify({
          id: "gemini-1",
          type: "gemini",
          content: "",
          toolCalls: [
            {
              id: "google_web_search_1",
              name: "google_web_search",
              args: { query: "nams" },
              status: "success",
              timestamp: "2026-05-11T09:30:02.000Z",
            },
          ],
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-after-tool-1" })
      .toolCall();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Search once.",
      },
    });
    await adapter.afterTool({
      platform: "gemini",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        tool_name: "google_web_search",
        tool_input: { query: "nams" },
        status: "success",
        tool_response: { llmContent: "search result text" },
      },
    });
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    const toolBodies = nams.requestBodies("addToolCall");
    assert.equal(toolBodies.length, 1);
    assert.equal(toolBodies[0].stepId, "step-after-tool-1");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("stores Gemini AfterAgent prompt_response as an assistant message", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Say hello.",
      },
    });

    const result = await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt_response: "Hello!",
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

test("stores Gemini AfterAgent assistant message from transcript when prompt_response is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "gemini-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1" }),
        JSON.stringify({ id: "assistant-1", type: "gemini", content: "Fallback response" }),
        "",
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Use transcript fallback.",
      },
    });

    const result = await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBodies("addMessage").at(-1), {
      role: "assistant",
      content: "Fallback response",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not duplicate prompt_response assistant messages during later transcript fallback", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "gemini-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1" }),
        JSON.stringify({ id: "assistant-a", type: "gemini", content: "A" }),
        JSON.stringify({ id: "assistant-b", type: "gemini", content: "B" }),
        "",
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Create a conversation.",
      },
    });
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt_response: "A",
      },
    });
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt_response: "B",
      },
    });

    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    const assistantMessageBodies = nams.requestBodies("addMessage").filter((body) => body.role === "assistant");
    assert.deepEqual(assistantMessageBodies, [
      { role: "assistant", content: "A" },
      { role: "assistant", content: "B" },
    ]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("deduplicates repeated Gemini transcript thoughts by reasoning body", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "gemini-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1" }),
        JSON.stringify({
          id: "gemini-1",
          type: "gemini",
          content: "",
          thoughts: [
            {
              subject: "Researching",
              description: "Searching official guidance",
              timestamp: "2026-05-11T09:30:00.000Z",
            },
            {
              subject: "Researching",
              description: "Searching official guidance",
              timestamp: "2026-05-11T09:30:01.000Z",
            },
          ],
        }),
        JSON.stringify({
          id: "gemini-2",
          type: "gemini",
          content: "",
          thoughts: [
            {
              subject: "Researching",
              description: "Searching official guidance",
              timestamp: "2026-05-11T09:30:02.000Z",
            },
          ],
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock().createConversation().context().searchEntities().message().reasoningStep();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Find current official guidance.",
      },
    });

    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    const reasoningBodies = nams.requestBodies("addReasoningStep");
    assert.deepEqual(reasoningBodies, [
      {
        conversationId: "conversation-1",
        reasoning: "Searching official guidance",
        actionTaken: "Researching",
      },
    ]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("records Gemini transcript thoughts and sanitized tool metadata", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "gemini-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1" }),
        JSON.stringify({
          id: "gemini-1",
          type: "gemini",
          content: "",
          thoughts: [
            {
              subject: "Researching",
              description: "Searching official guidance",
              timestamp: "2026-05-11T09:30:00.000Z",
            },
          ],
          toolCalls: [
            {
              id: "google_web_search_1",
              name: "google_web_search",
              args: { query: "autonomo spain" },
              result: "raw output should not be persisted",
              functionResponse: { output: "function response should not be persisted" },
              resultDisplay: "raw display should not be persisted",
              status: "success",
              timestamp: "2026-05-11T09:30:01.000Z",
            },
          ],
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep()
      .toolCall();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Find current official guidance.",
      },
    });

    const result = await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBody("addReasoningStep"), {
      conversationId: "conversation-1",
      reasoning: "Searching official guidance",
      actionTaken: "Researching",
    });

    const toolBody = nams.requestBody("addToolCall");
    assert.equal(toolBody.toolName, "google_web_search");
    assert.equal(toolBody.status, "success");
    assert.equal(toolBody.stepId, "step-1");
    assert.equal(toolBody.output, "");
    assert.match(toolBody.input, /"query":"autonomo spain"/);
    assert.doesNotMatch(
      toolBody.input,
      /raw output should not be persisted|raw display should not be persisted|function response should not be persisted/,
    );
    assert.doesNotMatch(toolBody.input, /"result"|"resultDisplay"|"functionResponse"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("deduplicates repeated Gemini transcript tool ids", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "gemini-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1" }),
        JSON.stringify({
          id: "gemini-1",
          type: "gemini",
          content: "",
          toolCalls: [
            {
              id: "google_web_search_1",
              name: "google_web_search",
              args: { query: "autonomo spain" },
              status: "success",
              timestamp: "2026-05-11T09:30:01.000Z",
            },
          ],
        }),
        JSON.stringify({
          id: "gemini-2",
          type: "gemini",
          content: "",
          toolCalls: [
            {
              id: "google_web_search_1",
              name: "google_web_search",
              args: { query: "autonomo portugal" },
              status: "success",
              timestamp: "2026-05-11T09:31:01.000Z",
            },
          ],
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock().createConversation().context().searchEntities().message().toolCall();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Find official guidance.",
      },
    });
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    const toolBodies = nams.requestBodies("addToolCall");
    assert.equal(toolBodies.length, 1);
    assert.match(toolBodies[0].input, /"query":"autonomo spain"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("preserves reasoning step id when retrying a failed transcript tool call", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "gemini-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1" }),
        JSON.stringify({
          id: "gemini-1",
          type: "gemini",
          content: "",
          thoughts: [
            {
              subject: "Researching",
              description: "Searching official guidance",
              timestamp: "2026-05-11T09:30:00.000Z",
            },
          ],
          toolCalls: [
            {
              id: "google_web_search_1",
              name: "google_web_search",
              args: { query: "autonomo spain" },
              status: "success",
              timestamp: "2026-05-11T09:30:01.000Z",
            },
          ],
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    let failToolCall = true;
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep()
      .toolCall(() => {
        if (failToolCall) {
          failToolCall = false;
          return { status: 503, body: { error: "temporary failure" } };
        }
        return { status: 201, body: { id: "tool-call-1" } };
      });
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Find official guidance.",
      },
    });
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    const successfulToolBody = nams.requestBodies("addToolCall").at(-1);
    assert.equal(successfulToolBody.stepId, "step-1");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not attach reasoning step from a previous transcript entry to a later tool call", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "gemini-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1" }),
        JSON.stringify({
          id: "gemini-1",
          type: "gemini",
          content: "",
          thoughts: [
            {
              subject: "Researching",
              description: "Searching official guidance",
              timestamp: "2026-05-11T09:30:00.000Z",
            },
          ],
        }),
        JSON.stringify({
          id: "gemini-2",
          type: "gemini",
          content: "",
          toolCalls: [
            {
              id: "google_web_search_1",
              name: "google_web_search",
              args: { query: "autonomo spain" },
              status: "success",
              timestamp: "2026-05-11T09:31:01.000Z",
            },
          ],
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep()
      .toolCall();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Find official guidance.",
      },
    });
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    const toolBody = nams.requestBodies("addToolCall").at(-1);
    assert.equal(Object.hasOwn(toolBody, "stepId"), false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not attach reasoning step when a transcript entry has multiple thoughts before a tool call", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "gemini-transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1" }),
        JSON.stringify({
          id: "gemini-1",
          type: "gemini",
          content: "",
          thoughts: [
            {
              subject: "Researching",
              description: "Searching official guidance",
              timestamp: "2026-05-11T09:30:00.000Z",
            },
            {
              subject: "Comparing",
              description: "Checking regional requirements",
              timestamp: "2026-05-11T09:30:01.000Z",
            },
          ],
          toolCalls: [
            {
              id: "google_web_search_1",
              name: "google_web_search",
              args: { query: "autonomo spain" },
              status: "success",
              timestamp: "2026-05-11T09:30:02.000Z",
            },
          ],
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    let stepCount = 0;
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep(() => {
        stepCount += 1;
        return { status: 201, body: { id: `step-${stepCount}` } };
      })
      .toolCall();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Find official guidance.",
      },
    });
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    const toolBody = nams.requestBodies("addToolCall").at(-1);
    assert.equal(Object.hasOwn(toolBody, "stepId"), false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("deduplicates repeated parent transcript tool id despite changed status and timestamp", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "gemini-transcript.jsonl");
    const writeTranscript = async (status: string, timestamp: string): Promise<void> => {
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({ sessionId: "session-1" }),
          JSON.stringify({
            id: "gemini-1",
            type: "gemini",
            content: "",
            toolCalls: [
              {
                id: "google_web_search_1",
                name: "google_web_search",
                args: { query: "autonomo spain" },
                status,
                timestamp,
              },
            ],
          }),
          "",
        ].join("\n"),
        "utf8",
      );
    };
    await writeTranscript("running", "2026-05-11T09:30:01.000Z");

    const nams = createNamsFetchMock().createConversation().context().searchEntities().message().toolCall();
    testEnv(projectDir, {
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: "https://memory.example.test",
      });
    const adapter = new GeminiAdapter();

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Find official guidance.",
      },
    });
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    await writeTranscript("success", "2026-05-11T09:30:05.000Z");
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        transcript_path: transcriptPath,
      },
    });

    const toolBodies = nams.requestBodies("addToolCall");
    assert.equal(toolBodies.length, 1);
    assert.equal(toolBodies[0].status, "running");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

async function readSingleSessionLog(
  projectDir: string,
): Promise<{ fileName: string; log: string; lines: Array<Record<string, any>> }> {
  const { logPath, lines } = await readRuntimeSingleSessionLog(testEnv(projectDir).HOME, "gemini");
  const log = await readFile(logPath, "utf8");
  return {
    fileName: path.basename(logPath),
    log,
    lines,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
