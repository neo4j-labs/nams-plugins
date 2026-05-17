# TypeScript Test Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the test suite from JavaScript-authored tests to TypeScript-authored tests while keeping Node `>=20`, Node's built-in `node:test` runner, and zero runtime npm dependencies.

**Architecture:** Production TypeScript remains compiled by the existing `tsconfig.json` into `.build/tsc`. Tests move to `.ts` files, execute through `node --import=tsx --test`, and get their own no-emit `tsconfig.test.json` type-check target. Most tests import source modules directly from `src/`; CLI and generated-client command tests keep exercising compiled `.build/tsc` artifacts.

**Tech Stack:** TypeScript 5.9, Node `node:test`, Node ESM with `NodeNext`, dev-only `tsx`, npm scripts, existing `fetch-mock` and `archunit` dev tools.

---

## Current Baseline

The current worktree is `codex/typescript-test-runner` at:

```text
/Users/jakub/workspaces/neo4j/nams/nams-hooks/.worktrees/typescript-test-runner
```

Baseline command already passed after merging `devel`:

```bash
npm run check
```

Expected current baseline:

```text
tests 166
pass 166
fail 0
```

## File Structure

Create:

- `tsconfig.test.json`: no-emit TypeScript config for `src/**/*.ts` and `test/**/*.ts`.

Modify:

- `package.json`: add `tsx` dev dependency through npm, add `test:typecheck`, switch `test` to TypeScript test files, and add `test:typecheck` to `check`.
- `package-lock.json`: updated by `npm install --save-dev tsx`.
- `test/**/*.test.ts`: renamed from `.js` and migrated to TypeScript.
- `test/support/*.ts`: renamed from `.js` and given explicit helper types.

Preserve compiled-artifact coverage in:

- `test/cli-session-start.test.ts`: keep executing `.build/tsc/cli.js`.
- `test/nams-client-generator.test.ts`: keep importing `.build/tsc/generated/nams-client.js`.

Convert source-facing imports in:

- `test/memory-service.test.ts`
- `test/runtime-config.test.ts`
- `test/runtime-paths.test.ts`
- `test/session-state.test.ts`
- `test/codex/codex-payload.test.ts`
- `test/codex/codex-memory-flow.test.ts`
- `test/codex/codex-transcript.test.ts`
- `test/gemini/gemini-payload.test.ts`
- `test/gemini/gemini-memory-flow.test.ts`
- `test/gemini/gemini-transcript.test.ts`
- `test/opencode/opencode-payload.test.ts`
- `test/opencode/opencode-memory-flow.test.ts`

Do not modify runtime source behavior under `src/`.

## Task 1: Add TypeScript Test Toolchain

**Files:**

- Create: `tsconfig.test.json`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add `tsx` as a dev dependency**

Run:

```bash
npm install --save-dev tsx
```

Expected:

```text
package.json updated with "tsx" in devDependencies
package-lock.json updated with tsx package entries
```

- [ ] **Step 2: Create test type-check config**

Create `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Add the type-check script without changing test execution yet**

Update only the `scripts` section in `package.json` so it contains this shape:

```json
{
  "openapi:generate": "node scripts/generate-nams-client.mjs",
  "build": "rm -rf .build/tsc && tsc -p tsconfig.json --outDir .build/tsc",
  "test:typecheck": "tsc -p tsconfig.test.json",
  "test": "node --test test/*.test.js test/**/*.test.js",
  "check": "npm run openapi:generate && npm run build && npm run test:typecheck && npm test",
  "dist": "rm -rf .build && tsc -p tsconfig.json --outDir .build/tsc && node scripts/build-dist.mjs",
  "dist:check": "node scripts/check-dist.mjs",
  "package:check": "npm run check && npm run dist && npm run dist:check"
}
```

- [ ] **Step 4: Run the new type-check gate**

Run:

```bash
npm run test:typecheck
```

Expected:

```text
PASS, because no test .ts files exist yet and src/**/*.ts already type-checks
```

- [ ] **Step 5: Run the full current suite**

Run:

```bash
npm run check
```

Expected:

```text
PASS, 166 tests, 0 failures
```

- [ ] **Step 6: Commit toolchain setup**

Run:

```bash
git add package.json package-lock.json tsconfig.test.json
git commit -m "test: add TypeScript test toolchain" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 2: Rename Tests And Switch Test Execution To `tsx`

**Files:**

- Modify: `package.json`
- Rename: all `test/**/*.js` files to `test/**/*.ts`

