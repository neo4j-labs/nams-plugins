# NAMS Workspace Resolution Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve NAMS workspace IDs before conversation creation, auto-selecting single-workspace accounts for ordered harnesses while keeping memory persistence deterministic.

**Architecture:** Add a workspace-specific command and runtime resolver beside the existing memory hook flow. Keep the generated `NamsClient` as the workspace-scoped agent-memory client, add a separate generated `NamsWorkspaceClient` for NAMS infrastructure operations such as `GET /v1/users/me/workspaces`, persist single-workspace selections in session state, and have Gemini/OpenCode run workspace resolution before memory creation. Claude and Codex keep config-time workspace selection for this implementation because their first-prompt hooks are not ordered enough to split workspace and memory side effects.

**Tech Stack:** TypeScript, Node built-ins only at runtime, generated OpenAPI client, Node `node:test`, existing `fetch-mock` test support, Gemini/Claude/Codex hook JSON templates, OpenCode JavaScript plugin shim.

---

## Source Documents

- Spec: `docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md`
- Prior workspace ID plan: `docs/superpowers/plans/2026-06-03-nams-workspace-id.md`
- OpenAPI spec: `docs/nams-openapi.json`
- Architecture rules: `AGENTS.md`

## File Structure

- `scripts/generate-nams-client.mjs`: add endpoint metadata for `GET /v1/users/me/workspaces`, generate both the workspace-scoped `NamsClient` and the workspace-infrastructure `NamsWorkspaceClient`, and keep runtime OpenAPI-free.
- `src/generated/nams-client.ts`: generated output only. It may contain both generated client classes, but `NamsClient` and `NamsWorkspaceClient` must expose separate endpoint tables and constructor invariants. Do not hand-edit except through the generator.
- `src/interfaces.ts`: rename the existing memory hook adapter contract to `MemoryPlatformAdapter`, then add workspace hook event types, invocation/result interfaces, and `WorkspacePlatformAdapter` without changing memory hook event inference.
- `src/cli.ts`: parse workspace hook commands such as `nams-hooks workspaces gemini --event BeforeAgent` and configure commands such as `nams-hooks workspaces configure codex --scope project --workspace-id 11111111-1111-1111-1111-111111111111`.
- `src/platforms/index.ts`: expose a static workspace adapter registry beside the renamed memory adapter registry.
- `src/platforms/gemini/workspaces.ts`: Gemini-specific workspace hook output, including `decision: "deny"` for multi-workspace blocking.
- `src/platforms/opencode/workspaces.ts`: OpenCode workspace phase result for the plugin shim, single-workspace auto-resolution, and multi-workspace configuration-required output.
- `src/platforms/claude/workspaces.ts`: config-time `InstallConfigure` behavior and non-runtime first-prompt behavior.
- `src/platforms/codex/workspaces.ts`: config-time `InstallConfigure` behavior and non-runtime first-prompt behavior.
- `src/runtime/config.ts`: split config loading so API key/base URL can be loaded without requiring `workspaceId`.
- `src/runtime/config-writer.ts`: new JSON config writer for `nams-hooks workspaces configure`.
- `src/runtime/workspace-resolution.ts`: new shared workspace resolution flow, diagnostics, session-state updates, and `NamsWorkspaceClient` construction.
- `src/runtime/memory-service.ts`: keep memory service workspace-scoped and add a helper that refuses to build without an effective workspace ID.
- `src/runtime/session-state.ts`: add session-local workspace selection state.
- `src/runtime/logging.ts`: add fixed-shape workspace diagnostics while preserving secret redaction.
- `templates/gemini/hooks/hooks.json`: run workspace command before memory command in a `sequential: true` `BeforeAgent` group.
- `templates/gemini/gemini-extension.json`: mark workspace ID optional in the supported Gemini path.
- `templates/opencode/plugins/nams-hooks.js`: run the workspace phase before the memory phase for `chat.message`.
- `templates/claude/plugins/nams-hooks/hooks/hooks.json`: keep single memory hook; do not add sibling workspace hook.
- `templates/codex/plugins/codex-nams-hooks/hooks/hooks.json`: keep single memory hook; do not add sibling workspace hook.
- `templates/codex/hooks.json`: keep fallback single memory hook.
- `README.md` and `INSTALL.md`: document platform matrix and configure/setup behavior.

## Data Contracts

Use these names consistently across tasks:

```ts
export interface MemoryPlatformAdapter {
  startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult>;
  beforeAgent?(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult>;
  afterAgent?(invocation: HookInvocation<"AfterAgent">): Promise<HookResult>;
  afterTool?(invocation: HookInvocation<"AfterTool">): Promise<HookResult>;
}

export type WorkspaceHookEvent = "BeforeAgent" | "InstallConfigure";

export type WorkspaceSource =
  | "config"
  | "runtime-single-workspace"
  | "install-selection";

export interface SessionWorkspaceState {
  id: string;
  source: WorkspaceSource;
  selectedAt: string;
}

export interface WorkspaceHookInvocation<E extends WorkspaceHookEvent = WorkspaceHookEvent> {
  platform: Platform;
  event: E;
  rawPayload: Record<string, unknown>;
  processCwd: string;
}

export interface WorkspaceHookResult {
  stdout: Record<string, unknown>;
}
```

`MemoryPlatformAdapter` owns agent-memory operations and backs commands such as `nams-hooks run gemini --event BeforeAgent`. `WorkspacePlatformAdapter` owns workspace discovery/configuration and backs commands such as `nams-hooks workspaces gemini --event BeforeAgent`. Do not use a generic `PlatformAdapter` name after this plan is implemented.

Workspace list response shape from the pinned OpenAPI spec:

```ts
export interface WorkspaceListResponse {
  workspaces?: WorkspaceSummary[];
}

export interface WorkspaceSummary {
  dbMode?: string;
  id?: string;
  name?: string;
  role?: string;
  status?: string;
}
```

---

### Task 0: Rename Existing Platform Adapter Contract To MemoryPlatformAdapter

**Files:**
- Modify: `src/interfaces.ts`
- Modify: `src/platforms/index.ts`
- Modify: `src/platforms/gemini/index.ts`
- Modify: `src/platforms/claude/index.ts`
- Modify: `src/platforms/codex/index.ts`
- Modify: `src/platforms/opencode/index.ts`
- Modify: `src/cli.ts`
- Modify: `test/architecture.test.ts`

- [ ] **Step 1: Add failing architecture assertions for explicit memory adapter naming**

In `test/architecture.test.ts`, add assertions to the existing platform adapter tests:

```ts
test("memory platform adapter contract is named explicitly", async () => {
  const interfaceContent = await readFile("src/interfaces.ts", "utf8");
  const registryContent = await readFile("src/platforms/index.ts", "utf8");

  assert.match(interfaceContent, /\bexport interface MemoryPlatformAdapter\b/);
  assert.doesNotMatch(interfaceContent, /\bexport interface PlatformAdapter\b/);
  assert.match(registryContent, /\bgetMemoryPlatformAdapter\b/);
  assert.doesNotMatch(registryContent, /\bgetPlatformAdapter\b/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import=tsx --test test/architecture.test.ts
```

Expected: fail because the current contract is still named `PlatformAdapter`.

- [ ] **Step 3: Rename shared memory adapter types**

In `src/interfaces.ts`, rename:

```ts
export interface PlatformAdapter {
```

to:

```ts
export interface MemoryPlatformAdapter {
```

Keep the existing `HookInvocation`, `HookEvent`, and method names unchanged. This rename is intentionally narrow: it changes the memory adapter contract name, not the event model or platform payload parsing.

- [ ] **Step 4: Rename registry and imports**

In `src/platforms/index.ts`, rename:

```ts
import type { Platform, PlatformAdapter } from "../interfaces.js";
const adapters: Record<Platform, PlatformAdapter> = {
export function getPlatformAdapter(platform: Platform): PlatformAdapter {
```

to:

```ts
import type { MemoryPlatformAdapter, Platform } from "../interfaces.js";
const memoryAdapters: Record<Platform, MemoryPlatformAdapter> = {
export function getMemoryPlatformAdapter(platform: Platform): MemoryPlatformAdapter {
```

Update `src/cli.ts` to import and call `getMemoryPlatformAdapter`.

In each existing platform memory adapter file, update imports and class declarations:

```ts
import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";

export class GeminiAdapter implements MemoryPlatformAdapter {
```

Repeat for Claude, Codex, and OpenCode.

- [ ] **Step 5: Update architecture tests that reference the old name**

In `test/architecture.test.ts`, update old `PlatformAdapter` references to `MemoryPlatformAdapter`, including the test that currently rejects `PlatformAdapterOptions`.

Keep the existing architecture intent:

- Only `src/platforms/index.ts` imports all concrete memory adapters.
- Platform memory adapters do not accept test-only runtime dependencies.
- Memory platform adapters still declare `startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult>`.

- [ ] **Step 6: Verify and commit**

Run:

```bash
rg -n "\bPlatformAdapter\b|getPlatformAdapter" src test
node --import=tsx --test test/architecture.test.ts
npm run build
```

Expected: the search returns no old generic memory adapter names, architecture tests pass, and TypeScript compiles.

Commit:

