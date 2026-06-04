# NAMS Workspace ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require `workspaceId` in NAMS runtime configuration and send it as `X-Workspace-Id` on every NAMS API request.

**Architecture:** Add `workspaceId` to the existing shared config loader so global JSON, project JSON, and environment overrides behave exactly like `apiKey`. Pass the resolved value through `createNamsMemoryService()` into the generated dependency-free `NamsClient`, and have the generated request helper force `X-Workspace-Id` for every request. Platform adapters keep their current boundaries and only observe the stricter shared config result.

**Tech Stack:** TypeScript, Node.js built-ins for runtime, Node's `node:test`, current `fetch-mock` test helper, custom OpenAPI generator, and the existing `npm run check` pipeline.

**Completion Note:** Implemented in this feature branch on 2026-06-03. The runtime config, generated client header, platform flow tests, README/INSTALL updates, and full verification task were executed; this plan remains as the historical implementation checklist.

---

## File Structure

Modify:

- `test/runtime-config.test.ts`: workspace config hierarchy, missing-workspace diagnostics, and environment cleanup.
- `src/runtime/config.ts`: `workspaceId` config field, source metadata, JSON parsing, env override, and missing-config result.
- `test/nams-client-generator.test.ts`: generated client option/header tests and request-log expectations.
- `scripts/generate-nams-client.mjs`: generated `NamsClientOptions.workspaceId` and `X-Workspace-Id` request header.
- `src/generated/nams-client.ts`: regenerated output from `npm run openapi:generate`.
- `test/memory-service.test.ts`: direct `NamsClient` construction with `workspaceId`.
- `src/runtime/memory-service.ts`: pass `config.workspaceId` to `NamsClient`.
- `test/gemini/gemini-memory-flow.test.ts`: add `NAMS_WORKSPACE_ID`, assert request header/log source on one flow, and update missing-config tests.
- `test/codex/codex-memory-flow.test.ts`: add `NAMS_WORKSPACE_ID` to successful NAMS env fixtures and update missing-config source assertions.
- `test/claude/claude-memory-flow.test.ts`: add `NAMS_WORKSPACE_ID` to successful NAMS env fixtures and update missing-config source assertions.
- `test/opencode/opencode-memory-flow.test.ts`: add `NAMS_WORKSPACE_ID`, assert config sources on one flow, and update missing-config tests.
- `README.md`: document required `workspaceId` and `NAMS_WORKSPACE_ID`.
- `INSTALL.md`: show `workspaceId` in config examples and environment overrides.

No new files are required beyond this plan. Do not modify platform payload parsers for workspace behavior.

## Public Runtime Contract

```ts
// src/runtime/config.ts
export interface NamsRuntimeConfig {
  apiKey: string;
  workspaceId: string;
  baseUrl?: string;
}

export interface NamsConfigSources {
  apiKey: "missing" | "global:~/.nams/config.json" | "project:.nams/config.json" | "env:NAMS_API_KEY";
  workspaceId: "missing" | "global:~/.nams/config.json" | "project:.nams/config.json" | "env:NAMS_WORKSPACE_ID";
  baseUrl: "default" | "global:~/.nams/config.json" | "project:.nams/config.json" | "env:NAMS_BASE_URL";
}
```

```ts
// src/generated/nams-client.ts
export interface NamsClientOptions {
  baseUrl?: string;
  apiKey: string;
  workspaceId: string;
  defaultHeaders?: Record<string, string>;
  fetch?: typeof fetch;
  onRequest?: (event: NamsRequestEvent) => void | Promise<void>;
}
```

---

### Task 1: Add Workspace ID To Runtime Config

**Files:**

- Modify: `test/runtime-config.test.ts`
- Modify: `src/runtime/config.ts`

- [ ] **Step 1: Write failing config tests**

Update `useRuntimeEnv()` in `test/runtime-config.test.ts` so tests do not leak workspace overrides:

```ts
function useRuntimeEnv(homeDir: string, overrides: RuntimeEnvOverrides = {}): void {
  for (const key of ["HOME", "USERPROFILE", "NAMS_API_KEY", "NAMS_WORKSPACE_ID", "NAMS_BASE_URL"]) {
    delete process.env[key];
  }
  Object.assign(process.env, { HOME: homeDir, USERPROFILE: homeDir, ...overrides });
}
```

Update the existing successful config tests so each fixture includes and expects `workspaceId`. For example, the first test should use this expected result:

```ts
assert.deepEqual(result, {
  ok: true,
  config: {
    apiKey: "global-key",
    workspaceId: "global-workspace",
    baseUrl: "https://global.example.test",
  },
  sources: {
    apiKey: "global:~/.nams/config.json",
    workspaceId: "global:~/.nams/config.json",
    baseUrl: "global:~/.nams/config.json",
  },
});
```

Add this test after `environment variables overlay project and global JSON config`:

```ts
test("workspaceId follows apiKey source priority", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await writeGlobalConfig(homeDir, {
      apiKey: "global-key",
      workspaceId: "global-workspace",
      baseUrl: "https://global.example.test",
    });
    await writeProjectConfig(projectDir, {
      workspaceId: "project-workspace",
    });
    useRuntimeEnv(homeDir, {
      NAMS_WORKSPACE_ID: "env-workspace",
    });
    const result = await loadNamsConfig(projectDir);

    assert.deepEqual(result, {
      ok: true,
      config: {
        apiKey: "global-key",
        workspaceId: "env-workspace",
        baseUrl: "https://global.example.test",
      },
      sources: {
        apiKey: "global:~/.nams/config.json",
        workspaceId: "env:NAMS_WORKSPACE_ID",
        baseUrl: "global:~/.nams/config.json",
      },
    });
  });
});
```

Add this missing-workspace test after the existing missing-`apiKey` test:

```ts
test("missing workspaceId returns structured non-ok result", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await writeGlobalConfig(homeDir, {
      apiKey: "global-key",
    });
    useRuntimeEnv(homeDir);
    const result = await loadNamsConfig(projectDir);

    assert.deepEqual(result, {
      ok: false,
      reason: "missing-workspace-id",
      sources: {
        apiKey: "global:~/.nams/config.json",
        workspaceId: "missing",
        baseUrl: "default",
      },
    });
  });
});
```

Update the `configDiagnosticPayload includes sources but not secret values` test so the loaded config includes `workspaceId: "global-workspace"` and the diagnostic expectation includes `workspaceId: "global:~/.nams/config.json"`.

- [ ] **Step 2: Verify red**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/runtime-config.test.ts
```

Expected: FAIL because `NamsConfigSources` has no `workspaceId`, JSON config parsing ignores `workspaceId`, and `missing-workspace-id` is not a valid result reason.

- [ ] **Step 3: Implement config support**

In `src/runtime/config.ts`, update the shared types:

```ts
export interface NamsRuntimeConfig {
  apiKey: string;
  workspaceId: string;
  baseUrl?: string;
}

export type ConfigSource =
  | "missing"
  | "global:~/.nams/config.json"
  | "project:.nams/config.json"
  | "env:NAMS_API_KEY";
export type WorkspaceIdSource =
  | "missing"
  | "global:~/.nams/config.json"
  | "project:.nams/config.json"
  | "env:NAMS_WORKSPACE_ID";
export type BaseUrlSource =
  | "default"
  | "global:~/.nams/config.json"
  | "project:.nams/config.json"
  | "env:NAMS_BASE_URL";

export interface NamsConfigSources {
  apiKey: ConfigSource;
  workspaceId: WorkspaceIdSource;
  baseUrl: BaseUrlSource;
}
```

Add the missing result variant:

```ts
  | {
      ok: false;
      reason: "missing-workspace-id";
      sources: NamsConfigSources;
    }
```

Update `configDiagnosticPayload()`:

```ts
  if (result.reason === "invalid-json") {
    return {
      message: "NAMS config invalid",
      configSources: result.sources,
      errorSource: result.errorSource,
    };
  }
  if (result.reason === "missing-workspace-id") {
    return {
      message: "NAMS workspaceId missing",
      configSources: result.sources,
    };
  }
  return {
    message: "NAMS apiKey missing",
    configSources: result.sources,
  };
