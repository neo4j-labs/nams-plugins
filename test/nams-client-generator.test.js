import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedClientPath = path.join(repoRoot, ".build", "tsc", "generated", "nams-client.js");
const expectedEndpoints = [
  { methodName: "createConversation", httpMethod: "POST", path: "/v1/conversations" },
  { methodName: "addMessage", httpMethod: "POST", path: "/v1/conversations/{id}/messages" },
  { methodName: "addMessagesBulk", httpMethod: "POST", path: "/v1/conversations/{id}/messages/bulk" },
  { methodName: "getConversationContext", httpMethod: "GET", path: "/v1/conversations/{id}/context" },
  { methodName: "searchConversationMessages", httpMethod: "POST", path: "/v1/conversations/{id}/search" },
  { methodName: "searchEntities", httpMethod: "POST", path: "/v1/entities/search" },
  { methodName: "recordReasoningStep", httpMethod: "POST", path: "/v1/reasoning/steps" },
  { methodName: "recordToolCall", httpMethod: "POST", path: "/v1/reasoning/tool-calls" },
];

test("generated NAMS client endpoint table matches the pinned OpenAPI spec", async () => {
  const spec = JSON.parse(await readFile(path.join(repoRoot, "docs", "nams-openapi.json"), "utf8"));
  const { NAMS_CLIENT_ENDPOINTS } = await import(generatedClientPath);

  assert.deepEqual(NAMS_CLIENT_ENDPOINTS, expectedEndpoints);
  for (const endpoint of NAMS_CLIENT_ENDPOINTS) {
    const operation = spec.paths[endpoint.path]?.[endpoint.httpMethod.toLowerCase()];
    assert.ok(operation, `expected ${endpoint.httpMethod} ${endpoint.path} in OpenAPI spec`);
  }
});

test("generated NAMS client source does not read OpenAPI at runtime", async () => {
  const source = await readFile(path.join(repoRoot, "src", "generated", "nams-client.ts"), "utf8");

  assert.doesNotMatch(source, /nams-openapi\.json/);
  assert.doesNotMatch(source, /readFile/);
});

test("generated NAMS client sends bearer JSON requests", async () => {
  const { NamsClient } = await import(generatedClientPath);
  const requests = [];
  const client = new NamsClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test/",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ id: "conversation-1" }), {
        headers: { "Content-Type": "application/json" },
        status: 201,
      });
    },
  });

  const response = await client.createConversation({ userId: "user-1" });

  assert.deepEqual(response, { id: "conversation-1" });
  assert.equal(requests[0].url, "https://memory.example.test/v1/conversations");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer test-key");
  assert.equal(requests[0].init.headers["Content-Type"], "application/json");
  assert.equal(requests[0].init.body, JSON.stringify({ userId: "user-1" }));
});

test("generated NAMS client throws stable NAMS errors", async () => {
  const { NamsClient, NamsClientError } = await import(generatedClientPath);
  const client = new NamsClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test",
    fetch: async () =>
      new Response(JSON.stringify({ error: "workspace_id required" }), {
        headers: { "Content-Type": "application/json" },
        status: 400,
      }),
  });

  await assert.rejects(
    () => client.createConversation(),
    (error) =>
      error instanceof NamsClientError &&
      error.status === 400 &&
      error.message === "workspace_id required",
  );
});