```bash
git add src/interfaces.ts src/platforms/index.ts src/platforms/gemini/index.ts src/platforms/claude/index.ts src/platforms/codex/index.ts src/platforms/opencode/index.ts src/cli.ts test/architecture.test.ts
git commit -m "refactor: name memory platform adapter explicitly" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 1: Generate Separate Workspace-Infrastructure NAMS Client

**Files:**
- Modify: `scripts/generate-nams-client.mjs`
- Generated: `src/generated/nams-client.ts`
- Modify: `test/nams-client-generator.test.ts`
- Create: `test/nams-workspace-client-generator.test.ts`
- Modify: `test/support/nams-fetch-mock.ts`

- [ ] **Step 1: Add failing workspace generator endpoint and client tests**

Keep `test/nams-client-generator.test.ts` focused on the workspace-scoped `NamsClient` and `NAMS_CLIENT_ENDPOINTS`.

Create `test/nams-workspace-client-generator.test.ts` for the workspace-infrastructure client tests. Use local copies of the small generated-client import helpers from `test/nams-client-generator.test.ts`, then add:

```ts
const expectedWorkspaceEndpoints: ExpectedEndpoint[] = [
  {
    methodName: "listMyWorkspaces",
    httpMethod: "GET",
    path: "/v1/users/me/workspaces",
    successStatus: "200",
    bodyRequired: false,
    pathArgs: [],
  },
];
```

Add:

```ts
test("generated workspace client endpoint table matches the pinned OpenAPI spec", async () => {
  const spec = JSON.parse(await readFile(path.join(repoRoot, "docs", "nams-openapi.json"), "utf8")) as OpenApiSpec;
  const { NAMS_WORKSPACE_CLIENT_ENDPOINTS } = await importGeneratedClient();

  assert.deepEqual(NAMS_WORKSPACE_CLIENT_ENDPOINTS, expectedWorkspaceEndpoints.map(toPublicEndpoint));
  for (const endpoint of expectedWorkspaceEndpoints) {
    const httpMethod = endpoint.httpMethod.toLowerCase() as Lowercase<ExpectedEndpoint["httpMethod"]>;
    const operation = spec.paths[endpoint.path]?.[httpMethod];
    assert.ok(operation, `expected ${endpoint.httpMethod} ${endpoint.path} in OpenAPI spec`);
    assert.match(operation.responses?.[endpoint.successStatus]?.schema?.$ref ?? "", /^#\/definitions\//);
  }
});
```

Add:

```ts
test("generated workspace client lists workspaces without X-Workspace-Id", async () => {
  const { NamsWorkspaceClient } = await importGeneratedClient();
  const requests: CapturedRequest[] = [];
  const client = new NamsWorkspaceClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test/",
    defaultHeaders: {
      "X-NAMS-Hooks-Harness": "gemini",
      "X-Workspace-Id": "must-not-forward",
      Authorization: "Bearer wrong-key",
    },
    fetch: async (url, init) => {
      requests.push({ url, init: init as CapturedRequest["init"] });
      return new Response(JSON.stringify({ workspaces: [{ id: "workspace-1", name: "Engineering" }] }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    },
  });

  const response = await client.listMyWorkspaces();

  assert.deepEqual(response, { workspaces: [{ id: "workspace-1", name: "Engineering" }] });
  assert.equal(requests[0].url, "https://memory.example.test/v1/users/me/workspaces");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers.Authorization, "Bearer test-key");
  assert.equal(requests[0].init.headers.Accept, "application/json");
  assert.equal(requests[0].init.headers["X-Workspace-Id"], undefined);
  assert.equal(requests[0].init.headers["Content-Type"], undefined);
});
```

Add:

```ts
test("generated workspace client request logs omit Authorization and workspace header", async () => {
  const { NamsWorkspaceClient } = await importGeneratedClient();
  const events: NamsRequestEvent[] = [];
  const client = new NamsWorkspaceClient({
    apiKey: "test-key",
    baseUrl: "https://memory.example.test",
    onRequest: (event) => {
      events.push(event);
    },
    fetch: async () =>
      new Response(JSON.stringify({ workspaces: [{ id: "workspace-1", name: "Engineering" }] }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
  });

  await client.listMyWorkspaces();

  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "listMyWorkspaces");
  assert.equal(events[0].method, "GET");
  assert.equal(events[0].path, "/v1/users/me/workspaces");
  assert.deepEqual(events[0].request.headers, { Accept: "application/json" });
  assert.doesNotMatch(JSON.stringify(events[0]), /Authorization|Bearer|test-key|X-Workspace-Id/);
});
```

Add an allowlist test so future NAMS workspace infrastructure operations do not silently join the workspace client:

```ts
test("generated workspace client contains only intentional workspace infrastructure endpoints", async () => {
  const { NAMS_WORKSPACE_CLIENT_ENDPOINTS } = await importGeneratedClient();

  assert.deepEqual(NAMS_WORKSPACE_CLIENT_ENDPOINTS.map((endpoint) => endpoint.path), [
    "/v1/users/me/workspaces",
  ]);
});
```

Do not add these workspace client tests to `test/nams-client-generator.test.ts`. That suite remains the agent-memory operations client suite.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm run build && node --import=tsx --test test/nams-workspace-client-generator.test.ts
```

Expected: fail because `NAMS_WORKSPACE_CLIENT_ENDPOINTS` and `NamsWorkspaceClient` do not exist.

- [ ] **Step 3: Update generator manifest and rendering**

In `scripts/generate-nams-client.mjs`, split endpoint lists:

```js
const workspaceScopedEndpoints = [
  {
    methodName: "createConversation",
    httpMethod: "POST",
    path: "/v1/conversations",
    successStatus: "201",
    bodyRequired: false,
  },
  {
    methodName: "addMessage",
    httpMethod: "POST",
    path: "/v1/conversations/{id}/messages",
    successStatus: "201",
    bodyRequired: true,
    pathArgs: [{ argumentName: "conversationId", parameterName: "id" }],
  },
  {
    methodName: "addMessagesBulk",
    httpMethod: "POST",
    path: "/v1/conversations/{id}/messages/bulk",
    successStatus: "201",
    bodyRequired: true,
    pathArgs: [{ argumentName: "conversationId", parameterName: "id" }],
  },
  {
    methodName: "getConversationContext",
    httpMethod: "GET",
    path: "/v1/conversations/{id}/context",
    successStatus: "200",
    pathArgs: [{ argumentName: "conversationId", parameterName: "id" }],
  },
  {
    methodName: "searchConversationMessages",
    httpMethod: "POST",
    path: "/v1/conversations/{id}/search",
    successStatus: "200",
    bodyRequired: true,
    pathArgs: [{ argumentName: "conversationId", parameterName: "id" }],
  },
  {
    methodName: "searchEntities",
    httpMethod: "POST",
    path: "/v1/entities/search",
    successStatus: "200",
    bodyRequired: true,
  },
  {
    methodName: "recordReasoningStep",
    httpMethod: "POST",
    path: "/v1/reasoning/steps",
    successStatus: "201",
    bodyRequired: true,
  },
  {
    methodName: "recordToolCall",
    httpMethod: "POST",
    path: "/v1/reasoning/tool-calls",
    successStatus: "201",
    bodyRequired: true,
  },
];

const workspaceInfrastructureEndpoints = [
  {
    methodName: "listMyWorkspaces",
    httpMethod: "GET",
    path: "/v1/users/me/workspaces",
    successStatus: "200",
  },
];
```

This is an explicit workspace-infrastructure allowlist. `GET /v1/users/me/workspaces` and `POST /v1/workspaces` are the OpenAPI operations that do not require `X-Workspace-Id`; `POST /v1/workspaces` is out of scope for this implementation and must not be generated yet.

Replace the existing `resolvedEndpoints` calculation with:

```js
const resolvedWorkspaceScopedEndpoints = workspaceScopedEndpoints.map((endpoint) => resolveEndpoint(spec, endpoint));
const resolvedWorkspaceInfrastructureEndpoints = workspaceInfrastructureEndpoints.map((endpoint) => resolveEndpoint(spec, endpoint));
const referencedDefinitions = collectReferencedDefinitions(
  [...resolvedWorkspaceInfrastructureEndpoints, ...resolvedWorkspaceScopedEndpoints],
  definitions,
);
const source = renderClient(resolvedWorkspaceScopedEndpoints, resolvedWorkspaceInfrastructureEndpoints, referencedDefinitions, definitions);
```

Change `renderClient` signature:

```js
function renderClient(workspaceScoped, workspaceInfrastructure, definitionNames, allDefinitions) {
```

Inside `renderClient`, emit:

```js
"export interface NamsWorkspaceClientOptions {",
"  baseUrl?: string;",
"  apiKey: string;",
"  defaultHeaders?: Record<string, string>;",
"  fetch?: typeof fetch;",
"  onRequest?: (event: NamsRequestEvent) => void | Promise<void>;",
"}",
"",
```

Emit both endpoint tables:

```js
lines.push(
  "export const NAMS_WORKSPACE_CLIENT_ENDPOINTS = [",
  ...workspaceInfrastructure.map(
    (endpoint) =>
      `  { methodName: "${endpoint.methodName}", httpMethod: "${endpoint.httpMethod}", path: "${endpoint.path}" },`,
  ),
  "] as const;",
  "",
  "export const NAMS_CLIENT_ENDPOINTS = [",
  ...workspaceScoped.map(
    (endpoint) =>
      `  { methodName: "${endpoint.methodName}", httpMethod: "${endpoint.httpMethod}", path: "${endpoint.path}" },`,
  ),
  "] as const;",
  "",
);
```

Add a generated `NamsWorkspaceClient` class that calls a shared request helper with `workspaceId` omitted. Implement the shared helper as a generated top-level function:

```ts
async function requestNams<TResponse>(
  input: {
    baseUrl: string;
    apiKey: string;
    workspaceId?: string;
    defaultHeaders: Record<string, string>;
    fetchImpl: typeof fetch;
    onRequest?: (event: NamsRequestEvent) => void | Promise<void>;
  },
  operation: string,
  httpMethod: HttpMethod,
  pathTemplate: string,
  pathParams?: Record<string, string>,
  body?: unknown,
): Promise<TResponse> {
  const url = `${input.baseUrl}${formatPath(pathTemplate, pathParams)}`;
  const headers: Record<string, string> = { ...input.defaultHeaders };
  setHeader(headers, "Accept", "application/json");
  setHeader(headers, "Authorization", `Bearer ${input.apiKey}`);
  if (input.workspaceId !== undefined) {
    setHeader(headers, "X-Workspace-Id", input.workspaceId);
  } else {
    deleteHeader(headers, "X-Workspace-Id");
  }
  const init: RequestInit = { method: httpMethod, headers };
  if (body !== undefined) {
    setHeader(headers, "Content-Type", "application/json");
    init.body = JSON.stringify(body);
  } else {
    deleteHeader(headers, "Content-Type");
  }
  const requestLog: NamsHttpLogRequest = {
    method: httpMethod,
    url,
    path: pathTemplate,
    headers: headersForLog(headers),
    ...(body !== undefined ? { body } : {}),
  };
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await input.fetchImpl(url, init);
  } catch (error) {
    await emitRequestEvent(input.onRequest, {
      operation,
      method: httpMethod,
      path: pathTemplate,
      ok: false,
      durationMs: elapsedMs(startedAt),
      request: requestLog,
    });
    throw error;
  }
  const responseBody = await readResponseBody(response);
  await emitRequestEvent(input.onRequest, {
    operation,
    method: httpMethod,
    path: pathTemplate,
    status: response.status,
    ok: response.ok,
    durationMs: elapsedMs(startedAt),
    request: requestLog,
    response: {
      status: response.status,
      ok: response.ok,
      headers: responseHeadersForLog(response.headers),
      body: responseBody,
    },
  });
  if (!response.ok) {
    const message = extractErrorMessage(responseBody) ?? `NAMS request failed with status ${response.status}`;
    throw new NamsClientError(message, response.status, responseBody);
  }
  return responseBody as TResponse;
}
```

Add:

```ts
async function emitRequestEvent(
  onRequest: ((event: NamsRequestEvent) => void | Promise<void>) | undefined,
  event: NamsRequestEvent,
): Promise<void> {
  if (onRequest === undefined) {
    return;
  }
  try {
    await onRequest(event);
  } catch {
    // Observability callbacks must not block NAMS requests.
  }
}
```

Use `requestNams` from both generated classes.

Keep the generated classes semantically separate:

- `NamsClient` keeps the existing constructor invariant that `workspaceId` is required and sends `X-Workspace-Id` for every generated memory operation.
- `NamsWorkspaceClient` accepts no `workspaceId`, strips any `X-Workspace-Id` from default headers, and exposes only `listMyWorkspaces` in this change.
- `NAMS_CLIENT_ENDPOINTS` lists only workspace-scoped agent-memory operations.
- `NAMS_WORKSPACE_CLIENT_ENDPOINTS` lists only the workspace-infrastructure allowlist.

- [ ] **Step 4: Add fetch mock helper**

In `test/support/nams-fetch-mock.ts`, add to `NamsFetchMock`:

```ts
workspaces(response?: RouteResponse, status?: number): NamsFetchMock;
```

Add implementation:

```ts
workspaces(response = { workspaces: [] }, status = 200) {
  return api.get("/v1/users/me/workspaces", response, status, "listMyWorkspaces");
},
```

- [ ] **Step 5: Generate client and verify**

Run:

```bash
npm run openapi:generate
npm run build && node --import=tsx --test test/nams-client-generator.test.ts test/nams-workspace-client-generator.test.ts
```

Expected: generated file includes `NamsClient`, `NamsWorkspaceClient`, `WorkspaceListResponse`, `WorkspaceSummary`, and all memory-client plus workspace-client generator tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-nams-client.mjs src/generated/nams-client.ts test/nams-client-generator.test.ts test/nams-workspace-client-generator.test.ts test/support/nams-fetch-mock.ts
git commit -m "feat: generate workspace listing client" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Add Config And Session-State Support For Effective Workspace

**Files:**
- Modify: `src/runtime/config.ts`
- Modify: `src/runtime/session-state.ts`
- Modify: `test/runtime-config.test.ts`
- Modify: `test/session-state.test.ts`

- [ ] **Step 1: Add failing config tests for API-key-only load**

In `test/runtime-config.test.ts`, add:

```ts
import { configDiagnosticPayload, loadNamsConfig, loadNamsConnectionConfig } from "../src/runtime/config.js";
```

Add this test after `environment variables overlay project and global JSON config`:

```ts
test("loads NAMS connection config without requiring workspaceId", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    useRuntimeEnv(homeDir, {
      NAMS_API_KEY: "env-key",
      NAMS_BASE_URL: "https://env.example.test",
    });

    const result = await loadNamsConnectionConfig(projectDir);

    assert.deepEqual(result, {
      ok: true,
      config: {
        apiKey: "env-key",
        baseUrl: "https://env.example.test",
      },
      workspaceId: undefined,
      sources: {
        apiKey: "env:NAMS_API_KEY",
        workspaceId: "missing",
        baseUrl: "env:NAMS_BASE_URL",
      },
    });
  });
});
```

Add:

```ts
test("connection config preserves configured workspaceId when present", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await writeProjectConfig(projectDir, {
      apiKey: "project-key",
      workspaceId: "project-workspace",
    });
    useRuntimeEnv(homeDir);

    const result = await loadNamsConnectionConfig(projectDir);

    assert.deepEqual(result, {
      ok: true,
      config: {
        apiKey: "project-key",
        workspaceId: "project-workspace",
      },
      workspaceId: "project-workspace",
      sources: {
        apiKey: "project:.nams/config.json",
        workspaceId: "project:.nams/config.json",
        baseUrl: "default",
      },
    });
  });
});
```

- [ ] **Step 2: Add failing session-state workspace tests**

In `test/session-state.test.ts`, add after `initializes reasoning step id map for new session state`:

```ts
test("initializes new session state without a selected workspace", async () => {
  const state = createInitialSessionState({
    platform: "gemini",
    sessionId: "session-1",
    projectDirectory: "/tmp/project",
  });

  assert.equal(state.workspace, undefined);
});
```

Add after `persists session state under user-local .nams/state using timestamped session filenames`:

```ts
test("persists selected workspace in session state", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-state-"));
  try {
    useRuntimeHome(homeDir);
    const state: SessionState = {
      harness: "gemini",
      harnessSessionId: "session-1",
      sessionKey: "session-1",
      projectDirectory: projectDir,
      createdAt: "2026-06-05T12:00:00.000Z",
      workspace: {
        id: "workspace-1",
        source: "runtime-single-workspace",
        selectedAt: "2026-06-05T12:00:01.000Z",
      },
      seenAssistantMessageHashes: [],
      seenTranscriptEntryIds: [],
      seenReasoningStepHashes: [],
      seenToolCallIds: [],
      reasoningStepIdsByHash: {},
    };

    await saveSessionState("gemini", state.sessionKey, state);

    const loadedState = await loadSessionState("gemini", "session-1");
    assert.ok(loadedState);
    assert.deepEqual(loadedState.workspace, state.workspace);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
node --import=tsx --test test/runtime-config.test.ts test/session-state.test.ts
```

Expected: fail because `loadNamsConnectionConfig` and `SessionState.workspace` are missing.

- [ ] **Step 4: Implement config connection loader**

In `src/runtime/config.ts`, add:

```ts
export interface NamsConnectionConfig {
  apiKey: string;
  workspaceId?: string;
  baseUrl?: string;
}

export type NamsConnectionConfigLoadResult =
  | {
      ok: true;
      config: NamsConnectionConfig;
      workspaceId?: string;
      sources: NamsConfigSources;
    }
  | {
      ok: false;
      reason: "missing-api-key";
      sources: NamsConfigSources;
    }
  | {
      ok: false;
      reason: "invalid-json";
      errorSource: "global:~/.nams/config.json" | "project:.nams/config.json";
      sources: NamsConfigSources;
    };
```

Refactor `loadNamsConfig` to call `loadNamsConnectionConfig`:

```ts
export async function loadNamsConfig(
  projectDirectory: string,
  discoverConfig?: NamsConfigDiscovery,
): Promise<NamsConfigLoadResult> {
  const result = await loadNamsConnectionConfig(projectDirectory, discoverConfig);
  if (!result.ok) {
    return result;
  }
  if (result.config.workspaceId === undefined) {
    return {
      ok: false,
      reason: "missing-workspace-id",
      sources: result.sources,
    };
  }
  return {
    ok: true,
    config: {
      apiKey: result.config.apiKey,
      workspaceId: result.config.workspaceId,
      ...(result.config.baseUrl !== undefined ? { baseUrl: result.config.baseUrl } : {}),
    },
    sources: result.sources,
  };
}
```

Add `loadNamsConnectionConfig` with the same global/project/platform/env precedence currently in `loadNamsConfig`, but only failing when `apiKey` is missing:

```ts
export async function loadNamsConnectionConfig(
  projectDirectory: string,
  discoverConfig?: NamsConfigDiscovery,
): Promise<NamsConnectionConfigLoadResult> {
  const runtimeEnvironment = RuntimeEnvironment.fromProcess();
  const accumulated: Partial<NamsRuntimeConfig> = {};
  const sources: NamsConfigSources = defaultSources();

  const globalResult = await readGlobalJsonConfig(runtimeEnvironment);
  if (!globalResult.ok) {
    return invalidJsonResult(globalResult.source);
  }
  applyJsonConfig(accumulated, sources, globalResult.config, "global:~/.nams/config.json");

  const projectResult = await readJsonConfig(
    runtimeEnvironment.projectConfigPath(projectDirectory),
    "project:.nams/config.json",
  );
  if (!projectResult.ok) {
    return invalidJsonResult(projectResult.source, sources);
  }
  applyJsonConfig(accumulated, sources, projectResult.config, "project:.nams/config.json");

  if (discoverConfig !== undefined) {
    applyDiscoveredConfig(accumulated, sources, await discoverConfig(runtimeEnvironment));
  }
  applyEnvironmentOverrides(accumulated, sources, runtimeEnvironment);

  if (accumulated.apiKey === undefined) {
    return {
      ok: false,
      reason: "missing-api-key",
      sources,
    };
  }

  return {
    ok: true,
    config: {
      apiKey: accumulated.apiKey,
      ...(accumulated.workspaceId !== undefined ? { workspaceId: accumulated.workspaceId } : {}),
      ...(accumulated.baseUrl !== undefined ? { baseUrl: accumulated.baseUrl } : {}),
    },
    ...(accumulated.workspaceId !== undefined ? { workspaceId: accumulated.workspaceId } : {}),
    sources,
  };
}
```

- [ ] **Step 5: Implement session workspace state**

In `src/runtime/session-state.ts`, add:

```ts
export type SessionWorkspaceSource =
  | "config"
  | "runtime-single-workspace"
  | "install-selection";

export interface SessionWorkspaceState {
  id: string;
  source: SessionWorkspaceSource;
  selectedAt: string;
}
```

Add to `SessionState`:

```ts
workspace?: SessionWorkspaceState;
```

No migration code is needed because missing `workspace` remains valid JSON state.

- [ ] **Step 6: Verify and commit**

Run:

```bash
node --import=tsx --test test/runtime-config.test.ts test/session-state.test.ts
npm run build
```

Expected: both tests and build pass.

Commit:

```bash
git add src/runtime/config.ts src/runtime/session-state.ts test/runtime-config.test.ts test/session-state.test.ts
git commit -m "feat: support workspace-optional config state" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Add Shared Workspace Resolution Runtime

**Files:**
- Create: `src/runtime/workspace-resolution.ts`
- Modify: `src/runtime/logging.ts`
- Modify: `test/support/nams-fetch-mock.ts`
- Create: `test/workspace-resolution.test.ts`

- [ ] **Step 1: Add failing workspace resolution tests**

Create `test/workspace-resolution.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HookInvocation } from "../src/interfaces.js";
import { createInitialSessionState } from "../src/runtime/session-state.js";
import {
  resolveWorkspaceForMemory,
  workspaceSelectionRequiredOutput,
} from "../src/runtime/workspace-resolution.js";
import { createNamsFetchMock } from "./support/nams-fetch-mock.js";

