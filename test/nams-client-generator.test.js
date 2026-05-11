import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedClientPath = path.join(repoRoot, ".build", "tsc", "generated", "nams-client.js");
const generatedClientUrl = pathToFileURL(generatedClientPath).href;
const generatorScriptPath = path.join(repoRoot, "scripts", "generate-nams-client.mjs");
const execFileAsync = promisify(execFile);
const expectedEndpoints = [
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
  const spec = JSON.parse(await readFile(path.join(repoRoot, "docs", "nams-openapi.json"), "utf8"));
  const { NAMS_CLIENT_ENDPOINTS } = await import(generatedClientUrl);

  assert.deepEqual(NAMS_CLIENT_ENDPOINTS, expectedEndpoints.map(toPublicEndpoint));
  for (const endpoint of expectedEndpoints) {
    const operation = spec.paths[endpoint.path]?.[endpoint.httpMethod.toLowerCase()];
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
    (error) => {
      assert.match(error.stderr, /missing pathArgs for id/);
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
    (error) => {
      assert.match(error.stderr, /extra pathArgs for id/);
      return true;
    },
  );
});

async function runGeneratorWithManifestMutation(mutateSource) {
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
  const { NamsClient } = await import(generatedClientUrl);
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

test("generated NAMS client reports sanitized request metadata", async () => {
  const { NamsClient } = await import(generatedClientUrl);
  const events = [];
  const client = new NamsClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test",
    onRequest: (event) => {
      events.push(event);
    },
    fetch: async () =>
      new Response(JSON.stringify({ id: "message-1" }), {
        headers: { "Content-Type": "application/json" },
        status: 201,
      }),
  });

  await client.addMessage("conversation-1", { role: "user", content: "hello" });

  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ["durationMs", "method", "ok", "operation", "path", "status"]);
  assert.equal(events[0].operation, "addMessage");
  assert.equal(events[0].method, "POST");
  assert.equal(events[0].path, "/v1/conversations/{id}/messages");
  assert.equal(events[0].status, 201);
  assert.equal(events[0].ok, true);
  assert.equal(typeof events[0].durationMs, "number");
});

test("generated NAMS client reports failed request metadata before throwing", async () => {
  const { NamsClient, NamsClientError } = await import(generatedClientUrl);
  const events = [];
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
});

test("generated NAMS client reports network failure metadata before throwing", async () => {
  const { NamsClient } = await import(generatedClientUrl);
  const events = [];
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
  assert.deepEqual(Object.keys(events[0]).sort(), ["durationMs", "method", "ok", "operation", "path"]);
  assert.equal(events[0].operation, "getConversationContext");
  assert.equal(events[0].method, "GET");
  assert.equal(events[0].path, "/v1/conversations/{id}/context");
  assert.equal(events[0].ok, false);
  assert.equal(typeof events[0].durationMs, "number");
});

test("generated NAMS client encodes path parameters", async () => {
  const { NamsClient } = await import(generatedClientUrl);
  const requests = [];
  const client = new NamsClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test",
    fetch: async (url, init) => {
      requests.push({ url, init });
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
  const { NamsClient } = await import(generatedClientUrl);
  const requests = [];
  const client = new NamsClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test",
    fetch: async (url, init) => {
      requests.push({ url, init });
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
  const { NamsClient, NamsClientError } = await import(generatedClientUrl);
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

function toPublicEndpoint({ methodName, httpMethod, path }) {
  return { methodName, httpMethod, path };
}

function pathPlaceholders(endpointPath) {
  return [...endpointPath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}