- [ ] **Step 1: Rename all test and support files**

Run:

```bash
git mv test/architecture.test.js test/architecture.test.ts
git mv test/cli-session-start.test.js test/cli-session-start.test.ts
git mv test/memory-service.test.js test/memory-service.test.ts
git mv test/nams-client-generator.test.js test/nams-client-generator.test.ts
git mv test/opencode-template.test.js test/opencode-template.test.ts
git mv test/runtime-config.test.js test/runtime-config.test.ts
git mv test/runtime-paths.test.js test/runtime-paths.test.ts
git mv test/session-state.test.js test/session-state.test.ts
git mv test/support/nams-fetch-mock.js test/support/nams-fetch-mock.ts
git mv test/support/runtime-home.js test/support/runtime-home.ts
git mv test/codex/codex-memory-flow.test.js test/codex/codex-memory-flow.test.ts
git mv test/codex/codex-payload.test.js test/codex/codex-payload.test.ts
git mv test/codex/codex-transcript.test.js test/codex/codex-transcript.test.ts
git mv test/gemini/gemini-memory-flow.test.js test/gemini/gemini-memory-flow.test.ts
git mv test/gemini/gemini-payload.test.js test/gemini/gemini-payload.test.ts
git mv test/gemini/gemini-transcript.test.js test/gemini/gemini-transcript.test.ts
git mv test/opencode/opencode-memory-flow.test.js test/opencode/opencode-memory-flow.test.ts
git mv test/opencode/opencode-payload.test.js test/opencode/opencode-payload.test.ts
git mv test/opencode/opencode-template.test.js test/opencode/opencode-template.test.ts
```

- [ ] **Step 2: Switch `npm test` to TypeScript tests**

Update the `test` script in `package.json`:

```json
"test": "node --import=tsx --test test/*.test.ts test/**/*.test.ts"
```

Keep the `check` script from Task 1:

```json
"check": "npm run openapi:generate && npm run build && npm run test:typecheck && npm test"
```

- [ ] **Step 3: Run test execution before type cleanup**

Run:

```bash
npm run build && npm test
```

Expected:

```text
PASS, because tsx can execute the renamed TypeScript tests even before strict test type errors are cleaned up
```

- [ ] **Step 4: Run strict test type-check and capture failures**

Run:

```bash
npm run test:typecheck
```

Expected:

```text
FAIL with TypeScript errors in test helper signatures and test-local callback parameters
```

Do not commit this task until Task 5 makes `npm run test:typecheck` pass.

## Task 3: Add Types To Shared Test Support

**Files:**

- Modify: `test/support/runtime-home.ts`
- Modify: `test/support/nams-fetch-mock.ts`

- [ ] **Step 1: Type `runtime-home` helper parameters and return values**

Update `test/support/runtime-home.ts` to this structure:

```ts
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../../src/interfaces.js";

export type TestEnvironment = Record<string, string | undefined>;

export interface RuntimeLogReadResult {
  logPath: string;
  lines: unknown[];
}

export function runtimeEnv(homeDir: string, extra: TestEnvironment = {}): TestEnvironment {
  return {
    ...extra,
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
}

export function namsHome(homeDir: string): string {
  return path.join(homeDir, ".nams");
}

export async function singleSessionLogPath(homeDir: string, platform: Platform): Promise<string> {
  const logDir = path.join(namsHome(homeDir), "logs", platform);
  const logFiles = (await readdir(logDir)).filter((fileName) => /^session-.*\.jsonl$/.test(fileName));
  assert.equal(logFiles.length, 1, `expected one ${platform} session log file, got ${logFiles.join(", ")}`);
  return path.join(logDir, logFiles[0]);
}

export async function readSingleSessionLog(homeDir: string, platform: Platform): Promise<RuntimeLogReadResult> {
  const logPath = await singleSessionLogPath(homeDir, platform);
  const text = await readFile(logPath, "utf8");
  return {
    logPath,
    lines: text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown),
  };
}

export async function sessionStateFiles(homeDir: string, platform: Platform): Promise<string[]> {
  try {
    return await readdir(path.join(namsHome(homeDir), "state", platform));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
```

- [ ] **Step 2: Type the NAMS fetch mock helper**

Update `test/support/nams-fetch-mock.ts` with explicit local types:

```ts
import fetchMock from "fetch-mock";

export const namsBaseUrl = "https://memory.example.test";

type RequestFilter = Parameters<ReturnType<typeof fetchMock.createInstance>["callHistory"]["calls"]>[0];
type RequestOptions = Parameters<ReturnType<typeof fetchMock.createInstance>["callHistory"]["calls"]>[1];
type RouteResponse = Record<string, unknown> | ((url: string, options: RequestInit) => unknown);
type FetchMockCall = {
  options: {
    body?: BodyInit | null;
  };
};

export interface NamsFetchMock {
  calls(filter?: RequestFilter, options?: RequestOptions): unknown[];
  requestBodies(filter?: RequestFilter, options?: RequestOptions): Array<unknown | undefined>;
  requestBody(callOrFilter?: FetchMockCall | RequestFilter, options?: RequestOptions): unknown | undefined;
  fetch: typeof fetch;
  createConversation(response?: Record<string, unknown>, status?: number): NamsFetchMock;
  context(response?: Record<string, unknown>, status?: number, conversationId?: string): NamsFetchMock;
  message(response?: Record<string, unknown>, status?: number, conversationId?: string): NamsFetchMock;
  searchEntities(response?: Record<string, unknown>, status?: number): NamsFetchMock;
  reasoningStep(response?: Record<string, unknown>, status?: number): NamsFetchMock;
  toolCall(response?: Record<string, unknown>, status?: number): NamsFetchMock;
  get(pathname: string, response: RouteResponse, status?: number, name?: string): NamsFetchMock;
  post(pathname: string, response: RouteResponse, status?: number, name?: string): NamsFetchMock;
  route(method: string, pathname: string, response: RouteResponse, status?: number, name?: string): NamsFetchMock;
  all(response: Record<string, unknown>, status?: number): NamsFetchMock;
  throws(error: Error): NamsFetchMock;
}

export function createNamsFetchMock(baseUrl = namsBaseUrl): NamsFetchMock {
  const mock = fetchMock.createInstance();
  const fetchHandler = mock.fetchHandler.bind(mock) as typeof fetch;
  globalThis.fetch = fetchHandler;

  const api: NamsFetchMock = {
    calls: (filter, options) => mock.callHistory.calls(filter, options),
    requestBodies: (filter, options) => api.calls(filter, options).map((call) => api.requestBody(call as FetchMockCall)),
    requestBody(callOrFilter, options) {
      const call =
        typeof callOrFilter === "object" && callOrFilter !== null && "options" in callOrFilter
          ? callOrFilter
          : (mock.callHistory.lastCall(callOrFilter, options) as FetchMockCall | undefined);
      if (!call?.options.body) {
        return undefined;
      }
      return JSON.parse(String(call.options.body)) as unknown;
    },
    fetch: fetchHandler,
    createConversation(response = { id: "conversation-1" }, status = 201) {
      return api.post("/v1/conversations", response, status, "createConversation");
    },
    context(response = {}, status = 200, conversationId = "conversation-1") {
      return api.get(`/v1/conversations/${conversationId}/context`, response, status, "getConversationContext");
    },
    message(response = { id: "message-1" }, status = 201, conversationId = "conversation-1") {
      return api.post(`/v1/conversations/${conversationId}/messages`, response, status, "addMessage");
    },
    searchEntities(response = {}, status = 200) {
      return api.post("/v1/entities/search", response, status, "searchEntities");
    },
    reasoningStep(response = { id: "step-1" }, status = 201) {
      return api.post("/v1/reasoning/steps", response, status, "addReasoningStep");
    },
    toolCall(response = { id: "tool-call-1" }, status = 201) {
      return api.post("/v1/reasoning/tool-calls", response, status, "addToolCall");
    },
    get(pathname, response, status = 200, name = undefined) {
      return api.route("GET", pathname, response, status, name);
    },
    post(pathname, response, status = 200, name = undefined) {
      return api.route("POST", pathname, response, status, name);
    },
    route(method, pathname, response, status = 200, name = undefined) {
      mock.route(
        { url: `${baseUrl}${pathname}`, method, name },
        typeof response === "function" ? response : { status, body: response },
      );
      return api;
    },
    all(response, status = 200) {
      mock.route({ url: `begin:${baseUrl}`, name: "fallback" }, { status, body: response });
      return api;
    },
    throws(error) {
      mock.route({ url: `begin:${baseUrl}`, name: "fallback" }, { throws: error });
      return api;
    },
  };

  return api;
}
```

- [ ] **Step 3: Run support type-check**

Run:

```bash
npm run test:typecheck
```

Expected:

```text
FAIL with errors in individual test files, not in test/support/runtime-home.ts or test/support/nams-fetch-mock.ts
```

## Task 4: Convert Source-Facing Tests To Static Source Imports

**Files:**

- Modify: `test/memory-service.test.ts`
- Modify: `test/runtime-config.test.ts`
- Modify: `test/runtime-paths.test.ts`
- Modify: `test/session-state.test.ts`
- Modify: `test/codex/codex-payload.test.ts`
- Modify: `test/codex/codex-memory-flow.test.ts`
- Modify: `test/codex/codex-transcript.test.ts`
- Modify: `test/gemini/gemini-payload.test.ts`
- Modify: `test/gemini/gemini-memory-flow.test.ts`
- Modify: `test/gemini/gemini-transcript.test.ts`
- Modify: `test/opencode/opencode-payload.test.ts`
- Modify: `test/opencode/opencode-memory-flow.test.ts`

- [ ] **Step 1: Replace runtime service dynamic imports**

In `test/memory-service.test.ts`, remove `fileURLToPath`, `pathToFileURL`, `repoRoot`, `clientUrl`, and `serviceUrl`. Add:

```ts
import { NamsClient } from "../src/generated/nams-client.js";
import { formatMemoryContext, NamsMemoryService } from "../src/runtime/memory-service.js";
```

Replace:

```ts
const { NamsClient } = await import(clientUrl);
const { NamsMemoryService } = await import(serviceUrl);
const { formatMemoryContext } = await import(serviceUrl);
```

with direct use of the imported symbols.

- [ ] **Step 2: Replace runtime config and paths dynamic imports**

In `test/runtime-config.test.ts`, remove the `.build/tsc` import URL setup and add:

```ts
import { configDiagnosticPayload, loadNamsConfig } from "../src/runtime/config.js";
```

In `test/runtime-paths.test.ts`, remove the `.build/tsc` import URL setup and add:

```ts
import {
  RuntimeEnvironment,
  globalConfigPath,
  platformLogDirectory,
  projectConfigPath,
  resolveNamsHome,
  sessionStatePath,
} from "../src/runtime/paths.js";
```

Replace every local `await import(configUrl)` and `await import(pathsUrl)` destructure with direct use of these imported symbols.

- [ ] **Step 3: Replace session-state dynamic imports**

In `test/session-state.test.ts`, remove the `.build/tsc` import URL setup and add:

```ts
import { createInitialSessionState, loadSessionState, resolveSessionKey, saveSessionState } from "../src/runtime/session-state.js";
```

Replace every `await import(stateUrl)` destructure with direct use of these imported symbols.

- [ ] **Step 4: Replace platform payload and transcript dynamic imports**

Add these static imports:

```ts
// test/codex/codex-payload.test.ts
import { parseCodexPayload } from "../../src/platforms/codex/payload.js";

// test/codex/codex-transcript.test.ts
import { readCodexTranscript } from "../../src/platforms/codex/transcript.js";

// test/gemini/gemini-payload.test.ts
import { parseGeminiPayload } from "../../src/platforms/gemini/payload.js";

// test/gemini/gemini-transcript.test.ts
import { readGeminiTranscript } from "../../src/platforms/gemini/transcript.js";

// test/opencode/opencode-payload.test.ts
import { parseOpenCodePayload } from "../../src/platforms/opencode/payload.js";
```

Remove each file's `.build/tsc` URL setup and replace `await import(...)` destructures with direct use of the imported parser or transcript function.

- [ ] **Step 5: Replace platform memory-flow dynamic imports**

Add these static imports:

```ts
// test/codex/codex-memory-flow.test.ts
import { CodexAdapter } from "../../src/platforms/codex/index.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../src/runtime/session-state.js";

// test/gemini/gemini-memory-flow.test.ts
import { GeminiAdapter } from "../../src/platforms/gemini/index.js";
import { loadSessionState } from "../../src/runtime/session-state.js";

// test/opencode/opencode-memory-flow.test.ts
import { OpenCodeAdapter } from "../../src/platforms/opencode/index.js";
import { loadSessionState } from "../../src/runtime/session-state.js";
```

Remove each file's adapter and session-state URL setup. Replace every `await import(...)` destructure with direct use of the imported classes and functions.

- [ ] **Step 6: Keep compiled artifact tests intentionally compiled**

Confirm these files still reference `.build/tsc`:

```bash
rg "\\.build/tsc" test/cli-session-start.test.ts test/nams-client-generator.test.ts
```

