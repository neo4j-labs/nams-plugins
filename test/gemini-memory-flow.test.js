import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const geminiUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "gemini.js")).href;
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
      role: "user",
      content: prompt,
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("stores Gemini BeforeAgent user prompt when recall fails", async () => {
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

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
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
    const logPath = path.join(projectDir, ".nams", "logs", "gemini-beforeagent.jsonl");
    const log = await readFile(logPath, "utf8");
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
    const logPath = path.join(projectDir, ".nams", "logs", "gemini-beforeagent.jsonl");
    const log = await readFile(logPath, "utf8");
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
    const logPath = path.join(projectDir, ".nams", "logs", "gemini-beforeagent.jsonl");
    const log = await readFile(logPath, "utf8");
    assert.match(log, /NAMS request failed/);
    assert.doesNotMatch(log, /Authorization|Bearer|NAMS_API_KEY|content secret|do not log me/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini BeforeAgent platform log redacts raw prompt fields", async () => {
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
        user_prompt: "raw snake prompt secret",
        userPrompt: "raw camel prompt secret",
      },
    });

    const logPath = path.join(projectDir, ".nams", "logs", "gemini-before-agent.jsonl");
    const log = await readFile(logPath, "utf8");
    assert.match(log, /session-1/);
    assert.match(log, new RegExp(escapeRegExp(projectDir)));
    assert.match(log, /"prompt":"\[redacted\]"/);
    assert.match(log, /"user_prompt":"\[redacted\]"/);
    assert.match(log, /"userPrompt":"\[redacted\]"/);
    assert.doesNotMatch(log, /raw prompt secret|raw snake prompt secret|raw camel prompt secret/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini AfterAgent platform log redacts raw assistant response fields", async () => {
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

    const logPath = path.join(projectDir, ".nams", "logs", "gemini-after-agent.jsonl");
    const log = await readFile(logPath, "utf8");
    assert.match(log, /session-1/);
    assert.match(log, new RegExp(escapeRegExp(projectDir)));
    assert.match(log, /"prompt_response":"\[redacted\]"/);
    assert.match(log, /"promptResponse":"\[redacted\]"/);
    assert.match(log, /"response":"\[redacted\]"/);
    assert.match(log, /"content":"\[redacted\]"/);
    assert.doesNotMatch(
      log,
      /raw assistant response secret|raw camel response secret|raw response secret|raw content secret/,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini AfterTool platform log redacts raw tool output fields", async () => {
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
    const logPath = path.join(projectDir, ".nams", "logs", "gemini-after-tool.jsonl");
    const log = await readFile(logPath, "utf8");
    assert.match(log, /read_file/);
    assert.match(log, /metadata/);
    assert.match(log, /"tool_output":"\[redacted\]"/);
    assert.match(log, /"output":"\[redacted\]"/);
    assert.match(log, /"result":"\[redacted\]"/);
    assert.match(log, /"resultDisplay":"\[redacted\]"/);
    assert.match(log, /"functionResponse":"\[redacted\]"/);
    assert.doesNotMatch(
      log,
      /raw tool output secret|raw output secret|raw result secret|raw display secret|raw function response secret|nested output secret|nested result secret/,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Gemini platform log redacts nested secret, header, and body fields", async () => {
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

    const logPath = path.join(projectDir, ".nams", "logs", "gemini-before-agent.jsonl");
    const log = await readFile(logPath, "utf8");
    assert.match(log, /session-1/);
    assert.match(log, /"Authorization":"\[redacted\]"/);
    assert.match(log, /"headers":"\[redacted\]"/);
    assert.match(log, /"apiKey":"\[redacted\]"/);
    assert.match(log, /"api_key":"\[redacted\]"/);
    assert.match(log, /"secret":"\[redacted\]"/);
    assert.match(log, /"body":"\[redacted\]"/);
    assert.match(log, /"NAMS_API_KEY":"\[redacted\]"/);
    assert.match(log, /"access_token":"\[redacted\]"/);
    assert.match(log, /"refreshToken":"\[redacted\]"/);
    assert.match(log, /"bearerToken":"\[redacted\]"/);
    assert.match(log, /"client_secret":"\[redacted\]"/);
    assert.match(log, /"x-api-key":"\[redacted\]"/);
    assert.match(log, /"password":"\[redacted\]"/);
    assert.match(log, /"request_body":"\[redacted\]"/);
    assert.match(log, /"requestBody":"\[redacted\]"/);
    assert.match(log, /"response_body":"\[redacted\]"/);
    assert.match(log, /"responseBody":"\[redacted\]"/);
    assert.match(log, /"tool_result":"\[redacted\]"/);
    assert.match(log, /"toolResult":"\[redacted\]"/);
    assert.match(log, /"assistant_response":"\[redacted\]"/);
    assert.match(log, /"assistantResponse":"\[redacted\]"/);
    assert.match(log, /"model_output":"\[redacted\]"/);
    assert.match(log, /"tool_response":"\[redacted\]"/);
    assert.doesNotMatch(
      log,
      /Bearer header secret|Bearer nested header secret|nested token secret|camel api secret|snake api secret|plain secret value|body content secret|raw prompt secret|nams api key secret|access token secret|refresh token secret|bearer token secret|client secret value|x api key secret|password secret|request body secret|camel request body secret|response body secret|camel response body secret|tool result secret|camel tool result secret|assistant response secret|camel assistant response secret|model output secret|tool response secret/,
    );
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
