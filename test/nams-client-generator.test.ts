import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { NamsRequestEvent } from "../src/generated/nams-client.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedClientPath = path.join(repoRoot, ".build", "tsc", "generated", "nams-client.js");
const generatedClientUrl = pathToFileURL(generatedClientPath).href;
const generatorScriptPath = path.join(repoRoot, "scripts", "generate-nams-client.mjs");
const execFileAsync = promisify(execFile);

type GeneratedClientModule = typeof import("../src/generated/nams-client.js");

interface ExpectedEndpoint {
  methodName: string;
  httpMethod: "GET" | "POST";
  path: string;
  successStatus: string;
  bodyRequired: boolean;
  pathArgs: Array<{ parameterName: string }>;
}

interface OpenApiParameter {
  in: string;
  name: string;
  required?: boolean;
  type?: string;
  schema?: { $ref?: string };
}

interface OpenApiOperation {
  parameters?: OpenApiParameter[];
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

const expectedEndpoints: ExpectedEndpoint[] = [
  {
    methodName: "createConversation",
    httpMethod: "POST",
    path: "/v1/conversations",
    successStatus: "201",
    bodyRequired: false,
    pathArgs: [],
  },
  {
    methodName: "addMessage",
    httpMethod: "POST",
    path: "/v1/conversations/{id}/messages",
    successStatus: "201",
    bodyRequired: true,
    pathArgs: [{ parameterName: "id" }],
  },
  {
    methodName: "addMessagesBulk",
    httpMethod: "POST",
    path: "/v1/conversations/{id}/messages/bulk",
    successStatus: "201",
    bodyRequired: true,
    pathArgs: [{ parameterName: "id" }],
  },
  {
    methodName: "getConversationContext",
    httpMethod: "GET",
    path: "/v1/conversations/{id}/context",
    successStatus: "200",
    bodyRequired: false,
    pathArgs: [{ parameterName: "id" }],
  },
  {
    methodName: "searchConversationMessages",
    httpMethod: "POST",
    path: "/v1/conversations/{id}/search",
    successStatus: "200",
    bodyRequired: true,
    pathArgs: [{ parameterName: "id" }],
  },
  {
    methodName: "searchEntities",
    httpMethod: "POST",
    path: "/v1/entities/search",
    successStatus: "200",
    bodyRequired: true,
    pathArgs: [],
  },
  {
    methodName: "recordReasoningStep",
    httpMethod: "POST",
    path: "/v1/reasoning/steps",
    successStatus: "201",
    bodyRequired: true,
    pathArgs: [],
  },
  {
    methodName: "recordToolCall",
    httpMethod: "POST",
    path: "/v1/reasoning/tool-calls",
    successStatus: "201",
    bodyRequired: true,
    pathArgs: [],
  },
];

test("generated NAMS client endpoint table matches the pinned OpenAPI spec", async () => {
  const spec = JSON.parse(await readFile(path.join(repoRoot, "docs", "nams-openapi.json"), "utf8")) as OpenApiSpec;
  const { NAMS_CLIENT_ENDPOINTS } = await importGeneratedClient();

  assert.deepEqual(NAMS_CLIENT_ENDPOINTS, expectedEndpoints.map(toPublicEndpoint));
  for (const endpoint of expectedEndpoints) {
    const httpMethod = endpoint.httpMethod.toLowerCase() as Lowercase<ExpectedEndpoint["httpMethod"]>;
    const operation = spec.paths[endpoint.path]?.[httpMethod];
    assert.ok(operation, `expected ${endpoint.httpMethod} ${endpoint.path} in OpenAPI spec`);

    const pathParameters = (operation.parameters ?? []).filter((parameter) => parameter.in === "path");
    assert.deepEqual(
      endpoint.pathArgs.map((pathArg) => pathArg.parameterName),
      pathPlaceholders(endpoint.path),
      `expected pathArgs to cover all placeholders for ${endpoint.methodName}`,
    );
    for (const pathArg of endpoint.pathArgs) {
      const parameter = pathParameters.find((candidate) => candidate.name === pathArg.parameterName);
      assert.equal(parameter?.required, true, `expected required path parameter ${pathArg.parameterName}`);
      assert.equal(parameter?.type, "string", `expected string path parameter ${pathArg.parameterName}`);
    }

    const bodyParameter = (operation.parameters ?? []).find((parameter) => parameter.in === "body");
    if (endpoint.bodyRequired) {
      assert.equal(bodyParameter?.required, true, `expected required body on ${endpoint.methodName}`);
      assert.match(bodyParameter?.schema?.$ref ?? "", /^#\/definitions\//);
    }
    assert.match(operation.responses?.[endpoint.successStatus]?.schema?.$ref ?? "", /^#\/definitions\//);
  }
});

test("generator rejects endpoint path placeholders missing from manifest args", async () => {
  await assert.rejects(
    () =>
      runGeneratorWithManifestMutation((source) =>
        source.replace(
          '    pathArgs: [{ argumentName: "conversationId", parameterName: "id" }],',
          "    pathArgs: [],",
        ),
      ),
    (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /missing pathArgs for id/);
      return true;
    },
  );
});

test("generator rejects manifest path args missing from endpoint path", async () => {
  await assert.rejects(
    () =>
      runGeneratorWithManifestMutation((source) =>
        source.replace(
          '    path: "/v1/entities/search",\n    successStatus: "200",',
          '    path: "/v1/entities/search",\n    pathArgs: [{ argumentName: "conversationId", parameterName: "id" }],\n    successStatus: "200",',
        ),
      ),
    (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /extra pathArgs for id/);
      return true;
    },
  );
});

async function runGeneratorWithManifestMutation(mutateSource: (source: string) => string): Promise<void> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nams-generator-"));
  try {
    const tempScriptPath = path.join(tempRoot, "scripts", "generate-nams-client.mjs");
    const tempSpecPath = path.join(tempRoot, "docs", "nams-openapi.json");
    await mkdir(path.dirname(tempScriptPath), { recursive: true });
    await mkdir(path.dirname(tempSpecPath), { recursive: true });

    const source = await readFile(generatorScriptPath, "utf8");
    const sourceWithBrokenManifest = mutateSource(source);
    assert.notEqual(sourceWithBrokenManifest, source, "expected fixture mutation to alter generator manifest");

    await writeFile(tempScriptPath, sourceWithBrokenManifest, "utf8");
    await writeFile(tempSpecPath, await readFile(path.join(repoRoot, "docs", "nams-openapi.json"), "utf8"), "utf8");

    await execFileAsync(process.execPath, [tempScriptPath], { cwd: tempRoot });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test("generated NAMS client source does not read OpenAPI at runtime", async () => {
  const source = await readFile(path.join(repoRoot, "src", "generated", "nams-client.ts"), "utf8");

  assert.doesNotMatch(source, /nams-openapi\.json/);
  assert.doesNotMatch(source, /readFile/);
});

test("generated NAMS client sends bearer JSON requests", async () => {
  const { NamsClient } = await importGeneratedClient();
  const requests: CapturedRequest[] = [];
  const client = new NamsClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test/",
    fetch: async (url, init) => {
      requests.push({ url, init: init as CapturedRequest["init"] });
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

test("generated NAMS client reports request and response details", async () => {
  const { NamsClient } = await importGeneratedClient();
  const events: NamsRequestEvent[] = [];
  const client = new NamsClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test",
    onRequest: (event) => {
      events.push(event);
    },
    fetch: async () =>
      new Response(JSON.stringify({ id: "message-1" }), {
        headers: { "Content-Type": "application/json", "X-NAMS-Trace": "trace-1" },
        status: 201,
      }),
  });

  await client.addMessage("conversation-1", { role: "user", content: "hello" });

  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "addMessage");
  assert.equal(events[0].method, "POST");
  assert.equal(events[0].path, "/v1/conversations/{id}/messages");
  assert.equal(events[0].status, 201);
  assert.equal(events[0].ok, true);
  assert.equal(typeof events[0].durationMs, "number");
  assert.deepEqual(events[0].request, {
    method: "POST",
    url: "https://memory.example.test/v1/conversations/conversation-1/messages",
    path: "/v1/conversations/{id}/messages",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: { role: "user", content: "hello" },
  });
  assert.deepEqual(events[0].response, {
    status: 201,
    ok: true,
    headers: {
      "content-type": "application/json",
      "x-nams-trace": "trace-1",
    },
    body: { id: "message-1" },
  });
  assert.doesNotMatch(JSON.stringify(events[0]), /Authorization|Bearer|test-key/);
});

test("generated NAMS client reports failed request and response before throwing", async () => {
  const { NamsClient, NamsClientError } = await importGeneratedClient();
  const events: NamsRequestEvent[] = [];
  const client = new NamsClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test",
    onRequest: (event) => {
      events.push(event);
    },
    fetch: async () =>
      new Response(JSON.stringify({ error: "workspace_id required" }), {
        headers: { "Content-Type": "application/json" },
        status: 400,
      }),
  });

  await assert.rejects(() => client.createConversation(), NamsClientError);

  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "createConversation");
  assert.equal(events[0].method, "POST");
  assert.equal(events[0].path, "/v1/conversations");
  assert.equal(events[0].status, 400);
  assert.equal(events[0].ok, false);
  assert.equal(typeof events[0].durationMs, "number");
  assert.deepEqual(events[0].request, {
    method: "POST",
    url: "https://memory.example.test/v1/conversations",
    path: "/v1/conversations",
    headers: {
      Accept: "application/json",
    },
  });
  assert.deepEqual(events[0].response, {
    status: 400,
    ok: false,
    headers: {
      "content-type": "application/json",
    },
    body: { error: "workspace_id required" },
  });
  assert.doesNotMatch(JSON.stringify(events[0]), /Authorization|Bearer|test-key/);
});

