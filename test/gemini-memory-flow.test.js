import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