```

Initialize `workspaceId` in both source helpers:

```ts
const sources: NamsConfigSources = {
  apiKey: "missing",
  workspaceId: "missing",
  baseUrl: "default",
};
```

```ts
function defaultSources(): NamsConfigSources {
  return {
    apiKey: "missing",
    workspaceId: "missing",
    baseUrl: "default",
  };
}
```

Extend `JsonConfig` and `readJsonConfig()`:

```ts
interface JsonConfig {
  apiKey?: string;
  workspaceId?: string;
  baseUrl?: string;
}
```

```ts
config: {
  ...(nonBlankString(parsed.apiKey) !== undefined ? { apiKey: nonBlankString(parsed.apiKey) } : {}),
  ...(nonBlankString(parsed.workspaceId) !== undefined ? { workspaceId: nonBlankString(parsed.workspaceId) } : {}),
  ...(nonBlankString(parsed.baseUrl) !== undefined ? { baseUrl: nonBlankString(parsed.baseUrl) } : {}),
},
```

Extend `applyJsonConfig()`:

```ts
if (config.workspaceId !== undefined) {
  accumulated.workspaceId = config.workspaceId;
  sources.workspaceId = source;
}
```

Extend `applyEnvironmentOverrides()`:

```ts
const workspaceId = runtimeEnvironment.value("NAMS_WORKSPACE_ID");
if (workspaceId !== undefined) {
  accumulated.workspaceId = workspaceId;
  sources.workspaceId = "env:NAMS_WORKSPACE_ID";
}
```

Add the missing check after the existing API key check:

```ts
if (accumulated.workspaceId === undefined) {
  return {
    ok: false,
    reason: "missing-workspace-id",
    sources,
  };
}
```

Return the required config:

```ts
config: {
  apiKey: accumulated.apiKey,
  workspaceId: accumulated.workspaceId,
  ...(accumulated.baseUrl !== undefined ? { baseUrl: accumulated.baseUrl } : {}),
},
```

- [ ] **Step 4: Verify green**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/runtime-config.test.ts
```

Expected: PASS for all runtime config tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/config.ts test/runtime-config.test.ts
git commit -m "feat: require workspace ID in runtime config" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Generate Workspace Header In NAMS Client

**Files:**

- Modify: `test/nams-client-generator.test.ts`
- Modify: `test/memory-service.test.ts`
- Modify: `src/runtime/memory-service.ts`
- Modify: `scripts/generate-nams-client.mjs`
- Modify: `src/generated/nams-client.ts`

- [ ] **Step 1: Write failing generated-client tests**

In every `new NamsClient({ ... })` in `test/nams-client-generator.test.ts` and `test/memory-service.test.ts`, add:

```ts
workspaceId: "workspace-1",
```

In `test/nams-client-generator.test.ts`, update `generated NAMS client sends bearer JSON requests`:

```ts
assert.equal(requests[0].init.headers.Authorization, "Bearer test-key");
assert.equal(requests[0].init.headers["X-Workspace-Id"], "workspace-1");
assert.equal(requests[0].init.headers["Content-Type"], "application/json");
```

In `generated NAMS client sends configured default headers on POST and GET requests`, add an overriding default header:

```ts
defaultHeaders: {
  "X-NAMS-Hooks-Harness": "gemini",
  "X-NAMS-Hooks-Version": "0.1.0",
  "X-NAMS-Hooks-Platform": "darwin",
  "X-NAMS-Hooks-Node-Version": "v26.0.0",
  "X-NAMS-Hooks-Event": "BeforeAgent",
  "X-Workspace-Id": "wrong-workspace",
  Authorization: "Bearer wrong-key",
  Accept: "text/plain",
},
```

Add this assertion inside the loop:

```ts
assert.equal(request.init.headers["X-Workspace-Id"], "workspace-1");
```

Update request-log expectations to include the workspace header. For example, in `generated NAMS client reports request and response details`, expect:

```ts
headers: {
  "X-Workspace-Id": "workspace-1",
  Accept: "application/json",
  "Content-Type": "application/json",
},
```

In GET and failure request-log expectations, use:

```ts
headers: {
  "X-Workspace-Id": "workspace-1",
  Accept: "application/json",
},
```

- [ ] **Step 2: Verify red**

Run:

```bash
npm run openapi:generate && npm run build && npm run test:typecheck && node --import=tsx --test test/nams-client-generator.test.ts test/memory-service.test.ts
```

Expected: FAIL because generated `NamsClientOptions` does not accept `workspaceId` and generated requests do not send `X-Workspace-Id`.

- [ ] **Step 3: Update generator**

In `scripts/generate-nams-client.mjs`, add `workspaceId` to the emitted options block:

```js
"export interface NamsClientOptions {",
"  baseUrl?: string;",
"  apiKey: string;",
"  workspaceId: string;",
"  defaultHeaders?: Record<string, string>;",
"  fetch?: typeof fetch;",
"  onRequest?: (event: NamsRequestEvent) => void | Promise<void>;",
"}",
```

Add a private field:

```js
"  private readonly workspaceId: string;",
```

Set it in the emitted constructor:

```js
"    this.workspaceId = options.workspaceId;",
```

Force the header in the emitted request helper immediately after `Authorization`:

```js
"    setHeader(headers, \"Authorization\", `Bearer ${this.apiKey}`);",
"    setHeader(headers, \"X-Workspace-Id\", this.workspaceId);",
```

- [ ] **Step 4: Pass workspace ID into NamsClient**

In `src/runtime/memory-service.ts`, update `createNamsMemoryService()`:

```ts
const client = new NamsClient({
  apiKey: config.apiKey,
  workspaceId: config.workspaceId,
  ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
  defaultHeaders: namsProvenanceHeaders(invocation),
  onRequest: (event) => appendNamsRequestLog(invocation, state, event),
});
```

- [ ] **Step 5: Regenerate client**

Run:

```bash
npm run openapi:generate
```

Expected: `src/generated/nams-client.ts` is updated with `workspaceId` option, private field, constructor assignment, and `X-Workspace-Id` request header.

- [ ] **Step 6: Verify green**

Run:

```bash
npm run build && npm run test:typecheck && node --import=tsx --test test/nams-client-generator.test.ts test/memory-service.test.ts
```

Expected: PASS for generated-client and memory-service tests.

- [ ] **Step 7: Commit**

```bash
git add scripts/generate-nams-client.mjs src/generated/nams-client.ts src/runtime/memory-service.ts test/nams-client-generator.test.ts test/memory-service.test.ts
git commit -m "feat: send NAMS workspace header" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Update Platform Memory Flows For Workspace Config

**Files:**

- Modify: `test/gemini/gemini-memory-flow.test.ts`
- Modify: `test/codex/codex-memory-flow.test.ts`
- Modify: `test/claude/claude-memory-flow.test.ts`
- Modify: `test/opencode/opencode-memory-flow.test.ts`

- [ ] **Step 1: Verify platform suites are red after stricter config**

Run:

```bash
npm run build && npm run test:typecheck && node --import=tsx --test test/gemini/gemini-memory-flow.test.ts test/codex/codex-memory-flow.test.ts test/claude/claude-memory-flow.test.ts test/opencode/opencode-memory-flow.test.ts
```

Expected: FAIL in successful NAMS memory-flow tests because those fixtures set `NAMS_API_KEY` but do not yet set `NAMS_WORKSPACE_ID`.

- [ ] **Step 2: Update platform flow tests**

In each platform test file, update the local `testEnv()` cleanup list:

```ts
for (const key of ["HOME", "USERPROFILE", "NAMS_API_KEY", "NAMS_WORKSPACE_ID", "NAMS_BASE_URL"]) {
  delete process.env[key];
}
```

In every successful NAMS fixture that currently sets `NAMS_API_KEY: "key"`, add:

```ts
NAMS_WORKSPACE_ID: "workspace-1",
```

In the primary successful flow in `test/gemini/gemini-memory-flow.test.ts`, add:

```ts
assert.equal(createConversationHeaders["x-workspace-id"], "workspace-1");
```

In the same Gemini config diagnostic assertion, expect:

```ts
assert.deepEqual(configDiagnostics[0].payload.configSources, {
  apiKey: "env:NAMS_API_KEY",
  workspaceId: "env:NAMS_WORKSPACE_ID",
  baseUrl: "env:NAMS_BASE_URL",
});
```

In the primary successful OpenCode flow, update the same config source assertion:

```ts
assert.deepEqual(configDiagnostics[0].payload.configSources, {
  apiKey: "env:NAMS_API_KEY",
  workspaceId: "env:NAMS_WORKSPACE_ID",
  baseUrl: "env:NAMS_BASE_URL",
});
```

Update missing-`apiKey` expected source objects in Claude, Codex, Gemini, and OpenCode tests to include:

```ts
workspaceId: "missing",
```

Add one missing-workspace test in `test/gemini/gemini-memory-flow.test.ts` after the missing-`apiKey` test:

```ts
test("Gemini BeforeAgent continues when NAMS_WORKSPACE_ID is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
  try {
    const nams = createNamsFetchMock().all({ error: "unexpected NAMS call" }, 500);
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new GeminiAdapter();

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "remember this",
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.equal(nams.calls().length, 0);

    const { lines } = await readSingleSessionLog(projectDir);
    const diagnostics = lines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS workspaceId missing",
    );
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0].payload.configSources, {
      apiKey: "env:NAMS_API_KEY",
      workspaceId: "missing",
      baseUrl: "env:NAMS_BASE_URL",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Verify green**

Run:

```bash
npm run build && npm run test:typecheck && node --import=tsx --test test/gemini/gemini-memory-flow.test.ts test/codex/codex-memory-flow.test.ts test/claude/claude-memory-flow.test.ts test/opencode/opencode-memory-flow.test.ts
```

Expected: PASS for platform memory-flow tests.

- [ ] **Step 4: Commit**

```bash
git add test/gemini/gemini-memory-flow.test.ts test/codex/codex-memory-flow.test.ts test/claude/claude-memory-flow.test.ts test/opencode/opencode-memory-flow.test.ts
git commit -m "feat: apply workspace config to memory flows" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Document Workspace Configuration

**Files:**

- Modify: `README.md`
- Modify: `INSTALL.md`

- [ ] **Step 1: Write documentation updates**

In `README.md`, replace the runtime configuration paragraph with:

```md
Runtime configuration is JSON-first: `~/.nams/config.json`, optional project `.nams/config.json`, then final `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides. `apiKey` and `workspaceId` are required for NAMS requests. Runtime state and logs are user-local under `~/.nams/state/<platform>/` and `~/.nams/logs/<platform>/`.
```

In `INSTALL.md`, replace the user-global config example with:

```json
{
  "apiKey": "nams-api-key",
  "workspaceId": "5e5c0535-8d85-491c-b92c-33be13659998",
  "baseUrl": "https://memory.neo4jlabs.com"
}
```

Replace the sentence under that example with:

```md
`apiKey` and `workspaceId` are required for NAMS requests. `baseUrl` is optional and defaults to the runtime client's built-in NAMS URL.
```

Replace the project override example with:

```json
{
  "workspaceId": "project-workspace-id"
}
```

Replace the project override explanation with:

```md
Projects may override any key with `<project>/.nams/config.json`. A common setup is a global `apiKey` with project-specific `workspaceId` values.
```

Replace the environment override list with:

```md
- `NAMS_API_KEY` overrides `apiKey`.
- `NAMS_WORKSPACE_ID` overrides `workspaceId`.
- `NAMS_BASE_URL` overrides `baseUrl`.
```

Replace the OpenCode configuration paragraph with:

```md
OpenCode uses the same NAMS configuration hierarchy as other harnesses: `~/.nams/config.json`, optional project `.nams/config.json`, then final `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides.
```

- [ ] **Step 2: Verify docs mention workspace override**

Run:

```bash
rg -n "workspaceId|NAMS_WORKSPACE_ID|NAMS_API_KEY|NAMS_BASE_URL" README.md INSTALL.md
```

Expected: output includes `workspaceId` and `NAMS_WORKSPACE_ID` in both files.

- [ ] **Step 3: Commit**

```bash
git add README.md INSTALL.md
git commit -m "docs: document NAMS workspace config" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Full Verification And Final Cleanup

**Files:**

- Inspect: all files changed by Tasks 1-4

- [ ] **Step 1: Run full repository check**

Run:

```bash
npm run check
```

Expected: PASS. This runs OpenAPI generation, TypeScript build, test typechecking, and the full test suite.

- [ ] **Step 2: Verify no runtime OpenAPI behavior was introduced**

Run:

```bash
rg -n "openapi|nams-openapi|readFile\\(" src scripts test | head -50
```

Expected: OpenAPI reads appear only in generator/tests/scripts. No platform adapter or runtime hook path reads `docs/nams-openapi.json`.

- [ ] **Step 3: Verify workspace ID is not platform-parsed**

Run:

```bash
rg -n "workspaceId|NAMS_WORKSPACE_ID|X-Workspace-Id" src/platforms src/cli.ts src/interfaces.ts
```

Expected: no matches in `src/platforms`, `src/cli.ts`, or `src/interfaces.ts`.

- [ ] **Step 4: Review git diff**

Run:

```bash
git diff --stat HEAD~4..HEAD
git status --short
```

Expected: status is clean after all task commits. The diff includes config, generated client, memory-service, tests, and docs.

- [ ] **Step 5: Confirm no cleanup commit is needed**

Run:

```bash
git status --short
```

Expected: empty output. If this command prints files, stop and inspect those files before reporting completion.

## Self-Review Notes

- Spec coverage: Tasks 1-4 cover config resolution, request header generation, platform fail-open behavior, and docs. Task 5 covers full verification and architecture guardrails.
- Type consistency: The plan uses `workspaceId`, `NAMS_WORKSPACE_ID`, and `X-Workspace-Id` consistently.
- Scope check: This is one shared runtime/client change. No platform parser, installer command, entity behavior, or runtime OpenAPI behavior is added.