test("generated NAMS client reports network failure metadata before throwing", async () => {
  const { NamsClient } = await importGeneratedClient();
  const events: NamsRequestEvent[] = [];
  const client = new NamsClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test",
    onRequest: (event) => {
      events.push(event);
    },
    fetch: async () => {
      throw new Error("socket closed with Authorization: Bearer secret");
    },
  });

  await assert.rejects(() => client.getConversationContext("conversation-1"), /socket closed/);

  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "getConversationContext");
  assert.equal(events[0].method, "GET");
  assert.equal(events[0].path, "/v1/conversations/{id}/context");
  assert.equal(events[0].ok, false);
  assert.equal(typeof events[0].durationMs, "number");
  assert.deepEqual(events[0].request, {
    method: "GET",
    url: "https://memory.example.test/v1/conversations/conversation-1/context",
    path: "/v1/conversations/{id}/context",
    headers: {
      Accept: "application/json",
    },
  });
  assert.equal(events[0].response, undefined);
  assert.doesNotMatch(JSON.stringify(events[0]), /Authorization|Bearer|test-key/);
});

test("generated NAMS client encodes path parameters", async () => {
  const { NamsClient } = await importGeneratedClient();
  const requests: CapturedRequest[] = [];
  const client = new NamsClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test",
    fetch: async (url, init) => {
      requests.push({ url, init: init as CapturedRequest["init"] });
      return new Response(JSON.stringify({ id: "message-1" }), {
        headers: { "Content-Type": "application/json" },
        status: 201,
      });
    },
  });

  await client.addMessage("conversation/1", { role: "user", content: "hello" });

  assert.equal(requests[0].url, "https://memory.example.test/v1/conversations/conversation%2F1/messages");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.body, JSON.stringify({ role: "user", content: "hello" }));
});

test("generated NAMS client sends GET requests without JSON body headers", async () => {
  const { NamsClient } = await importGeneratedClient();
  const requests: CapturedRequest[] = [];
  const client = new NamsClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test",
    fetch: async (url, init) => {
      requests.push({ url, init: init as CapturedRequest["init"] });
      return new Response(JSON.stringify({ recentMessages: [] }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    },
  });

  await client.getConversationContext("conversation 1");

  assert.equal(requests[0].url, "https://memory.example.test/v1/conversations/conversation%201/context");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers["Content-Type"], undefined);
  assert.equal(requests[0].init.body, undefined);
});

test("generated NAMS client throws stable NAMS errors", async () => {
  const { NamsClient, NamsClientError } = await importGeneratedClient();
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

function toPublicEndpoint({
  methodName,
  httpMethod,
  path,
}: {
  methodName: string;
  httpMethod: string;
  path: string;
}): { methodName: string; httpMethod: string; path: string } {
  return { methodName, httpMethod, path };
}

function pathPlaceholders(endpointPath: string): string[] {
  return [...endpointPath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}
