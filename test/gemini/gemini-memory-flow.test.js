import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const geminiUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "gemini", "index.js")).href;
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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /User prefers fixture-driven tests\./);
    assert.equal(result.stdout.hookSpecificOutput.hookEventName, "BeforeAgent");
    assert.deepEqual(nams.requestBody("createConversation"), {
      metadata: {
        harness: "gemini",
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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Autonomo: User is exploring autonomo setup in Spain\./);
    assert.equal(result.stdout.hookSpecificOutput.hookEventName, "BeforeAgent");
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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });
    const invocation = {
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
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

test("allows Gemini BeforeAgent when NAMS returns an error", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: createNamsFetchMock().all({ error: "service unavailable" }, 503).fetch,
    });

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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /User wants concise updates\./);
    assert.equal(result.stdout.hookSpecificOutput.hookEventName, "BeforeAgent");
    assert.equal(nams.calls("addMessage").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini BeforeAgent continues when NAMS_API_KEY is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({ env: {} });

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
    assert.match(log, /NAMS apiKey missing/);
    assert.doesNotMatch(log, /Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini BeforeAgent logs invalid config diagnostics without raw JSON contents", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await writeFile(path.join(projectDir, ".nams", "config.json"), '{"apiKey":"secret-config-value"', "utf8");
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({ env: { HOME: projectDir } });

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
          baseUrl: "default",
        },
        errorSource: "global:~/.nams/config.json",
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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: createNamsFetchMock().all({ error: "service unavailable" }, 503).fetch,
    });

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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: createNamsFetchMock()
        .throws(
          new Error(
            'Authorization: Bearer secret NAMS_API_KEY {"body":"content secret","prompt":"do not log me"}',
          ),
        )
        .fetch,
    });

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
    assert.doesNotMatch(log, /Authorization|Bearer|NAMS_API_KEY|content secret|do not log me/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini session log keeps hook events together and includes user prompt fields", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({ env: {} });

    await adapter.startConversation({
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
        user_prompt: "raw snake prompt text",
        userPrompt: "raw camel prompt text",
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
    assert.match(log, /"prompt":"raw prompt text"/);
    assert.match(log, /"user_prompt":"raw snake prompt text"/);
    assert.match(log, /"userPrompt":"raw camel prompt text"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini AfterAgent platform log keeps raw assistant response fields", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter();

    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt_response: "raw assistant response text",
        promptResponse: "raw camel response text",
        response: "raw response text",
        content: "raw content text",
      },
    });

    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /session-1/);
    assert.match(log, new RegExp(escapeRegExp(projectDir)));
    assert.match(log, /"prompt_response":"raw assistant response text"/);
    assert.match(log, /"promptResponse":"raw camel response text"/);
    assert.match(log, /"response":"raw response text"/);
    assert.match(log, /"content":"raw content text"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini AfterTool platform log keeps raw tool output fields", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const { GeminiAdapter } = await import(geminiUrl);
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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({ env: {} });

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
    await writeFile(path.join(projectDir, ".nams", "logs"), "not a directory", "utf8");

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: createNamsFetchMock().all({ error: "service unavailable" }, 503).fetch,
    });

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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
        tool_call_id: "tool-1",
        tool_name: "read_file",
        tool_input: { path: "notes.md", keep: "metadata" },
        status: "success",
        duration_ms: 42,
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
    assert.equal(toolBodies[0].status, "success");
    assert.equal(toolBodies[0].durationMs, 42);
    assert.equal(toolBodies[0].output, "raw tool output text");
    assert.match(toolBodies[0].input, /"path":"notes.md"/);
    assert.match(toolBodies[0].input, /"keep":"metadata"/);
    assert.doesNotMatch(toolBodies[0].input, /raw tool output text|Tool returned a display summary/);
    assert.doesNotMatch(toolBodies[0].input, /"tool_response"|"llmContent"|"returnDisplay"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not duplicate Gemini AfterTool metadata for the same tool call id", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-after-tool-1" })
      .toolCall();
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
        tool_call_id: "tool-1",
        tool_name: "google_web_search",
        tool_input: { query: "nams" },
        status: "success",
      },
    };

    await adapter.afterTool(invocation);
    await adapter.afterTool(invocation);

    assert.equal(nams.calls("addToolCall").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("records distinct Gemini AfterTool calls with matching inputs when ids differ", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-after-tool-1" })
      .toolCall();
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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

    for (const toolCallId of ["tool-1", "tool-2"]) {
      await adapter.afterTool({
        platform: "gemini",
        event: "AfterTool",
        processCwd: projectDir,
        rawPayload: {
          session_id: "session-1",
          cwd: projectDir,
          tool_call_id: toolCallId,
          tool_name: "google_web_search",
          tool_input: { query: "nams" },
          status: "success",
        },
      });
    }

    const toolBodies = nams.requestBodies("addToolCall");
    assert.equal(toolBodies.length, 2);
    assert.match(toolBodies[0].input, /"query":"nams"/);
    assert.match(toolBodies[1].input, /"query":"nams"/);
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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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
    const writeTranscript = async (status, timestamp) => {
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
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

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

async function readSingleSessionLog(projectDir) {
  const logDir = path.join(projectDir, ".nams", "logs");
  const logFiles = (await readdir(logDir)).filter((fileName) => /^session-.*\.jsonl$/.test(fileName));
  assert.equal(logFiles.length, 1, `expected one session log file, got ${logFiles.join(", ")}`);
  const fileName = logFiles[0];
  const log = await readFile(path.join(logDir, fileName), "utf8");
  return {
    fileName,
    log,
    lines: log.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
