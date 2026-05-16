import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "generated", "nams-client.js")).href;
const serviceUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "memory-service.js")).href;

async function createService(options) {
  const { NamsClient } = await import(clientUrl);
  const { NamsMemoryService } = await import(serviceUrl);
  return new NamsMemoryService(
    new NamsClient({
      apiKey: "key",
      baseUrl: "https://memory.example.test",
      ...options,
    }),
  );
}

test("createConversation sends minimal Gemini metadata and returns conversation id", async () => {
  const requests = [];
  const service = await createService({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ id: "conversation-1" }), { status: 201 });
    },
  });

  const conversationId = await service.createConversation({
    harness: "gemini",
    projectDirectory: "/project",
  });

  assert.equal(conversationId, "conversation-1");
  assert.equal(requests[0].url, "https://memory.example.test/v1/conversations");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    metadata: {
      harness: "gemini",
      projectDirectory: "/project",
    },
  });
});

test("formatMemoryContext formats memories for Gemini additionalContext", async () => {
  const { formatMemoryContext } = await import(serviceUrl);
  const context = formatMemoryContext({
    reflections: [{ content: "User prefers fixture-driven tests." }],
    observations: [{ content: "Project uses Node test runner." }],
    recentMessages: [{ role: "user", content: "Remember Gemini memory flow." }],
  });

  assert.match(context, /Relevant memory context:/);
  assert.match(context, /Reflections:\n- User prefers fixture-driven tests\./);
  assert.match(context, /Observations:\n- Project uses Node test runner\./);
  assert.match(context, /Recent messages:\n- user: Remember Gemini memory flow\./);
  assert.match(context, /Use this context silently when it is relevant\. Do not narrate memory mechanics\./);
  assert.equal(formatMemoryContext({}), "");
});

test("recordToolCall serializes sanitized capped input and sends explicit tool output", async () => {
  const requests = [];
  const service = await createService({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ id: "tool-call-1" }), { status: 201 });
    },
  });

  await service.recordToolCall({
    stepId: "step-1",
    toolName: "google_web_search",
    input: {
      query: "autonomo spain",
      payload: {
        result: "raw command output",
        output: "raw output value",
        tool_output: "raw snake output value",
        response: "raw response value",
        responseBody: "raw response body value",
        body: "raw body value",
        functionResponse: { output: "hidden tool output" },
        keep: "metadata",
      },
      resultDisplay: "rendered result",
      long: "x".repeat(5000),
    },
    output: "search result text",
    status: "success",
    durationMs: 123,
  });

  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.toolName, "google_web_search");
  assert.equal(body.stepId, "step-1");
  assert.equal(body.status, "success");
  assert.equal(body.durationMs, 123);
  assert.equal(body.output, "search result text");
  assert.equal(body.input.length, 4000);
  assert.match(body.input, /\.\.\.\[truncated\]$/);
  assert.match(body.input, /"query":"autonomo spain"/);
  assert.match(body.input, /"keep":"metadata"/);
  assert.doesNotMatch(
    body.input,
    /raw command output|raw output value|raw snake output value|raw response value|raw response body value|raw body value|hidden tool output|rendered result/,
  );
  assert.doesNotMatch(
    body.input,
    /"result"|"output"|"tool_output"|"response"|"responseBody"|"body"|"resultDisplay"|"functionResponse"/,
  );
});

test("recordToolCall serializes capped explicit tool output", async () => {
  const requests = [];
  const service = await createService({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ id: "tool-call-1" }), { status: 201 });
    },
  });

  await service.recordToolCall({
    toolName: "shell",
    input: {},
    output: "x".repeat(5000),
  });

  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.output.length, 4000);
  assert.match(body.output, /\.\.\.\[truncated\]$/);
});
