import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "memory-service.js")).href;

test("createConversation sends minimal Gemini metadata and returns conversation id", async () => {
  const requests = [];
  const { NamsMemoryService } = await import(serviceUrl);
  const service = new NamsMemoryService({
    apiKey: "key",
    baseUrl: "https://memory.example.test",
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

test("recordToolCall serializes sanitized capped input and omits tool output", async () => {
  const requests = [];
  const { NamsMemoryService } = await import(serviceUrl);
  const service = new NamsMemoryService({
    apiKey: "key",
    baseUrl: "https://memory.example.test",
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
        functionResponse: { output: "hidden tool output" },
        keep: "metadata",
      },
      resultDisplay: "rendered result",
      long: "x".repeat(5000),
    },
    status: "success",
    durationMs: 123,
  });

  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.toolName, "google_web_search");
  assert.equal(body.stepId, "step-1");
  assert.equal(body.status, "success");
  assert.equal(body.durationMs, 123);
  assert.equal(body.output, "");
  assert.equal(body.input.length, 4000);
  assert.match(body.input, /\.\.\.\[truncated\]$/);
  assert.match(body.input, /"query":"autonomo spain"/);
  assert.match(body.input, /"keep":"metadata"/);
  assert.doesNotMatch(body.input, /raw command output|hidden tool output|rendered result/);
  assert.doesNotMatch(body.input, /"result"|"resultDisplay"|"functionResponse"/);
});
