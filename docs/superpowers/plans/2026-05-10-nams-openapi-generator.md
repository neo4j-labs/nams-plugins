# NAMS OpenAPI Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a build-time custom OpenAPI generator that emits a focused dependency-free `NamsClient` from `docs/nams-openapi.json`.

**Architecture:** The generator is a Node.js build script under `scripts/` that reads the pinned Swagger/OpenAPI 2 spec, validates the NAMS endpoints used by hooks, and writes `src/generated/nams-client.ts`. Runtime code imports the generated client; it never reads OpenAPI. Tests verify endpoint metadata, request shaping, and error behavior without writing generated files into the project during test execution.

**Tech Stack:** Node.js built-ins, TypeScript source, generated TypeScript client, Node's built-in `node:test`.

---

## File Structure

- Create: `scripts/generate-nams-client.mjs`
  - Reads `docs/nams-openapi.json`.
  - Validates a small endpoint manifest.
  - Renders `src/generated/nams-client.ts`.
  - Supports `--check` to compare generated output with the committed file without writing.
- Create: `src/generated/nams-client.ts`
  - Committed generated source.
  - Exposes `NamsClient`, `NamsClientError`, endpoint metadata, request/response types, and hook-facing NAMS methods.
- Create: `test/nams-client-generator.test.js`
  - Imports compiled generated client from `.build/tsc/generated/nams-client.js`.
  - Reads `docs/nams-openapi.json`.
  - Does not write files.
- Modify: `package.json`
  - Adds `openapi:generate`, `openapi:check`, `test:contract`, and `package:check`.
- Modify: `scripts/build-dist.mjs`
  - No change expected if it copies all compiled `.build/tsc` output into `dist/bin/`; verify generated client lands in `dist/bin/generated/nams-client.js`.

Use the custom spike as the implementation baseline:

```bash
git show spike-custom-nams-client:scripts/generate-nams-client.mjs
git show spike-custom-nams-client:src/generated/nams-client.ts
git show spike-custom-nams-client:test/nams-client-generator.test.js
```

Do not copy the Hey API spike into the implementation branch.

### Task 1: Contract Tests First

**Files:**
- Create: `test/nams-client-generator.test.js`

- [ ] **Step 1: Write the failing contract/runtime tests**

Create `test/nams-client-generator.test.js` with these tests:

```js
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
```

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run build && npm test
```

Expected: FAIL because `.build/tsc/generated/nams-client.js` does not exist.

### Task 2: Add The Custom Generator

**Files:**
- Create: `scripts/generate-nams-client.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add package scripts**

Add these scripts to `package.json`:

```json
{
  "openapi:generate": "node scripts/generate-nams-client.mjs",
  "openapi:check": "node scripts/generate-nams-client.mjs --check",
  "test:contract": "npm run build && node --test test/nams-client-generator.test.js",
  "package:check": "npm run openapi:check && npm run check && npm run dist"
}
```

Keep the existing `build`, `test`, `check`, and `dist` scripts.

- [ ] **Step 2: Add generator script from the custom spike**

Create `scripts/generate-nams-client.mjs` using the custom spike as the baseline. Preserve these design points:

```js
const endpoints = [
  { methodName: "createConversation", httpMethod: "POST", path: "/v1/conversations", successStatus: "201", bodyRequired: false },
  { methodName: "addMessage", httpMethod: "POST", path: "/v1/conversations/{id}/messages", successStatus: "201", bodyRequired: true, pathArgs: [{ argumentName: "conversationId", parameterName: "id" }] },
  { methodName: "addMessagesBulk", httpMethod: "POST", path: "/v1/conversations/{id}/messages/bulk", successStatus: "201", bodyRequired: true, pathArgs: [{ argumentName: "conversationId", parameterName: "id" }] },
  { methodName: "getConversationContext", httpMethod: "GET", path: "/v1/conversations/{id}/context", successStatus: "200", pathArgs: [{ argumentName: "conversationId", parameterName: "id" }] },
  { methodName: "searchConversationMessages", httpMethod: "POST", path: "/v1/conversations/{id}/search", successStatus: "200", bodyRequired: true, pathArgs: [{ argumentName: "conversationId", parameterName: "id" }] },
  { methodName: "searchEntities", httpMethod: "POST", path: "/v1/entities/search", successStatus: "200", bodyRequired: true },
  { methodName: "recordReasoningStep", httpMethod: "POST", path: "/v1/reasoning/steps", successStatus: "201", bodyRequired: true },
  { methodName: "recordToolCall", httpMethod: "POST", path: "/v1/reasoning/tool-calls", successStatus: "201", bodyRequired: true },
];
```