function useEnv(projectDir: string, overrides: Record<string, string | undefined> = {}): void {
  for (const key of ["HOME", "USERPROFILE", "NAMS_API_KEY", "NAMS_WORKSPACE_ID", "NAMS_BASE_URL"]) {
    delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: path.join(projectDir, "home"),
    USERPROFILE: path.join(projectDir, "home"),
    ...overrides,
  });
}

function invocation(projectDir: string): HookInvocation<"BeforeAgent"> {
  return {
    platform: "gemini",
    event: "BeforeAgent",
    processCwd: projectDir,
    rawPayload: {
      session_id: "session-1",
      cwd: projectDir,
      prompt: "hello",
    },
  };
}

test("configured workspace skips workspace listing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    const nams = createNamsFetchMock().all({ error: "unexpected workspace listing" }, 500);
    useEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "configured-workspace",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const state = createInitialSessionState({
      platform: "gemini",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });

    const result = await resolveWorkspaceForMemory({
      invocation: invocation(projectDir),
      state,
      projectDirectory: projectDir,
      interaction: "gemini-blocking",
    });

    assert.equal(result.status, "ready");
    assert.equal(result.config.workspaceId, "configured-workspace");
    assert.equal(nams.calls("listMyWorkspaces").length, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("single returned workspace stores session workspace and returns ready config", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    const nams = createNamsFetchMock().workspaces({
      workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
    });
    useEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const state = createInitialSessionState({
      platform: "gemini",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });

    const result = await resolveWorkspaceForMemory({
      invocation: invocation(projectDir),
      state,
      projectDirectory: projectDir,
      interaction: "gemini-blocking",
    });

    assert.equal(result.status, "ready");
    assert.equal(result.config.workspaceId, "workspace-1");
    assert.deepEqual(state.workspace, {
      id: "workspace-1",
      source: "runtime-single-workspace",
      selectedAt: state.workspace?.selectedAt,
    });
    const headers = nams.calls("listMyWorkspaces")[0].options.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer key");
    assert.equal(headers["x-workspace-id"], undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("multiple workspaces return Gemini deny output before memory can continue", async () => {
  const output = workspaceSelectionRequiredOutput("gemini", [
    { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
    { id: "workspace-2", name: "Research", role: "member", status: "active" },
  ]);

  assert.deepEqual(output.stdout.continue, undefined);
  assert.equal(output.stdout.decision, "deny");
  assert.match(String(output.stdout.reason), /NAMS workspace selection required/);
  assert.match(String(output.stdout.reason), /Engineering/);
  assert.match(String(output.stdout.reason), /workspace-2/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import=tsx --test test/workspace-resolution.test.ts
```

Expected: fail because `src/runtime/workspace-resolution.ts` does not exist.

- [ ] **Step 3: Implement workspace diagnostics**

In `src/runtime/logging.ts`, add:

```ts
export async function appendWorkspaceDiagnostic(
  invocation: HookInvocation,
  state: SessionState,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendPlatformDiagnosticLog(invocation, state, payload);
}
```

Use fixed messages only:

```ts
export const workspaceDiagnosticMessages = {
  loadedFromConfig: "NAMS workspace loaded from config",
  autoSelected: "NAMS workspace auto-selected",
  selectionRequired: "NAMS workspace selection required",
  listEmpty: "NAMS workspace list empty",
  requestFailed: "NAMS workspace request failed",
} as const;
```

- [ ] **Step 4: Implement workspace-resolution runtime**

Create `src/runtime/workspace-resolution.ts`:

```ts
import { NamsWorkspaceClient, type WorkspaceSummary } from "../generated/nams-client.js";
import type { HookInvocation, HookResult, Platform } from "../interfaces.js";
import {
  configDiagnosticPayload,
  loadNamsConnectionConfig,
  type NamsRuntimeConfig,
} from "./config.js";
import {
  appendNamsRequestLog,
  appendPlatformDiagnosticLog,
  appendWorkspaceDiagnostic,
  workspaceDiagnosticMessages,
} from "./logging.js";
import { namsProvenanceHeaders } from "./provenance.js";
import type { SessionState } from "./session-state.js";

export type WorkspaceInteraction = "gemini-blocking" | "single-only";

export type WorkspaceResolutionResult =
  | { status: "ready"; config: NamsRuntimeConfig }
  | { status: "skip-memory"; output: HookResult }
  | { status: "block"; output: HookResult };

export interface ResolveWorkspaceInput {
  invocation: HookInvocation;
  state: SessionState;
  projectDirectory: string;
  interaction: WorkspaceInteraction;
}

export async function resolveWorkspaceForMemory(input: ResolveWorkspaceInput): Promise<WorkspaceResolutionResult> {
  const connectionResult = await loadNamsConnectionConfig(input.projectDirectory);
  if (!connectionResult.ok) {
    await appendPlatformDiagnosticLog(input.invocation, input.state, configDiagnosticPayload(connectionResult));
    return { status: "skip-memory", output: allowOutput() };
  }

  if (connectionResult.config.workspaceId !== undefined) {
    input.state.workspace = {
      id: connectionResult.config.workspaceId,
      source: "config",
      selectedAt: new Date().toISOString(),
    };
    await appendWorkspaceDiagnostic(input.invocation, input.state, {
      message: workspaceDiagnosticMessages.loadedFromConfig,
      configSources: connectionResult.sources,
    });
    return {
      status: "ready",
      config: {
        apiKey: connectionResult.config.apiKey,
        workspaceId: connectionResult.config.workspaceId,
        ...(connectionResult.config.baseUrl !== undefined ? { baseUrl: connectionResult.config.baseUrl } : {}),
      },
    };
  }

  if (input.state.workspace !== undefined) {
    return {
      status: "ready",
      config: {
        apiKey: connectionResult.config.apiKey,
        workspaceId: input.state.workspace.id,
        ...(connectionResult.config.baseUrl !== undefined ? { baseUrl: connectionResult.config.baseUrl } : {}),
      },
    };
  }

  const client = new NamsWorkspaceClient({
    apiKey: connectionResult.config.apiKey,
    ...(connectionResult.config.baseUrl !== undefined ? { baseUrl: connectionResult.config.baseUrl } : {}),
    defaultHeaders: namsProvenanceHeaders(input.invocation),
    onRequest: (event) => appendNamsRequestLog(input.invocation, input.state, event),
  });

  let workspaces: WorkspaceSummary[];
  try {
    const response = await client.listMyWorkspaces();
    workspaces = validWorkspaces(response.workspaces);
  } catch {
    await appendWorkspaceDiagnostic(input.invocation, input.state, {
      message: workspaceDiagnosticMessages.requestFailed,
    });
    return { status: "skip-memory", output: allowOutput() };
  }

  if (workspaces.length === 1) {
    const workspace = workspaces[0];
    input.state.workspace = {
      id: workspace.id,
      source: "runtime-single-workspace",
      selectedAt: new Date().toISOString(),
    };
    await appendWorkspaceDiagnostic(input.invocation, input.state, {
      message: workspaceDiagnosticMessages.autoSelected,
      workspace: publicWorkspace(workspace),
    });
    return {
      status: "ready",
      config: {
        apiKey: connectionResult.config.apiKey,
        workspaceId: workspace.id,
        ...(connectionResult.config.baseUrl !== undefined ? { baseUrl: connectionResult.config.baseUrl } : {}),
      },
    };
  }

  if (workspaces.length === 0) {
    await appendWorkspaceDiagnostic(input.invocation, input.state, {
      message: workspaceDiagnosticMessages.listEmpty,
    });
    return { status: "skip-memory", output: allowOutput() };
  }

  await appendWorkspaceDiagnostic(input.invocation, input.state, {
    message: workspaceDiagnosticMessages.selectionRequired,
    workspaces: workspaces.map(publicWorkspace),
  });

  if (input.interaction === "gemini-blocking") {
    return {
      status: "block",
      output: workspaceSelectionRequiredOutput(input.invocation.platform, workspaces),
    };
  }
  return { status: "skip-memory", output: allowOutput() };
}

export function workspaceSelectionRequiredOutput(platform: Platform, workspaces: WorkspaceSummary[]): HookResult {
  if (platform === "gemini") {
    return {
      stdout: {
        decision: "deny",
        reason: workspaceSelectionReason(workspaces),
      },
    };
  }
  return allowOutput();
}

function workspaceSelectionReason(workspaces: WorkspaceSummary[]): string {
  return [
    "NAMS workspace selection required. Configure one workspace before memory starts:",
    ...workspaces.map((workspace, index) => {
      const name = workspace.name?.trim() || "(unnamed workspace)";
      const role = workspace.role?.trim() || "unknown-role";
      const status = workspace.status?.trim() || "unknown-status";
      return `${index + 1}. ${name} (${role}, ${status}) - ${workspace.id}`;
    }),
  ].join("\n");
}

function validWorkspaces(workspaces: WorkspaceSummary[] | undefined): Array<WorkspaceSummary & { id: string }> {
  return (workspaces ?? []).filter((workspace): workspace is WorkspaceSummary & { id: string } => {
    return typeof workspace.id === "string" && workspace.id.trim() !== "";
  });
}

function publicWorkspace(workspace: WorkspaceSummary): Record<string, string | undefined> {
  return {
    id: workspace.id,
    name: workspace.name,
    role: workspace.role,
    status: workspace.status,
    dbMode: workspace.dbMode,
  };
}

function allowOutput(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
node --import=tsx --test test/workspace-resolution.test.ts
npm run build
```

Expected: tests pass and TypeScript compiles.

Commit:

```bash
git add src/runtime/workspace-resolution.ts src/runtime/logging.ts test/workspace-resolution.test.ts test/support/nams-fetch-mock.ts
git commit -m "feat: resolve NAMS workspace before memory" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Add Workspace Command Gateway And Platform Workspace Adapters

**Files:**
- Modify: `src/interfaces.ts`
- Modify: `src/cli.ts`
- Modify: `src/platforms/index.ts`
- Create: `src/platforms/gemini/workspaces.ts`
- Create: `src/platforms/opencode/workspaces.ts`
- Create: `src/platforms/claude/workspaces.ts`
- Create: `src/platforms/codex/workspaces.ts`
- Modify: `test/architecture.test.ts`
- Create: `test/cli-workspaces.test.ts`

- [ ] **Step 1: Add failing CLI tests**

Create `test/cli-workspaces.test.ts`:

```ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createNamsFetchMock } from "./support/nams-fetch-mock.js";

const execFileAsync = promisify(execFile);

test("routes workspace BeforeAgent command through workspace adapter", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    createNamsFetchMock().workspaces({
      workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
    });
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import=tsx", "src/cli.ts", "workspaces", "gemini", "--event", "BeforeAgent"],
      {
        cwd: path.resolve("."),
        input: JSON.stringify({ session_id: "session-1", cwd: projectDir, prompt: "hello" }),
        env: {
          ...process.env,
          HOME: path.join(projectDir, "home"),
          USERPROFILE: path.join(projectDir, "home"),
          NAMS_API_KEY: "key",
          NAMS_BASE_URL: "https://memory.example.test",
        },
      },
    );

    assert.deepEqual(JSON.parse(stdout), { continue: true, suppressOutput: true });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("rejects unsupported workspace command event", async () => {
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, ["--import=tsx", "src/cli.ts", "workspaces", "gemini", "--event", "AfterAgent"], {
        cwd: path.resolve("."),
        input: "{}",
      }),
    (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /Usage: nams-hooks/);
      return true;
    },
  );
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import=tsx --test test/cli-workspaces.test.ts
```

Expected: fail because `workspaces` command is not parsed.

- [ ] **Step 3: Add workspace interfaces**

In `src/interfaces.ts`, add:

```ts
export const workspaceHookEvents = ["BeforeAgent", "InstallConfigure"] as const;
export type WorkspaceHookEvent = (typeof workspaceHookEvents)[number];

export interface WorkspaceHookInvocation<E extends WorkspaceHookEvent = WorkspaceHookEvent> {
  platform: Platform;
  event: E;
  rawPayload: Record<string, unknown>;
  processCwd: string;
}

export interface WorkspacePlatformAdapter {
  beforeAgent?(invocation: WorkspaceHookInvocation<"BeforeAgent">): Promise<HookResult>;
  installConfigure?(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<HookResult>;
}

export function isWorkspaceHookEvent(value: string | undefined): value is WorkspaceHookEvent {
  return value !== undefined && workspaceHookEvents.includes(value as WorkspaceHookEvent);
}
```

- [ ] **Step 4: Add workspace platform adapter files**

Create `src/platforms/gemini/workspaces.ts`:

```ts
import type { HookResult, WorkspaceHookInvocation, WorkspacePlatformAdapter } from "../../interfaces.js";
import { appendRawPlatformLog } from "../../runtime/logging.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import { resolveWorkspaceForMemory } from "../../runtime/workspace-resolution.js";
import { parseGeminiPayload } from "./payload.js";

export class GeminiWorkspaceAdapter implements WorkspacePlatformAdapter {
  async beforeAgent(invocation: WorkspaceHookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendRawPlatformLog({ ...invocation, event: "BeforeAgent" }, state);

    const result = await resolveWorkspaceForMemory({
      invocation: { ...invocation, event: "BeforeAgent" },
      state,
      projectDirectory: payloadInfo.projectDirectory,
      interaction: "gemini-blocking",
    });
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return result.status === "ready" ? allowOutput() : result.output;
  }
}

function allowOutput(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}
```

Create `src/platforms/opencode/workspaces.ts`:

```ts
import type { HookResult, WorkspaceHookInvocation, WorkspacePlatformAdapter } from "../../interfaces.js";
import { appendRawPlatformLog } from "../../runtime/logging.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import { resolveWorkspaceForMemory } from "../../runtime/workspace-resolution.js";
import { parseOpenCodePayload } from "./payload.js";

export class OpenCodeWorkspaceAdapter implements WorkspacePlatformAdapter {
  async beforeAgent(invocation: WorkspaceHookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    if (payloadInfo.hookName !== "chat.message") {
      return allowOutput();
    }

    const initialState = createInitialSessionState({
      platform: invocation.platform,
      projectDirectory: payloadInfo.projectDirectory,
      sessionId: payloadInfo.sessionId,
    });
    const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendRawPlatformLog({ ...invocation, event: "BeforeAgent" }, state);

    const result = await resolveWorkspaceForMemory({
      invocation: { ...invocation, event: "BeforeAgent" },
      state,
      projectDirectory: payloadInfo.projectDirectory,
      interaction: "single-only",
    });
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return result.status === "ready" ? allowOutput() : result.output;
  }
}

function allowOutput(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}
```

Create `src/platforms/claude/workspaces.ts`:

```ts
import type { HookResult, WorkspacePlatformAdapter } from "../../interfaces.js";

export class ClaudeWorkspaceAdapter implements WorkspacePlatformAdapter {
  async installConfigure(): Promise<HookResult> {
    return {
      stdout: {
        continue: true,
        suppressOutput: true,
        message: "NAMS workspace configuration should be provided through Claude plugin userConfig or .nams/config.json.",
      },
    };
  }
}
```

Create `src/platforms/codex/workspaces.ts`:

```ts
import type { HookResult, WorkspacePlatformAdapter } from "../../interfaces.js";

export class CodexWorkspaceAdapter implements WorkspacePlatformAdapter {
  async installConfigure(): Promise<HookResult> {
    return {
      stdout: {
        continue: true,
        suppressOutput: true,
        message: "NAMS workspace configuration should be provided through nams-hooks workspace configure or .nams/config.json.",
      },
    };
  }
}
```

- [ ] **Step 5: Add static workspace registry**

In `src/platforms/index.ts`, add imports and registry:

```ts
import type { WorkspacePlatformAdapter } from "../interfaces.js";
import { ClaudeWorkspaceAdapter } from "./claude/workspaces.js";
import { CodexWorkspaceAdapter } from "./codex/workspaces.js";
import { GeminiWorkspaceAdapter } from "./gemini/workspaces.js";
import { OpenCodeWorkspaceAdapter } from "./opencode/workspaces.js";

const workspaceAdapters: Record<Platform, WorkspacePlatformAdapter> = {
  gemini: new GeminiWorkspaceAdapter(),
  claude: new ClaudeWorkspaceAdapter(),
  codex: new CodexWorkspaceAdapter(),
  opencode: new OpenCodeWorkspaceAdapter(),
};

export function getWorkspacePlatformAdapter(platform: Platform): WorkspacePlatformAdapter {
  return workspaceAdapters[platform];
}
```

- [ ] **Step 6: Update CLI parser**

In `src/cli.ts`, replace the single `RunArgs` parser with a command union:

```ts
type CliArgs =
  | { command: "run"; platform: Platform; event: HookEvent }
  | { command: "workspaces"; platform: Platform; event: WorkspaceHookEvent };
```

Implement parser:

```ts
function parseArgs(argv: string[]): CliArgs | null {
  const [command, platformArg, eventFlag, eventArg] = argv;
  if (command === "run" && eventFlag === "--event" && isPlatform(platformArg) && isHookEvent(eventArg)) {
    return { command: "run", platform: platformArg, event: eventArg };
  }
  if (command === "workspaces" && eventFlag === "--event" && isPlatform(platformArg) && isWorkspaceHookEvent(eventArg)) {
    return { command: "workspaces", platform: platformArg, event: eventArg };
  }
  return null;
}
```

Update usage string:

```ts
"Usage: nams-hooks run PLATFORM --event EVENT\n       nams-hooks workspaces PLATFORM --event EVENT\n\nPlatforms: gemini, claude, codex, opencode\nRun events: SessionStart, BeforeAgent, AfterAgent, AfterTool\nWorkspace events: BeforeAgent, InstallConfigure\n"
```

Add routing:

```ts
if (args.command === "workspaces") {
  const rawPayload = await readJsonPayload();
  const adapter = getWorkspacePlatformAdapter(args.platform);
  const result = await routeWorkspaceEvent(adapter, {
    platform: args.platform,
    event: args.event,
    rawPayload,
    processCwd: process.cwd(),
  });
  process.stdout.write(`${JSON.stringify(result.stdout)}\n`);
  return 0;
}
```

Add:

```ts
async function routeWorkspaceEvent(
  adapter: WorkspacePlatformAdapter,
  invocation: WorkspaceHookInvocation,
): Promise<HookResult> {
  switch (invocation.event) {
    case "BeforeAgent":
      return adapter.beforeAgent?.({ ...invocation, event: "BeforeAgent" }) ?? allowHook();
    case "InstallConfigure":
      return adapter.installConfigure?.({ ...invocation, event: "InstallConfigure" }) ?? allowHook();
  }
}
```

- [ ] **Step 7: Update architecture tests**

In `test/architecture.test.ts`, add workspace adapter files to the allowed registry import rule:

```ts
const concreteAdapters = new Set([
  "src/platforms/gemini/index.ts",
  "src/platforms/claude/index.ts",
  "src/platforms/codex/index.ts",
  "src/platforms/opencode/index.ts",
  "src/platforms/gemini/workspaces.ts",
  "src/platforms/claude/workspaces.ts",
  "src/platforms/codex/workspaces.ts",
  "src/platforms/opencode/workspaces.ts",
]);
```

Add a new architecture assertion:

```ts
test("workspace adapter registry is static", async () => {
  const content = await readFile("src/platforms/index.ts", "utf8");

  assert.match(content, /\bgetWorkspacePlatformAdapter\b/);
  assert.equal(/\bimport\(|readdir|dynamic\b/.test(content), false);
});
```

- [ ] **Step 8: Verify and commit**

Run:

```bash
node --import=tsx --test test/cli-workspaces.test.ts test/architecture.test.ts
npm run build
```

Expected: tests pass and CLI prints JSON for workspace command.

Commit:

```bash
git add src/interfaces.ts src/cli.ts src/platforms/index.ts src/platforms/gemini/workspaces.ts src/platforms/opencode/workspaces.ts src/platforms/claude/workspaces.ts src/platforms/codex/workspaces.ts test/cli-workspaces.test.ts test/architecture.test.ts
git commit -m "feat: add workspace hook command gateway" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Integrate Effective Workspace Into Memory Hooks

**Files:**
- Modify: `src/runtime/workspace-resolution.ts`
- Modify: `src/platforms/gemini/index.ts`
- Modify: `src/platforms/opencode/index.ts`
- Modify: `test/gemini/gemini-memory-flow.test.ts`
- Modify: `test/opencode/opencode-memory-flow.test.ts`

- [ ] **Step 1: Add failing Gemini and OpenCode memory flow tests**

In `test/gemini/gemini-memory-flow.test.ts`, replace the current test named `Gemini BeforeAgent continues when NAMS_WORKSPACE_ID is missing` with:

```ts
test("Gemini BeforeAgent uses session-resolved single workspace when NAMS_WORKSPACE_ID is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const nams = createNamsFetchMock()
      .workspaces({
        workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
      })
      .createConversation()
      .context()
      .searchEntities()
      .message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new GeminiAdapter();

    const workspaceAdapter = new GeminiWorkspaceAdapter();
    await workspaceAdapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Resolve workspace before memory.",
      },
    });
    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Resolve workspace before memory.",
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 1);
    const createConversationHeaders = nams.calls("createConversation")[0].options.headers as Record<string, string>;
    assert.equal(createConversationHeaders["x-workspace-id"], "workspace-1");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

Add import:

```ts
import { GeminiWorkspaceAdapter } from "../../src/platforms/gemini/workspaces.js";
```

In `test/opencode/opencode-memory-flow.test.ts`, add after `OpenCode chat.message creates conversation, recalls memory, and stores user prompt`:

```ts
test("OpenCode chat.message uses session-resolved single workspace before creating memory", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock()
      .workspaces({
        workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
      })
      .createConversation()
      .context()
      .searchEntities()
      .message();
    testEnv(projectDir, { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" });
    const workspaceAdapter = new OpenCodeWorkspaceAdapter();
    const adapter = new OpenCodeAdapter();
    const rawPayload = {
      hook: "chat.message",
      directory: projectDir,
      input: { sessionID: "session-1" },
      output: {
        messageID: "user-1",
        parts: [{ type: "text", text: "Resolve workspace before memory." }],
      },
    };

    await workspaceAdapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload,
    });
    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload,
    });

    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 1);
    const createConversationHeaders = nams.calls("createConversation")[0].options.headers as Record<string, string>;
    assert.equal(createConversationHeaders["x-workspace-id"], "workspace-1");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

Add import:

```ts
import { OpenCodeWorkspaceAdapter } from "../../src/platforms/opencode/workspaces.js";
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import=tsx --test test/gemini/gemini-memory-flow.test.ts test/opencode/opencode-memory-flow.test.ts
```

Expected: fail because memory adapters still call `loadNamsConfig` and ignore `state.workspace`.

- [ ] **Step 3: Add effective memory config helper**

In `src/runtime/workspace-resolution.ts`, add:

```ts
export async function loadEffectiveNamsConfigForMemory(
  invocation: HookInvocation,
  state: SessionState,
  projectDirectory: string,
): Promise<NamsRuntimeConfig | undefined> {
  const connectionResult = await loadNamsConnectionConfig(projectDirectory);
  if (!connectionResult.ok) {
    await appendPlatformDiagnosticLog(invocation, state, configDiagnosticPayload(connectionResult));
    return undefined;
  }

  const configuredWorkspaceId = connectionResult.config.workspaceId;
  if (configuredWorkspaceId !== undefined) {
    return {
      apiKey: connectionResult.config.apiKey,
      workspaceId: configuredWorkspaceId,
      ...(connectionResult.config.baseUrl !== undefined ? { baseUrl: connectionResult.config.baseUrl } : {}),
    };
  }

  if (state.workspace !== undefined) {
    return {
      apiKey: connectionResult.config.apiKey,
      workspaceId: state.workspace.id,
      ...(connectionResult.config.baseUrl !== undefined ? { baseUrl: connectionResult.config.baseUrl } : {}),
    };
  }

  await appendPlatformDiagnosticLog(invocation, state, {
    message: "NAMS workspaceId missing",
    configSources: connectionResult.sources,
  });
  return undefined;
}
```

- [ ] **Step 4: Update Gemini memory adapter**

In `src/platforms/gemini/index.ts`, import:

```ts
import { loadEffectiveNamsConfigForMemory } from "../../runtime/workspace-resolution.js";
```

In every method that currently does:

```ts
const configResult = await loadNamsConfig(payloadInfo.projectDirectory);
await appendNamsConfigDiagnostic(invocation, state, configResult);
if (!configResult.ok) {
  await saveSessionState(invocation.platform, state.sessionKey, state);
  return allowOutput();
}
const config = configResult.config;
```

replace with:

```ts
const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
if (config === undefined) {
  await saveSessionState(invocation.platform, state.sessionKey, state);
  return allowOutput();
}
```

Remove unused `loadNamsConfig` and `appendNamsConfigDiagnostic` imports after the replacements.

- [ ] **Step 5: Update OpenCode memory adapter**

In `src/platforms/opencode/index.ts`, import:

```ts
import { loadEffectiveNamsConfigForMemory } from "../../runtime/workspace-resolution.js";
```

Replace each `loadNamsConfig` block with the same `loadEffectiveNamsConfigForMemory` block used for Gemini. Remove unused imports.

- [ ] **Step 6: Verify and commit**

Run:

```bash
node --import=tsx --test test/gemini/gemini-memory-flow.test.ts test/opencode/opencode-memory-flow.test.ts
npm run build
```

Expected: tests pass. Existing Claude/Codex behavior remains unchanged because those adapters still use config-time workspace ID.

Commit:

```bash
git add src/runtime/workspace-resolution.ts src/platforms/gemini/index.ts src/platforms/opencode/index.ts test/gemini/gemini-memory-flow.test.ts test/opencode/opencode-memory-flow.test.ts
git commit -m "feat: use resolved workspace in memory hooks" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 6: Update Gemini And OpenCode Hook Packaging

**Files:**
- Modify: `templates/gemini/hooks/hooks.json`
- Modify: `templates/gemini/gemini-extension.json`
- Modify: `templates/opencode/plugins/nams-hooks.js`
- Modify: `test/gemini-template.test.ts`
- Modify: `test/opencode/opencode-template.test.ts`
- Modify: `test/opencode-template.test.ts`

- [ ] **Step 1: Add failing template tests**

In `test/gemini-template.test.ts`, add:

```ts
test("Gemini BeforeAgent template runs workspace hook before memory hook sequentially", async () => {
  const hooksTemplate = JSON.parse(await readFile(path.join(repoRoot, "templates", "gemini", "hooks", "hooks.json"), "utf8"));
  const groups = hooksTemplate.hooks.BeforeAgent;

  assert.equal(groups.length, 1);
  assert.equal(groups[0].sequential, true);
  assert.deepEqual(
    groups[0].hooks.map((hook: { name: string; command: string }) => ({
      name: hook.name,
      command: hook.command,
    })),
    [
      {
        name: "nams-workspace-before-agent",
        command: "node \"${extensionPath}/bin/cli.js\" workspaces gemini --event BeforeAgent",
      },
      {
        name: "nams-memory-before-agent",
        command: "node \"${extensionPath}/bin/cli.js\" run gemini --event BeforeAgent",
      },
    ],
  );
});
```

Update the existing settings test to expect optional workspace wording:

```ts
assert.match(settings[1].description, /Optional/);
```

In `test/opencode/opencode-template.test.ts`, update the `chat.message handler sends real two-argument input and output to nams-hooks` test so it expects:

```ts
assert.deepEqual(invocations.map((entry) => entry.args.slice(0, 4)), [
  ["workspaces", "opencode", "--event", "BeforeAgent"],
  ["run", "opencode", "--event", "BeforeAgent"],
]);
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import=tsx --test test/gemini-template.test.ts test/opencode/opencode-template.test.ts test/opencode-template.test.ts
```

Expected: fail because templates have not been updated.

- [ ] **Step 3: Update Gemini hook template**

In `templates/gemini/hooks/hooks.json`, replace the `BeforeAgent` group with:

```json
"BeforeAgent": [
  {
    "matcher": "*",
    "sequential": true,
    "hooks": [
      {
        "type": "command",
        "name": "nams-workspace-before-agent",
        "description": "Resolve the NAMS workspace before memory persistence starts.",
        "command": "node \"${extensionPath}/bin/cli.js\" workspaces gemini --event BeforeAgent"
      },
      {
        "type": "command",
        "name": "nams-memory-before-agent",
        "description": "Route Gemini CLI before-agent payload to the NAMS hook runtime.",
        "command": "node \"${extensionPath}/bin/cli.js\" run gemini --event BeforeAgent"
      }
    ]
  }
]
```

In `templates/gemini/gemini-extension.json`, change workspace setting description to:

```json
"description": "Optional workspace ID for Neo4j Agent Memory Service. If omitted, nams-hooks auto-selects a single available workspace before memory starts."
```

- [ ] **Step 4: Update OpenCode plugin shim**

In `templates/opencode/plugins/nams-hooks.js`, add:

```js
async function runWorkspace(event, payload) {
  try {
    return await invokeNams("workspaces", event, { directory, project, worktree, ...payload });
  } catch {
    await logDiagnostic(client, `NAMS OpenCode workspace hook ${event} failed`);
    return undefined;
  }
}
```

Change existing `run` to:

```js
async function run(event, payload) {
  try {
    return await invokeNams("run", event, { directory, project, worktree, ...payload });
  } catch {
    await logDiagnostic(client, `NAMS OpenCode hook ${event} failed`);
    return undefined;
  }
}
```

Change `chat.message` handler:

```js
"chat.message": async (input, output) => {
  await runWorkspace("BeforeAgent", { hook: "chat.message", input, output });
  await run("BeforeAgent", { hook: "chat.message", input, output });
},
```

Change `invokeNams` signature and spawn args:

```js
async function invokeNams(commandName, event, payload) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [commandName, "opencode", "--event", event], {
      stdio: ["pipe", "pipe", "pipe"],
    });
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
node --import=tsx --test test/gemini-template.test.ts test/opencode/opencode-template.test.ts test/opencode-template.test.ts
npm run dist
npm run dist:check
```

Expected: template tests and dist checks pass.

Commit:

```bash
git add templates/gemini/hooks/hooks.json templates/gemini/gemini-extension.json templates/opencode/plugins/nams-hooks.js test/gemini-template.test.ts test/opencode/opencode-template.test.ts test/opencode-template.test.ts
git commit -m "feat: package ordered workspace hooks" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 7: Add Configure Command And Platform Setup Documentation

**Files:**
- Create: `src/runtime/config-writer.ts`
- Modify: `src/cli.ts`
- Modify: `src/platforms/claude/workspaces.ts`
- Modify: `src/platforms/codex/workspaces.ts`
- Modify: `test/cli-workspaces.test.ts`
- Create: `test/config-writer.test.ts`
- Modify: `README.md`
- Modify: `INSTALL.md`

- [ ] **Step 1: Add failing config writer tests**

Create `test/config-writer.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeNamsJsonConfig } from "../src/runtime/config-writer.js";

test("writes project NAMS config with private file mode", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-config-writer-"));
  try {
    const configPath = await writeNamsJsonConfig({
      scope: "project",
      projectDirectory: projectDir,
      values: {
        workspaceId: "workspace-1",
      },
    });

    assert.equal(configPath, path.join(projectDir, ".nams", "config.json"));
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { workspaceId: "workspace-1" });
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("preserves existing NAMS config keys when writing workspaceId", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-config-writer-"));
  try {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".nams", "config.json"),
      JSON.stringify({ apiKey: "existing-key", baseUrl: "https://memory.example.test" }),
      "utf8",
    );

    const configPath = await writeNamsJsonConfig({
      scope: "project",
      projectDirectory: projectDir,
      values: {
        workspaceId: "workspace-1",
      },
    });

    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      apiKey: "existing-key",
      baseUrl: "https://memory.example.test",
      workspaceId: "workspace-1",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Add failing configure command tests**

In `test/cli-workspaces.test.ts`, add:

```ts
test("workspace configure writes selected project workspace", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    createNamsFetchMock().workspaces({
      workspaces: [
        { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
        { id: "workspace-2", name: "Research", role: "member", status: "active" },
      ],
    });
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import=tsx",
        "src/cli.ts",
        "workspaces",
        "configure",
        "codex",
        "--scope",
        "project",
        "--workspace-id",
        "workspace-2",
      ],
      {
        cwd: projectDir,
        input: "",
        env: {
          ...process.env,
          HOME: path.join(projectDir, "home"),
          USERPROFILE: path.join(projectDir, "home"),
          NAMS_API_KEY: "key",
          NAMS_BASE_URL: "https://memory.example.test",
        },
      },
    );

    assert.match(stdout, /workspace-2/);
    const config = JSON.parse(await readFile(path.join(projectDir, ".nams", "config.json"), "utf8"));
    assert.equal(config.workspaceId, "workspace-2");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

Add imports:

```ts
import { readFile } from "node:fs/promises";
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
node --import=tsx --test test/config-writer.test.ts test/cli-workspaces.test.ts
```

Expected: fail because config writer and configure command are missing.

- [ ] **Step 4: Implement config writer**

Create `src/runtime/config-writer.ts`:

```ts
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writePrivateFile } from "./permissions.js";
import { RuntimeEnvironment } from "./paths.js";

export type NamsConfigWriteScope = "project" | "user";

export interface WriteNamsJsonConfigInput {
  scope: NamsConfigWriteScope;
  projectDirectory: string;
  values: {
    apiKey?: string;
    workspaceId?: string;
    baseUrl?: string;
  };
}

export async function writeNamsJsonConfig(input: WriteNamsJsonConfigInput): Promise<string> {
  const configPath = configPathForScope(input.scope, input.projectDirectory);
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const existing = await readExistingConfig(configPath);
  const nextConfig = {
    ...existing,
    ...(input.values.apiKey !== undefined ? { apiKey: input.values.apiKey } : {}),
    ...(input.values.workspaceId !== undefined ? { workspaceId: input.values.workspaceId } : {}),
    ...(input.values.baseUrl !== undefined ? { baseUrl: input.values.baseUrl } : {}),
  };
  await writePrivateFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  return configPath;
}

function configPathForScope(scope: NamsConfigWriteScope, projectDirectory: string): string {
  if (scope === "project") {
    return RuntimeEnvironment.fromProcess().projectConfigPath(projectDirectory);
  }
  const globalPath = RuntimeEnvironment.fromProcess().globalConfigPath();
  if (globalPath === undefined) {
    throw new Error("NAMS home directory is unavailable");
  }
  return globalPath;
}

async function readExistingConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}
```

- [ ] **Step 5: Implement configure command parser**

In `src/cli.ts`, add a CLI args variant:

```ts
| { command: "workspace-configure"; platform: Platform; scope: "project" | "user"; workspaceId?: string }
```

Extend `parseArgs`:

```ts
if (command === "workspaces" && platformArg === "configure") {
  const platform = argv[2];
  const scopeFlagIndex = argv.indexOf("--scope");
  const workspaceFlagIndex = argv.indexOf("--workspace-id");
  const scope = scopeFlagIndex >= 0 ? argv[scopeFlagIndex + 1] : undefined;
  const workspaceId = workspaceFlagIndex >= 0 ? argv[workspaceFlagIndex + 1] : undefined;
  if (isPlatform(platform) && (scope === "project" || scope === "user")) {
    return {
      command: "workspace-configure",
      platform,
      scope,
      ...(workspaceId !== undefined && workspaceId.trim() !== "" ? { workspaceId } : {}),
    };
  }
}
```

Add handler:

```ts
if (args.command === "workspace-configure") {
  const code = await configureWorkspace(args);
  return code;
}
```

Implement `configureWorkspace` in `src/cli.ts`:

```ts
async function configureWorkspace(args: { platform: Platform; scope: "project" | "user"; workspaceId?: string }): Promise<number> {
  const projectDirectory = process.cwd();
  const configResult = await loadNamsConnectionConfig(projectDirectory);
  if (!configResult.ok) {
    process.stderr.write(`${configDiagnosticPayload(configResult).message}\n`);
    return 1;
  }
  const client = new NamsWorkspaceClient({
    apiKey: configResult.config.apiKey,
    ...(configResult.config.baseUrl !== undefined ? { baseUrl: configResult.config.baseUrl } : {}),
  });
  const response = await client.listMyWorkspaces();
  const workspaces = (response.workspaces ?? []).filter((workspace) => typeof workspace.id === "string" && workspace.id.trim() !== "");
  const selectedWorkspace =
    args.workspaceId !== undefined
      ? workspaces.find((workspace) => workspace.id === args.workspaceId)
      : workspaces.length === 1
        ? workspaces[0]
        : undefined;
  if (selectedWorkspace === undefined) {
    process.stderr.write("NAMS workspace selection required. Re-run with --workspace-id and one of these IDs:\n");
    for (const workspace of workspaces) {
      process.stderr.write(`- ${workspace.name ?? "(unnamed workspace)"} (${workspace.role ?? "unknown-role"}, ${workspace.status ?? "unknown-status"}) - ${workspace.id}\n`);
    }
    return 2;
  }
  const configPath = await writeNamsJsonConfig({
    scope: args.scope,
    projectDirectory,
    values: { workspaceId: selectedWorkspace.id },
  });
  process.stdout.write(`NAMS workspace configured for ${args.platform}: ${selectedWorkspace.id}\n`);
  process.stdout.write(`Updated ${configPath}\n`);
  return 0;
}
```

Add imports:

```ts
import { NamsWorkspaceClient } from "./generated/nams-client.js";
import { configDiagnosticPayload, loadNamsConnectionConfig } from "./runtime/config.js";
import { writeNamsJsonConfig } from "./runtime/config-writer.js";
```

- [ ] **Step 6: Update README and INSTALL**

In `README.md`, replace the runtime configuration paragraph with text that says:

```md
Runtime configuration is JSON-first: `~/.nams/config.json`, optional project `.nams/config.json`, optional platform discovery such as Claude plugin user configuration, then final `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides. `apiKey` is required for NAMS requests. `workspaceId` is required unless the harness path supports workspace auto-resolution before memory starts. Runtime state and logs are user-local under per-platform directories in `~/.nams/state/` and `~/.nams/logs/`.
```

In `INSTALL.md`, add a subsection after the JSON config example:

````md
### Workspace Selection

Gemini can auto-select a single available workspace before memory starts when `NAMS_API_KEY` is configured and `workspaceId` is omitted. OpenCode can use the same single-workspace auto-resolution inside the NAMS plugin shim. Claude and Codex still require a configured `workspaceId` before hooks run.

To configure a workspace explicitly, run:

```bash
nams-hooks workspaces configure codex --scope project --workspace-id 11111111-1111-1111-1111-111111111111
```

Replace `codex` with the target harness name when configuring another platform, and replace the sample UUID with the workspace ID from your NAMS workspace list. For user-level defaults, use `--scope user`. If `--workspace-id` is omitted and your account has exactly one workspace, the command writes that workspace automatically. If your account has multiple workspaces, the command prints the available choices and exits without writing until you pass one ID explicitly.
````

- [ ] **Step 7: Verify and commit**

Run:

```bash
node --import=tsx --test test/config-writer.test.ts test/cli-workspaces.test.ts
rg -n "workspaceId|workspaces configure|auto-select|Claude|Codex" README.md INSTALL.md
npm run check
```

Expected: tests pass, docs contain platform-specific workspace setup text, and full check passes.

Commit:

```bash
git add src/runtime/config-writer.ts src/cli.ts test/config-writer.test.ts test/cli-workspaces.test.ts README.md INSTALL.md
git commit -m "feat: configure NAMS workspace selection" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 8: Final Integration Verification

**Files:**
- Verify only unless tests reveal missed docs or generated artifacts.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run check
npm run dist
npm run dist:check
```

Expected:

- OpenAPI generation leaves `src/generated/nams-client.ts` stable.
- TypeScript build passes.
- All tests pass.
- Distribution build and dist checks pass.

- [ ] **Step 2: Inspect generated package for workspace hooks**

Run:

```bash
rg -n "workspaces gemini --event BeforeAgent|workspaces configure|NAMS_WORKSPACE_ID|listMyWorkspaces|NamsWorkspaceClient|NamsClient|MemoryPlatformAdapter|WorkspacePlatformAdapter" src templates dist README.md INSTALL.md test
```

Expected:

- Gemini template and `dist/` include workspace command before memory command.
- OpenCode template and `dist/` include workspace phase before memory phase.
- Claude/Codex templates do not add sibling workspace first-prompt hooks.
- Generated `NamsClient` remains workspace-scoped and generated `NamsWorkspaceClient` includes `listMyWorkspaces`.
- Workspace client generator coverage lives in `test/nams-workspace-client-generator.test.ts`, separate from the agent-memory `test/nams-client-generator.test.ts` suite.
- `MemoryPlatformAdapter` and `WorkspacePlatformAdapter` are separate contracts.
- Docs mention configure and platform optionality.

- [ ] **Step 3: Verify no runtime dependencies were added**

Run:

```bash
node -e "const pkg=require('./package.json'); if (pkg.dependencies) { console.error(pkg.dependencies); process.exit(1); }"
```

Expected: exits `0`.

- [ ] **Step 4: Confirm final worktree state**

Run:

```bash
git status --short
```

Expected: no output. If there is output, inspect it with `git diff` and either complete the relevant task-specific commit or revert generated scratch files that are not source changes.

---

## Self-Review Checklist

- Spec coverage: generated workspace client, separate workspace command, session workspace state, Gemini sequential hooks, OpenCode ordered shim, Claude/Codex no sibling hooks, diagnostics, docs, and tests are covered.
- Plan hygiene scan: no unresolved task markers or unspecified implementation steps remain.
- Type consistency: `MemoryPlatformAdapter`, `WorkspacePlatformAdapter`, `WorkspaceHookEvent`, `InstallConfigure`, `SessionWorkspaceState`, `NamsClient`, `NamsWorkspaceClient`, `WorkspaceListResponse`, and `WorkspaceSummary` are named consistently across tasks.
- Client boundary check: `NamsClient` remains the agent-memory operations client; `NamsWorkspaceClient` is the NAMS infrastructure client and only includes `GET /v1/users/me/workspaces` in this change.
- Test boundary check: workspace client generator tests remain separate from the agent-memory generated client suite.
- Runtime dependency check: plan uses Node built-ins only for runtime additions.
- Safety check: no task logs API keys, bearer tokens, raw config contents, or arbitrary exception text.