Expected:

```text
test/cli-session-start.test.ts contains .build/tsc/cli.js
test/nams-client-generator.test.ts contains .build/tsc/generated/nams-client.js
```

- [ ] **Step 7: Confirm source-facing `.build/tsc` imports are gone**

Run:

```bash
rg "\\.build/tsc" test
```

Expected remaining matches only in:

```text
test/cli-session-start.test.ts
test/nams-client-generator.test.ts
```

## Task 5: Fix Strict TypeScript Errors In Test Files

**Files:**

- Modify: all renamed `test/**/*.ts` files with `npm run test:typecheck` errors.

- [ ] **Step 1: Add common local type aliases where helpers return child-process results**

In `test/cli-session-start.test.ts`, add:

```ts
interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

type HookPayload = Record<string, unknown>;
```

Use these helper signatures:

```ts
function runCliWithEvent(
  harness: string,
  event: string,
  payload: HookPayload,
  cwd: string,
  homeDir = testHome(cwd),
): Promise<CliResult> {
```

```ts
function runCli(harness: string, payload: HookPayload, cwd: string, homeDir?: string): Promise<CliResult> {
```

```ts
function runCliWithoutEvent(
  harness: string,
  payload: HookPayload,
  cwd: string,
  homeDir = testHome(cwd),
): Promise<CliResult> {
```

```ts
function testHome(cwd: string): string {
```

- [ ] **Step 2: Add platform test helper types**

In each memory-flow test file, use local environment types:

```ts
type TestEnvOverrides = Record<string, string | undefined>;

function testEnv(projectDir: string, overrides: TestEnvOverrides = {}): TestEnvOverrides {
```

Apply this to:

- `test/codex/codex-memory-flow.test.ts`
- `test/gemini/gemini-memory-flow.test.ts`
- `test/opencode/opencode-memory-flow.test.ts`

- [ ] **Step 3: Add remaining helper function parameter and return types**

Use these exact helper signatures where TypeScript reports implicit `any` parameters:

```ts
type TestPayload = Record<string, unknown>;

function restoreEnv(name: string, value: string | undefined): void {
```

```ts
function useRuntimeHome(homeDir: string): void {
```

```ts
function useRuntimeEnv(homeDir: string, overrides: Record<string, string | undefined> = {}): void {
```

```ts
function sha256(value: string): string {
```

```ts
function escapeRegExp(value: string): string {
```

```ts
function chatMessagePayload(projectDir: string, sessionID: string, messageID: string, text: string): TestPayload {
```

```ts
function chatMessageTemplatePayload(
  projectDir: string,
  sessionID: string,
  messageID: string,
  text: string,
): TestPayload {
```

```ts
function systemTransformPayload(projectDir: string, sessionID: string): TestPayload {
```

```ts
function toPublicEndpoint({
  methodName,
  httpMethod,
  path,
}: {
  methodName: string;
  httpMethod: string;
  path: string;
}): {
  methodName: string;
  httpMethod: string;
  path: string;
} {
```

```ts
function pathPlaceholders(endpointPath: string): string[] {
```

Keep each helper body unchanged unless TypeScript reports a type mismatch inside that body.

- [ ] **Step 4: Type architecture helper functions**

In `test/architecture.test.ts`, add:

```ts
interface ArchRule {
  check(): Promise<unknown[]>;
}

interface SourceFile {
  path: string;
  content: string;
}
```

Use:

```ts
async function assertNoViolations(rule: ArchRule): Promise<void> {
```

```ts
async function assertNoGeneratedImportsFrom(folder: string): Promise<void> {
```

```ts
function importedSourcePaths(filePath: string, content: string): string[] {
```

```ts
function importsConcreteAdapter(file: SourceFile): boolean {
```

- [ ] **Step 5: Type template fixture helpers**

In `test/opencode/opencode-template.test.ts`, add:

```ts
interface TemplateFixture {
  fixtureDir: string;
  commandPath: string;
  callsPath: string;
  templatePath: string;
}

interface TemplateModule {
  NamsHooks: unknown;
}
```

Update fixture helpers to return `Promise<TemplateFixture>` and dynamic template imports to return `Promise<TemplateModule>`.

- [ ] **Step 6: Run type-check until it passes**

Run:

```bash
npm run test:typecheck
```

Expected:

```text
PASS
```

Fix only reported TypeScript errors in tests. Do not change runtime behavior to satisfy test types.