The script must:

- parse `docs/nams-openapi.json`
- validate each endpoint exists
- validate configured path parameters exist as required string parameters
- validate body schemas exist for body-required endpoints
- validate success response schemas exist
- render the generated client source in memory
- write to `src/generated/nams-client.ts` by default
- with `--check`, compare rendered output to the committed generated file and exit nonzero if stale

Use this `--check` behavior:

```js
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== source) {
    throw new Error("src/generated/nams-client.ts is stale. Run npm run openapi:generate.");
  }
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source, "utf8");
}
```

- [ ] **Step 3: Run generator**

Run:

```bash
npm run openapi:generate
```

Expected: creates `src/generated/nams-client.ts`.

### Task 3: Generated Client Contract

**Files:**
- Create: `src/generated/nams-client.ts`

- [ ] **Step 1: Verify generated client shape**

Inspect `src/generated/nams-client.ts` and confirm it exports:

```ts
export interface NamsClientOptions {
  baseUrl?: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export class NamsClientError extends Error {
  readonly status: number;
  readonly body: unknown;
}

export const NAMS_CLIENT_ENDPOINTS = [
  { methodName: "createConversation", httpMethod: "POST", path: "/v1/conversations" },
  { methodName: "addMessage", httpMethod: "POST", path: "/v1/conversations/{id}/messages" },
  { methodName: "addMessagesBulk", httpMethod: "POST", path: "/v1/conversations/{id}/messages/bulk" },
  { methodName: "getConversationContext", httpMethod: "GET", path: "/v1/conversations/{id}/context" },
  { methodName: "searchConversationMessages", httpMethod: "POST", path: "/v1/conversations/{id}/search" },
  { methodName: "searchEntities", httpMethod: "POST", path: "/v1/entities/search" },
  { methodName: "recordReasoningStep", httpMethod: "POST", path: "/v1/reasoning/steps" },
  { methodName: "recordToolCall", httpMethod: "POST", path: "/v1/reasoning/tool-calls" },
] as const;
```

- [ ] **Step 2: Verify green**

Run:

```bash
npm run check
```

Expected: PASS with the existing hook tests plus the new generated-client tests.

- [ ] **Step 3: Verify generated output is fresh**

Run:

```bash
npm run openapi:check
```

Expected: PASS with no file changes.

### Task 4: Distribution Verification

**Files:**
- Modify only if needed: `scripts/build-dist.mjs`

- [ ] **Step 1: Build local distribution**

Run:

```bash
npm run dist
```

Expected: PASS.

- [ ] **Step 2: Confirm generated runtime is included**

Run:

```bash
test -f dist/bin/generated/nams-client.js
```

Expected: exit code 0.

- [ ] **Step 3: Confirm source OpenAPI is not imported by compiled runtime**

Run:

```bash
rg "nams-openapi|readFile" dist/bin/generated/nams-client.js
```

Expected: no matches.

If `dist/bin/generated/nams-client.js` is missing, update `scripts/build-dist.mjs` so the compiled `.build/tsc/generated/` directory is copied into `dist/bin/generated/`.

### Task 5: Final Verification And Commit

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` only if npm rewrites it
- Create: `scripts/generate-nams-client.mjs`
- Create: `src/generated/nams-client.ts`
- Create: `test/nams-client-generator.test.js`

- [ ] **Step 1: Run package verification**

Run:

```bash
npm run package:check
```

Expected:

- `openapi:check` passes
- TypeScript build passes
- Node tests pass
- `npm run dist` creates the Gemini-linkable tree

- [ ] **Step 2: Confirm tests did not create project `.nams` artifacts**

Run:

```bash
find . -maxdepth 2 -type d -name .nams -print
```

Expected: no output.

- [ ] **Step 3: Review diff**

Run:

```bash
git diff --stat
git diff -- package.json scripts/generate-nams-client.mjs test/nams-client-generator.test.js
```

Expected: changes are limited to generator, generated client, tests, and package scripts.

- [ ] **Step 4: Commit**

Run:

```bash
git add package.json package-lock.json scripts/generate-nams-client.mjs src/generated/nams-client.ts test/nams-client-generator.test.js
git commit -m "feat: add generated nams client"
```

## Self-Review

- Spec coverage: Implements the custom generator baseline from `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`.
- Runtime boundary: Generated client does not import OpenAPI, read files, or discover endpoints at runtime.
- Test hygiene: Tests read fixtures and use mocked fetch only; they do not write `.nams/` or generated files into the project.
- Distribution coverage: `npm run dist` must include `dist/bin/generated/nams-client.js`.
