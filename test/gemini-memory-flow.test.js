import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    const requests = [];
    const prompt = "Please remember that I prefer fixture-driven tests.";
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({
          observations: [{ content: "User prefers fixture-driven tests." }],
        });
      }
      if (url === "https://memory.example.test/v1/entities/search") {
        return jsonResponse({
          entities: [{ name: "Fixture-driven tests", description: "User prefers fixture-driven tests." }],
        });
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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
    assert.match(result.stdout.additionalContext, /User prefers fixture-driven tests\./);
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      metadata: {
        harness: "gemini",
        projectDirectory: projectDir,
      },
    });
    assert.deepEqual(JSON.parse(requests[2].init.body), {
      query: prompt,
      limit: 5,
    });
    assert.deepEqual(JSON.parse(requests[3].init.body), {
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
    const requests = [];
    const prompt = "Persist this even if recall is unavailable.";
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({ error: "context unavailable" }, 503);
      }
      if (url === "https://memory.example.test/v1/entities/search") {
        return jsonResponse({
          entities: [{ name: "Autonomo", description: "User is exploring autonomo setup in Spain." }],
        });
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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
    assert.match(result.stdout.additionalContext, /Autonomo: User is exploring autonomo setup in Spain\./);
    const entitySearchRequest = requests.find(
      (request) => request.init.method === "POST" && request.url === "https://memory.example.test/v1/entities/search",
    );
    assert.deepEqual(JSON.parse(entitySearchRequest.init.body), {
      query: prompt,
      limit: 5,
    });
    const messageRequest = requests.find(
      (request) =>
        request.init.method === "POST" &&
        request.url === "https://memory.example.test/v1/conversations/conversation-1/messages",
    );
    assert.deepEqual(JSON.parse(messageRequest.init.body), {
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
    const requests = [];
    const prompt = "Remember this only once.";
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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

    const userMessageRequests = requests.filter(
      (request) =>
        request.init.method === "POST" &&
        request.url === "https://memory.example.test/v1/conversations/conversation-1/messages",
    );
    assert.equal(userMessageRequests.length, 1);
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
      fetch: async () => jsonResponse({ error: "service unavailable" }, 503),
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
    const requests = [];
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (url === "https://memory.example.test/v1/conversations") {
          return jsonResponse({ id: "conversation-1" }, 201);
        }
        if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
          return jsonResponse({
            observations: [{ content: "User wants concise updates." }],
          });
        }
        if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
          return jsonResponse({ error: "message write unavailable" }, 503);
        }
        return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
      },
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
    assert.match(result.stdout.additionalContext, /User wants concise updates\./);
    assert.equal(
      requests.filter(
        (request) => request.url === "https://memory.example.test/v1/conversations/conversation-1/messages",
      ).length,
      1,
    );
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
    assert.match(log, /NAMS_API_KEY missing/);
    assert.doesNotMatch(log, /Bearer|key/);
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
      fetch: async () => jsonResponse({ error: "service unavailable" }, 503),
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
      fetch: async () => {
        throw new Error(
          'Authorization: Bearer secret NAMS_API_KEY {"body":"content secret","prompt":"do not log me"}',
        );
      },
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
        prompt: "raw prompt secret",
        user_prompt: "raw snake prompt secret",
        userPrompt: "raw camel prompt secret",
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
    assert.match(log, /NAMS_API_KEY missing/);
    assert.match(log, /"prompt":"raw prompt secret"/);
    assert.match(log, /"user_prompt":"raw snake prompt secret"/);
    assert.match(log, /"userPrompt":"raw camel prompt secret"/);
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
        prompt_response: "raw assistant response secret",
        promptResponse: "raw camel response secret",
        response: "raw response secret",
        content: "raw content secret",
      },
    });

    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /session-1/);
    assert.match(log, new RegExp(escapeRegExp(projectDir)));
    assert.match(log, /"prompt_response":"raw assistant response secret"/);
    assert.match(log, /"promptResponse":"raw camel response secret"/);
    assert.match(log, /"response":"raw response secret"/);
    assert.match(log, /"content":"raw content secret"/);
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
        tool_output: "raw tool output secret",
        output: "raw output secret",
        result: "raw result secret",
        resultDisplay: "raw display secret",
        functionResponse: { output: "raw function response secret" },
        nested: {
          args: { keep: "metadata" },
          output: "nested output secret",
          result: "nested result secret",
        },
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /read_file/);
    assert.match(log, /metadata/);
    assert.match(log, /"tool_output":"raw tool output secret"/);
    assert.match(log, /"output":"raw output secret"/);
    assert.match(log, /"result":"raw result secret"/);
    assert.match(log, /"resultDisplay":"raw display secret"/);
    assert.match(log, /"functionResponse":\{"output":"raw function response secret"\}/);
    assert.match(log, /"output":"nested output secret"/);
    assert.match(log, /"result":"nested result secret"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini platform log keeps nested secret, header, and body fields", async () => {
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
        prompt: "raw prompt secret",
        request: {
          Authorization: "Bearer header secret",
          headers: {
            authorization: "Bearer nested header secret",
            token: "nested token secret",
          },
          apiKey: "camel api secret",
          api_key: "snake api secret",
          secret: "plain secret value",
          body: { content: "body content secret" },
          NAMS_API_KEY: "nams api key secret",
          access_token: "access token secret",
          refreshToken: "refresh token secret",
          bearerToken: "bearer token secret",
          client_secret: "client secret value",
          "x-api-key": "x api key secret",
          password: "password secret",
          request_body: "request body secret",
          requestBody: "camel request body secret",
          response_body: "response body secret",
          responseBody: "camel response body secret",
          tool_result: "tool result secret",
          toolResult: "camel tool result secret",
          assistant_response: "assistant response secret",
          assistantResponse: "camel assistant response secret",
          model_output: "model output secret",
          tool_response: "tool response secret",
        },
      },
    });

    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /session-1/);
    assert.match(log, /"prompt":"raw prompt secret"/);
    assert.match(log, /"Authorization":"Bearer header secret"/);
    assert.match(log, /"authorization":"Bearer nested header secret"/);
    assert.match(log, /"token":"nested token secret"/);
    assert.match(log, /"apiKey":"camel api secret"/);
    assert.match(log, /"api_key":"snake api secret"/);
    assert.match(log, /"secret":"plain secret value"/);
    assert.match(log, /"body":\{"content":"body content secret"\}/);
    assert.match(log, /"NAMS_API_KEY":"nams api key secret"/);
    assert.match(log, /"access_token":"access token secret"/);
    assert.match(log, /"refreshToken":"refresh token secret"/);
    assert.match(log, /"bearerToken":"bearer token secret"/);
    assert.match(log, /"client_secret":"client secret value"/);
    assert.match(log, /"x-api-key":"x api key secret"/);
    assert.match(log, /"password":"password secret"/);
    assert.match(log, /"request_body":"request body secret"/);
    assert.match(log, /"requestBody":"camel request body secret"/);
    assert.match(log, /"response_body":"response body secret"/);
    assert.match(log, /"responseBody":"camel response body secret"/);
    assert.match(log, /"tool_result":"tool result secret"/);
    assert.match(log, /"toolResult":"camel tool result secret"/);
    assert.match(log, /"assistant_response":"assistant response secret"/);
    assert.match(log, /"assistantResponse":"camel assistant response secret"/);
    assert.match(log, /"model_output":"model output secret"/);
    assert.match(log, /"tool_response":"tool response secret"/);
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
      fetch: async () => jsonResponse({ error: "service unavailable" }, 503),
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
        result: "raw result secret",
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
    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/steps") {
        return jsonResponse({ id: "step-after-tool-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/tool-calls") {
        return jsonResponse({ id: "tool-call-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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
    const reasoningBodies = requests
      .filter(
        (request) =>
          request.init.method === "POST" && request.url === "https://memory.example.test/v1/reasoning/steps",
      )
      .map((request) => JSON.parse(request.init.body));
    assert.deepEqual(reasoningBodies, [
      {
        conversationId: "conversation-1",
        reasoning: "Gemini invoked read_file with the provided tool input.",
        actionTaken: "Ran read_file",
        result: "Tool returned a display summary.",
      },
    ]);

    const toolBodies = requests
      .filter(
        (request) =>
          request.init.method === "POST" && request.url === "https://memory.example.test/v1/reasoning/tool-calls",
      )
      .map((request) => JSON.parse(request.init.body));
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
    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/steps") {
        return jsonResponse({ id: "step-after-tool-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/tool-calls") {
        return jsonResponse({ id: "tool-call-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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

    const toolRequests = requests.filter(
      (request) =>
        request.init.method === "POST" && request.url === "https://memory.example.test/v1/reasoning/tool-calls",
    );
    assert.equal(toolRequests.length, 1);
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

    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/steps") {
        return jsonResponse({ id: "step-after-tool-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/tool-calls") {
        return jsonResponse({ id: "tool-call-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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

    const toolRequests = requests.filter(
      (request) =>
        request.init.method === "POST" && request.url === "https://memory.example.test/v1/reasoning/tool-calls",
    );
    assert.equal(toolRequests.length, 1);
    assert.equal(JSON.parse(toolRequests[0].init.body).stepId, "step-after-tool-1");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("stores Gemini AfterAgent prompt_response as an assistant message", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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
    const messageRequests = requests.filter(
      (request) =>
        request.init.method === "POST" &&
        request.url === "https://memory.example.test/v1/conversations/conversation-1/messages",
    );
    assert.deepEqual(JSON.parse(messageRequests.at(-1).init.body), {
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

    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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
    const messageRequests = requests.filter(
      (request) =>
        request.init.method === "POST" &&
        request.url === "https://memory.example.test/v1/conversations/conversation-1/messages",
    );
    assert.deepEqual(JSON.parse(messageRequests.at(-1).init.body), {
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

    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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

    const assistantMessageBodies = requests
      .filter(
        (request) =>
          request.init.method === "POST" &&
          request.url === "https://memory.example.test/v1/conversations/conversation-1/messages",
      )
      .map((request) => JSON.parse(request.init.body))
      .filter((body) => body.role === "assistant");
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

    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/steps") {
        return jsonResponse({ id: "step-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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

    const reasoningBodies = requests
      .filter(
        (request) =>
          request.init.method === "POST" && request.url === "https://memory.example.test/v1/reasoning/steps",
      )
      .map((request) => JSON.parse(request.init.body));
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

    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/steps") {
        return jsonResponse({ id: "step-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/tool-calls") {
        return jsonResponse({ id: "tool-call-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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
    const reasoningRequest = requests.find(
      (request) =>
        request.init.method === "POST" && request.url === "https://memory.example.test/v1/reasoning/steps",
    );
    assert.deepEqual(JSON.parse(reasoningRequest.init.body), {
      conversationId: "conversation-1",
      reasoning: "Searching official guidance",
      actionTaken: "Researching",
    });

    const toolRequest = requests.find(
      (request) =>
        request.init.method === "POST" && request.url === "https://memory.example.test/v1/reasoning/tool-calls",
    );
    const toolBody = JSON.parse(toolRequest.init.body);
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

test("records tool calls with repeated Gemini ids from different transcript entries", async () => {
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

    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/tool-calls") {
        return jsonResponse({ id: "tool-call-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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

    const toolBodies = requests
      .filter(
        (request) =>
          request.init.method === "POST" && request.url === "https://memory.example.test/v1/reasoning/tool-calls",
      )
      .map((request) => JSON.parse(request.init.body));
    assert.equal(toolBodies.length, 2);
    assert.match(toolBodies[0].input, /"query":"autonomo spain"/);
    assert.match(toolBodies[1].input, /"query":"autonomo portugal"/);
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

    const requests = [];
    let failToolCall = true;
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/steps") {
        return jsonResponse({ id: "step-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/tool-calls") {
        if (failToolCall) {
          failToolCall = false;
          return jsonResponse({ error: "temporary failure" }, 503);
        }
        return jsonResponse({ id: "tool-call-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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

    const successfulToolBody = requests
      .filter(
        (request) =>
          request.init.method === "POST" && request.url === "https://memory.example.test/v1/reasoning/tool-calls",
      )
      .map((request) => JSON.parse(request.init.body))
      .at(-1);
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

    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/steps") {
        return jsonResponse({ id: "step-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/tool-calls") {
        return jsonResponse({ id: "tool-call-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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

    const toolBody = requests
      .filter(
        (request) =>
          request.init.method === "POST" && request.url === "https://memory.example.test/v1/reasoning/tool-calls",
      )
      .map((request) => JSON.parse(request.init.body))
      .at(-1);
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

    const requests = [];
    let stepCount = 0;
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/steps") {
        stepCount += 1;
        return jsonResponse({ id: `step-${stepCount}` }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/tool-calls") {
        return jsonResponse({ id: "tool-call-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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

    const toolBody = requests
      .filter(
        (request) =>
          request.init.method === "POST" && request.url === "https://memory.example.test/v1/reasoning/tool-calls",
      )
      .map((request) => JSON.parse(request.init.body))
      .at(-1);
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

    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://memory.example.test/v1/conversations") {
        return jsonResponse({ id: "conversation-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/context") {
        return jsonResponse({});
      }
      if (url === "https://memory.example.test/v1/conversations/conversation-1/messages") {
        return jsonResponse({ id: "message-1" }, 201);
      }
      if (url === "https://memory.example.test/v1/reasoning/tool-calls") {
        return jsonResponse({ id: "tool-call-1" }, 201);
      }
      return jsonResponse({ error: `unexpected ${init.method} ${url}` }, 500);
    };

    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: mockFetch,
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

    const toolBodies = requests
      .filter(
        (request) =>
          request.init.method === "POST" && request.url === "https://memory.example.test/v1/reasoning/tool-calls",
      )
      .map((request) => JSON.parse(request.init.body));
    assert.equal(toolBodies.length, 1);
    assert.equal(toolBodies[0].status, "running");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

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
