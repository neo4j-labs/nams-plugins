import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { NamsRequestEvent } from "../src/generated/nams-client.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedClientPath = path.join(repoRoot, ".build", "tsc", "generated", "nams-client.js");
const generatedClientUrl = pathToFileURL(generatedClientPath).href;

type GeneratedClientModule = typeof import("../src/generated/nams-client.js");

interface ExpectedEndpoint {
  methodName: string;
  httpMethod: "GET" | "POST";
  path: string;
}

interface OpenApiOperation {
  responses?: Record<string, { schema?: { $ref?: string } }>;
}

interface OpenApiSpec {
  paths: Record<string, Partial<Record<Lowercase<ExpectedEndpoint["httpMethod"]>, OpenApiOperation>>>;
}

interface CapturedRequest {
  url: string | URL | Request;
  init: RequestInit & {
    body?: string;
    headers: Record<string, string>;
    method: string;
  };
}

async function importGeneratedClient(): Promise<GeneratedClientModule> {
  return (await import(generatedClientUrl)) as GeneratedClientModule;
}

const expectedWorkspaceEndpoints: ExpectedEndpoint[] = [
  { methodName: "listMyWorkspaces", httpMethod: "GET", path: "/v1/users/me/workspaces" },
];

test("generated NAMS workspace client endpoint table matches the pinned OpenAPI spec", async () => {
  const spec = JSON.parse(await readFile(path.join(repoRoot, "docs", "nams-openapi.json"), "utf8")) as OpenApiSpec;
  const { NAMS_WORKSPACE_CLIENT_ENDPOINTS } = await importGeneratedClient();

  assert.deepEqual(NAMS_WORKSPACE_CLIENT_ENDPOINTS, expectedWorkspaceEndpoints);
  for (const endpoint of expectedWorkspaceEndpoints) {
    const httpMethod = endpoint.httpMethod.toLowerCase() as Lowercase<ExpectedEndpoint["httpMethod"]>;
    const operation = spec.paths[endpoint.path]?.[httpMethod];
    assert.ok(operation, `expected ${endpoint.httpMethod} ${endpoint.path} in OpenAPI spec`);
    assert.match(operation.responses?.["200"]?.schema?.$ref ?? "", /^#\/definitions\//);
  }
});

test("generated NAMS workspace client requires an explicit base URL", async () => {
  const { NamsWorkspaceClient } = await importGeneratedClient();

  assert.throws(
    () =>
      new NamsWorkspaceClient({
        apiKey: "test-key",
      } as ConstructorParameters<typeof NamsWorkspaceClient>[0]),
    /requires a baseUrl/,
  );
});

test("generated NAMS workspace client lists workspaces without a workspace header", async () => {
  const { NamsWorkspaceClient } = await importGeneratedClient();
  const requests: CapturedRequest[] = [];
  const client = new NamsWorkspaceClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test/",
    defaultHeaders: {
      "X-NAMS-Hooks-Harness": "gemini",
      "X-Workspace-Id": "wrong-workspace",
      Authorization: "Bearer wrong-key",
      Accept: "text/plain",
      "Content-Type": "text/plain",
    },
    fetch: async (url, init) => {
      requests.push({ url, init: init as CapturedRequest["init"] });
      return new Response(JSON.stringify({ workspaces: [{ id: "workspace-1", name: "Test workspace" }] }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    },
  });

  const response = await client.listMyWorkspaces();

  assert.deepEqual(response, { workspaces: [{ id: "workspace-1", name: "Test workspace" }] });
  assert.equal(requests[0].url, "https://memory.example.test/v1/users/me/workspaces");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers.Authorization, "Bearer test-key");
  assert.equal(requests[0].init.headers.Accept, "application/json");
  assert.equal(requests[0].init.headers["X-NAMS-Hooks-Harness"], "gemini");
  assert.equal(requests[0].init.headers["X-Workspace-Id"], undefined);
  assert.equal(requests[0].init.headers["Content-Type"], undefined);
  assert.equal(requests[0].init.body, undefined);
});

test("generated NAMS workspace client request logs omit secret and workspace headers", async () => {
  const { NamsWorkspaceClient } = await importGeneratedClient();
  const events: NamsRequestEvent[] = [];
  const client = new NamsWorkspaceClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test",
    defaultHeaders: {
      "X-Workspace-Id": "wrong-workspace",
      Authorization: "Bearer wrong-key",
      "X-Api-Key": "secret-api-key",
    },
    onRequest: (event) => {
      events.push(event);
      throw new Error("logger unavailable");
    },
    fetch: async () =>
      new Response(JSON.stringify({ workspaces: [] }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
  });

  const response = await client.listMyWorkspaces();

  assert.deepEqual(response, { workspaces: [] });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "listMyWorkspaces");
  assert.equal(events[0].method, "GET");
  assert.equal(events[0].path, "/v1/users/me/workspaces");
  assert.deepEqual(events[0].request, {
    method: "GET",
    url: "https://memory.example.test/v1/users/me/workspaces",
    path: "/v1/users/me/workspaces",
    headers: {
      Accept: "application/json",
    },
  });
  assert.doesNotMatch(JSON.stringify(events[0]), /Authorization|Bearer|test-key|secret-api-key|X-Api-Key|X-Workspace-Id/i);
});

test("generated NAMS workspace client endpoint table contains only workspace infrastructure paths", async () => {
  const { NAMS_WORKSPACE_CLIENT_ENDPOINTS } = await importGeneratedClient();

  assert.deepEqual(
    NAMS_WORKSPACE_CLIENT_ENDPOINTS.map((endpoint) => endpoint.path),
    ["/v1/users/me/workspaces"],
  );
});