- [ ] **Step 7: Run test execution**

Run:

```bash
npm run build && npm test
```

Expected:

```text
PASS, 166 tests, 0 failures
```

- [ ] **Step 8: Commit TypeScript test migration**

Run:

```bash
git add package.json package-lock.json tsconfig.test.json test
git commit -m "test: migrate suite to TypeScript" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 6: Documentation Sync And Final Verification

**Files:**

- Modify: `docs/superpowers/specs/2026-05-16-typescript-test-runner-design.md`

- [ ] **Step 1: Sync the design doc with the post-merge script shape**

In `docs/superpowers/specs/2026-05-16-typescript-test-runner-design.md`, update the `npm run check` sequence in the Recommended Approach section from:

```markdown
1. `npm run openapi:check`
2. `npm run build`
3. the test type-check target
4. `npm test`
```

to:

```markdown
1. `npm run openapi:generate`
2. `npm run build`
3. the test type-check target
4. `npm test`
```

In the Configuration section, replace:

```markdown
- `openapi:test`: keep its OpenAPI-specific regeneration/build/test behavior, updated for the `.ts` test filename
```

with:

```markdown
- generated client tests: continue to run through `test/nams-client-generator.test.ts` as part of `npm test`
```

In Acceptance Criteria, replace:

```markdown
- `npm run openapi:test` still validates the generated NAMS client workflow.
```

with:

```markdown
- Generated NAMS client tests still validate the generated client workflow as part of `npm test`.
```

- [ ] **Step 2: Check script shape**

Run:

```bash
node -e "const p=require('./package.json'); console.log(JSON.stringify(p.scripts,null,2))"
```

Expected scripts:

```json
{
  "openapi:generate": "node scripts/generate-nams-client.mjs",
  "build": "rm -rf .build/tsc && tsc -p tsconfig.json --outDir .build/tsc",
  "test:typecheck": "tsc -p tsconfig.test.json",
  "test": "node --import=tsx --test test/*.test.ts test/**/*.test.ts",
  "check": "npm run openapi:generate && npm run build && npm run test:typecheck && npm test",
  "dist": "rm -rf .build && tsc -p tsconfig.json --outDir .build/tsc && node scripts/build-dist.mjs",
  "dist:check": "node scripts/check-dist.mjs",
  "package:check": "npm run check && npm run dist && npm run dist:check"
}
```

- [ ] **Step 3: Confirm JavaScript tests are gone**

Run:

```bash
rg --files test | rg "\\.js$"
```

Expected:

```text
No output
```

- [ ] **Step 4: Confirm `tsx` is dev-only**

Run:

```bash
node -e "const p=require('./package.json'); console.log(Boolean(p.dependencies?.tsx), Boolean(p.devDependencies?.tsx))"
```

Expected:

```text
false true
```

- [ ] **Step 5: Confirm runtime source does not import `tsx`**

Run:

```bash
rg "from \"tsx\"|from 'tsx'|--import=tsx|\\btsx\\b" src templates scripts
```

Expected:

```text
No output
```

- [ ] **Step 6: Run full verification**

Run:

```bash
npm run check
```

Expected:

```text
PASS, 166 tests, 0 failures
```

- [ ] **Step 7: Run package verification**

Run:

```bash
npm run package:check
```

Expected:

```text
PASS
```

- [ ] **Step 8: Commit final verification/doc sync if files changed**

If Step 1 through Step 6 changed files, run:

```bash
git add docs/superpowers/specs/2026-05-16-typescript-test-runner-design.md package.json package-lock.json tsconfig.test.json test
git commit -m "test: verify TypeScript test runner migration" -m "Co-authored-by: Codex <codex@openai.com>"
```

If no files changed, skip the commit and record the verification output in the final implementation summary.

## Implementation Notes

- Keep `.js` import specifiers when importing local TypeScript source. The project uses `moduleResolution: "NodeNext"`, so `../src/runtime/config.js` resolves to `../src/runtime/config.ts` during type-checking and remains valid ESM at runtime.
- Do not add `tsx` to `dependencies`.
- Do not use `npx` in package scripts.
- Do not commit `.build/`, `dist/`, `.nams/`, or `node_modules/`.
- If TypeScript reports a real mismatch between a test fixture and source contract, fix the fixture unless the source contract is clearly wrong.
- If `npm run package:check` changes `src/generated/nams-client.ts` through `openapi:generate`, review the generated diff and include it only when it matches the current `docs/nams-openapi.json`.
