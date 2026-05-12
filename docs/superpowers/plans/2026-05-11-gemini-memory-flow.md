# Gemini Memory Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Gemini CLI memory flow: create NAMS conversations on first utterance, recall before first response, persist user and assistant messages, then record exposed Gemini reasoning and tool metadata without storing tool output.

**Architecture:** `src/cli.ts` remains a gateway that routes typed hook events through the platform registry. Gemini-specific payload and transcript parsing stays in Gemini platform modules. Shared runtime modules handle config, local state, hashing, logging, and NAMS REST calls through the generated `NamsClient`.

**Tech Stack:** TypeScript, Node.js built-ins, Node's `node:test`, generated `NamsClient`, and ArchUnitTS as a dev-only architecture-test dependency.

---

## Scope

This plan implements Phase 1 and Phase 2 from `docs/superpowers/specs/2026-05-11-gemini-memory-flow-design.md`.

Included:

- Architecture tests that enforce downstream-only imports.
- Gemini `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool` routing.
- Config loading from `.nams/.env` with process environment fallback.
- Local session state under `.nams/state/sessions/gemini/`.
- Gemini payload parsing and transcript parsing.
- NAMS conversation creation on first `BeforeAgent` utterance only.
- First-response recall and Gemini `additionalContext` injection.
- User prompt persistence.
- Assistant response persistence from `prompt_response`, with transcript fallback.
- Exposed transcript `thoughts` as NAMS reasoning steps.
- Gemini `AfterTool` and transcript `toolCalls[]` as NAMS tool metadata, excluding output fields.

Deferred to later plans:

- Conservative reconstruction of a missing local state file from a saved Gemini transcript.
- Trace explanation polish beyond deterministic same-entry reasoning/tool association.
- Installer and doctor commands.

## File Structure

Create:

- `src/runtime/config.ts`: `.nams/.env` and process env config loading for `NAMS_API_KEY` and optional `NAMS_BASE_URL`.
- `src/runtime/hashing.ts`: stable SHA-256 helpers for session keys and duplicate suppression.
- `src/runtime/session-state.ts`: JSON state read/write under `.nams/state/sessions/<platform>/`.
- `src/runtime/memory-service.ts`: hook-safe wrapper around `NamsClient`.
- `src/platforms/gemini/payload.ts`: Gemini hook payload extraction.
- `src/platforms/gemini/transcript.ts`: Gemini transcript reader and transcript-derived candidates.
- `test/architecture.test.js`: ArchUnitTS dependency direction tests.
- `test/runtime-config.test.js`: config precedence and missing-key tests.
- `test/session-state.test.js`: state key and persistence tests.
- `test/gemini/gemini-payload.test.js`: Gemini hook payload parser tests.
- `test/gemini/gemini-transcript.test.js`: transcript reader tests, including `thoughts` and `toolCalls[]`.
- `test/gemini/gemini-memory-flow.test.js`: fixture-driven mocked NAMS flow tests.

Modify:

- `package.json`: add dev dependency `archunit`.
- `package-lock.json`: update via `npm install archunit --save-dev`.
- `src/interfaces.ts`: add typed hook events and adapter methods.
- `src/cli.ts`: route new typed events.
- `src/platforms/gemini/index.ts`: orchestrate Gemini memory flow.
- `templates/gemini/hooks/hooks.json`: add Gemini `BeforeAgent`, `AfterAgent`, and `AfterTool` hooks.
- `test/cli-session-start.test.js`: preserve existing gateway tests and add routing validation where needed.

## Public APIs Introduced

These names are used across tasks:

```ts
export type NamsRuntimeConfig = {
  apiKey: string;
  baseUrl?: string;
};

export type SessionState = {
  harness: "gemini" | "claude" | "codex";
  harnessSessionId?: string;
  sessionKey: string;
  projectDirectory: string;
  conversationId?: string;
  createdAt: string;
  lastRecallAt?: string;
  lastUserMessageHash?: string;
  lastAssistantMessageHash?: string;
  seenTranscriptEntryIds: string[];
  seenReasoningStepHashes: string[];
  seenToolCallIds: string[];
};

export type GeminiPayloadInfo = {
  sessionId?: string;
  projectDirectory: string;
  transcriptPath?: string;
  prompt?: string;
  promptResponse?: string;
};

export type GeminiTranscriptEntry =
  | { kind: "header"; sessionId?: string }
  | { kind: "user"; id?: string; content: string; timestamp?: string }
  | { kind: "assistant"; id?: string; content: string; timestamp?: string }
  | { kind: "thought"; id?: string; subject: string; description: string; timestamp?: string }
  | { kind: "toolCall"; id?: string; name: string; args: unknown; status?: string; timestamp?: string };
```

---

### Task 1: Add Architecture Guard Tests

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/architecture.test.js`

- [x] **Step 1: Install ArchUnitTS as a dev dependency**

Run:

```bash
npm install archunit --save-dev
```

Expected:

- `package.json` contains `"archunit"` under `devDependencies`.
- `package-lock.json` is updated.
- No runtime dependency is added.

- [x] **Step 2: Write architecture tests**

Create `test/architecture.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectFiles } from "archunit";

async function assertNoViolations(rule) {
  const violations = await rule.check();
  assert.deepEqual(violations, []);
}

test("platform adapters do not import each other", async () => {
  for (const platform of ["gemini", "claude", "codex"]) {
    const otherPlatforms = ["gemini", "claude", "codex"].filter((candidate) => candidate !== platform);
    for (const otherPlatform of otherPlatforms) {
      await assertNoViolations(
        projectFiles()
          .inFolder(`src/platforms/${platform}.ts`)
          .shouldNot()
          .dependOnFiles()
          .inFolder(`src/platforms/${otherPlatform}.ts`),
      );
    }
  }
});

test("runtime modules do not import gateway or platform modules", async () => {
  await assertNoViolations(
    projectFiles().inFolder("src/runtime/**").shouldNot().dependOnFiles().inFolder("src/platforms/**"),
  );
  await assertNoViolations(
    projectFiles().inFolder("src/runtime/**").shouldNot().dependOnFiles().inFolder("src/cli.ts"),
  );
});

test("generated client does not import project runtime modules", async () => {
  for (const forbiddenFolder of ["src/runtime/**", "src/platforms/**", "src/cli.ts", "docs/**", "scripts/**"]) {
    await assertNoViolations(
      projectFiles().inFolder("src/generated/**").shouldNot().dependOnFiles().inFolder(forbiddenFolder),
    );
  }
});

test("only the platform registry imports all concrete adapters", async () => {
  await assertNoViolations(
    projectFiles().inFolder("src/cli.ts").shouldNot().dependOnFiles().inFolder("src/platforms/gemini/index.ts"),
  );
  await assertNoViolations(
    projectFiles().inFolder("src/cli.ts").shouldNot().dependOnFiles().inFolder("src/platforms/claude/index.ts"),
  );
  await assertNoViolations(
    projectFiles().inFolder("src/cli.ts").shouldNot().dependOnFiles().inFolder("src/platforms/codex/index.ts"),
  );
});
```

- [x] **Step 3: Run architecture tests**

Run:

```bash
node --test test/architecture.test.js
```

Expected:

- Passes on current architecture.
- If ArchUnitTS does not support `check()` in this test runner version, adjust only `assertNoViolations()` to the documented framework-neutral API and keep all rule bodies unchanged.

- [x] **Step 4: Run full check**

Run:

```bash
npm run check
```

Expected:

- TypeScript build passes.
- Existing tests plus `test/architecture.test.js` pass.

- [x] **Step 5: Commit**

```bash
git add package.json package-lock.json test/architecture.test.js
git commit -m "test: add architecture guards" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Route Gemini Memory Hook Events

**Files:**

- Modify: `src/interfaces.ts`
- Modify: `src/cli.ts`
- Modify: `src/platforms/gemini/index.ts`
- Modify: `src/platforms/claude/index.ts`
- Modify: `src/platforms/codex/index.ts`
- Modify: `templates/gemini/hooks/hooks.json`
- Modify: `test/cli-session-start.test.js`

- [x] **Step 1: Add failing routing tests**

Append to `test/cli-session-start.test.js`:

```js
function runCliWithEvent(harness, event, payload, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "run", harness, "--event", event], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

for (const event of ["BeforeAgent", "AfterAgent", "AfterTool"]) {
  test(`routes gemini ${event} hook event`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const result = await runCliWithEvent("gemini", event, {
        session_id: `gemini-${event}`,
        cwd: projectDir,
      }, projectDir);

      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).continue, true);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
}
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/cli-session-start.test.js
```

Expected:

- Fails because `BeforeAgent`, `AfterAgent`, and `AfterTool` are not accepted typed hook events.

- [x] **Step 3: Extend hook interfaces**

Change `src/interfaces.ts` so the event and adapter contracts are:

```ts
export const hookEvents = ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool"] as const;
export type HookEvent = (typeof hookEvents)[number];

export interface PlatformAdapter {
  startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult>;
  beforeAgent?(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult>;
  afterAgent?(invocation: HookInvocation<"AfterAgent">): Promise<HookResult>;
  afterTool?(invocation: HookInvocation<"AfterTool">): Promise<HookResult>;
}
```

- [x] **Step 4: Route new events through the CLI**

Change `src/cli.ts` routing to:

```ts
async function routeEvent(adapter: ReturnType<typeof getPlatformAdapter>, invocation: HookInvocation) {
  switch (invocation.event) {
    case "SessionStart":
      return adapter.startConversation(invocation as HookInvocation<"SessionStart">);
    case "BeforeAgent":
      if (adapter.beforeAgent === undefined) {
        return { stdout: { continue: true, suppressOutput: true } };
      }
      return adapter.beforeAgent(invocation as HookInvocation<"BeforeAgent">);
    case "AfterAgent":
      if (adapter.afterAgent === undefined) {
        return { stdout: { continue: true, suppressOutput: true } };
      }
      return adapter.afterAgent(invocation as HookInvocation<"AfterAgent">);
    case "AfterTool":
      if (adapter.afterTool === undefined) {
        return { stdout: { continue: true, suppressOutput: true } };
      }
      return adapter.afterTool(invocation as HookInvocation<"AfterTool">);
  }
}
```

Update the usage string to:

```ts
process.stderr.write("Usage: nams-hooks run <gemini|claude|codex> --event <SessionStart|BeforeAgent|AfterAgent|AfterTool>\n");
```

- [x] **Step 5: Add Gemini adapter methods with allow-only behavior**

In `src/platforms/gemini/index.ts`, add methods:

```ts
  async beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: resolveGeminiProjectDirectory(invocation),
    });
    return { stdout: { continue: true, suppressOutput: true } };
  }

  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: resolveGeminiProjectDirectory(invocation),
    });
    return { stdout: { continue: true, suppressOutput: true } };
  }

  async afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: resolveGeminiProjectDirectory(invocation),
    });
    return { stdout: { continue: true, suppressOutput: true } };
  }
```

Keep Claude and Codex unchanged except for TypeScript compatibility with optional adapter methods.

- [x] **Step 6: Update Gemini hook template**

Change `templates/gemini/hooks/hooks.json` so `hooks` includes:

```json
{
  "SessionStart": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "name": "nams-session-start",
          "description": "Initialize NAMS Gemini session state.",
          "command": "node \"${extensionPath}/bin/cli.js\" run gemini --event SessionStart"
        }
      ]
    }
  ],
  "BeforeAgent": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "name": "nams-before-agent",
          "description": "Recall NAMS memory and persist the Gemini user prompt.",
          "command": "node \"${extensionPath}/bin/cli.js\" run gemini --event BeforeAgent"
        }
      ]
    }
  ],
  "AfterAgent": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "name": "nams-after-agent",
          "description": "Persist the Gemini assistant response to NAMS.",
          "command": "node \"${extensionPath}/bin/cli.js\" run gemini --event AfterAgent"
        }
      ]
    }
  ],
  "AfterTool": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "name": "nams-after-tool",
          "description": "Persist Gemini tool-call metadata to NAMS.",
          "command": "node \"${extensionPath}/bin/cli.js\" run gemini --event AfterTool"
        }
      ]
    }
  ]
}
```

Preserve the top-level `{ "hooks": ... }` wrapper.

- [x] **Step 7: Verify green**

Run:

```bash
npm run check
```

Expected:

- Build passes.
- All tests pass.

- [x] **Step 8: Commit**

```bash
git add src/interfaces.ts src/cli.ts src/platforms/gemini/index.ts src/platforms/claude/index.ts src/platforms/codex/index.ts templates/gemini/hooks/hooks.json test/cli-session-start.test.js
git commit -m "feat: route gemini memory hook events" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Add Runtime Config Loading

**Files:**

- Create: `src/runtime/config.ts`
- Create: `test/runtime-config.test.js`

- [x] **Step 1: Write failing config tests**

Create `test/runtime-config.test.js`:

```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "config.js")).href;

test(".nams/.env values take priority over process environment", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-config-"));
  try {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".nams", ".env"),
      "NAMS_API_KEY=file-key\nNAMS_BASE_URL=https://file.example.test\n",
      "utf8",
    );

    const { loadNamsConfig } = await import(configUrl);
    const config = await loadNamsConfig(projectDir, {
      NAMS_API_KEY: "env-key",
      NAMS_BASE_URL: "https://env.example.test",
    });

    assert.deepEqual(config, {
      apiKey: "file-key",
      baseUrl: "https://file.example.test",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("process environment fills missing config values", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-config-"));
  try {
    const { loadNamsConfig } = await import(configUrl);
    const config = await loadNamsConfig(projectDir, {
      NAMS_API_KEY: "env-key",
      NAMS_BASE_URL: "https://env.example.test",
    });

    assert.deepEqual(config, {
      apiKey: "env-key",
      baseUrl: "https://env.example.test",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("missing NAMS_API_KEY returns null config", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-config-"));
  try {
    const { loadNamsConfig } = await import(configUrl);
    const config = await loadNamsConfig(projectDir, {});

    assert.equal(config, null);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/runtime-config.test.js
```

Expected:

- Fails because `.build/tsc/runtime/config.js` does not exist.

- [x] **Step 3: Implement config loader**

Create `src/runtime/config.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface NamsRuntimeConfig {
  apiKey: string;
  baseUrl?: string;
}

export async function loadNamsConfig(
  projectDirectory: string,
  env: Record<string, string | undefined> = process.env,
): Promise<NamsRuntimeConfig | null> {
  const fileEnv = await readLocalEnv(projectDirectory);
  const apiKey = fileEnv.NAMS_API_KEY ?? env.NAMS_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    return null;
  }

  const baseUrl = fileEnv.NAMS_BASE_URL ?? env.NAMS_BASE_URL;
  return {
    apiKey,
    ...(baseUrl !== undefined && baseUrl.trim() !== "" ? { baseUrl } : {}),
  };
}

async function readLocalEnv(projectDirectory: string): Promise<Record<string, string>> {
  const envPath = path.join(projectDirectory, ".nams", ".env");
  let content: string;
  try {
    content = await readFile(envPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  return parseEnv(content);
}

function parseEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    values[key] = stripQuotes(value);
  }
  return values;
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
```

- [x] **Step 4: Verify green**

Run:

```bash
npm run build && node --test test/runtime-config.test.js
```

Expected:

- All config tests pass.

- [x] **Step 5: Commit**

```bash
git add src/runtime/config.ts test/runtime-config.test.js
git commit -m "feat: load nams runtime config" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Add Session State And Hashing

**Files:**

- Create: `src/runtime/hashing.ts`
- Create: `src/runtime/session-state.ts`
- Create: `test/session-state.test.js`

- [x] **Step 1: Write failing state tests**

Create `test/session-state.test.js`:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "session-state.js")).href;

test("uses session id as Gemini session key when present", async () => {
  const { resolveSessionKey } = await import(stateUrl);
  const key = resolveSessionKey({ platform: "gemini", sessionId: "session-1", projectDirectory: "/tmp/project" });

  assert.equal(key, "session-1");
});

test("falls back to cwd-derived Gemini session key when session id is missing", async () => {
  const { resolveSessionKey } = await import(stateUrl);
  const key = resolveSessionKey({ platform: "gemini", projectDirectory: "/tmp/project" });

  assert.match(key, /^cwd-[a-f0-9]{64}$/);
});

test("persists session state under .nams/state/sessions", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-state-"));
  try {
    const { loadSessionState, saveSessionState } = await import(stateUrl);
    const state = {
      harness: "gemini",
      harnessSessionId: "session-1",
      sessionKey: "session-1",
      projectDirectory: projectDir,
      conversationId: "conversation-1",
      createdAt: "2026-05-11T12:00:00.000Z",
      seenTranscriptEntryIds: [],
      seenReasoningStepHashes: [],
      seenToolCallIds: [],
    };

    await saveSessionState(projectDir, "gemini", "session-1", state);
    assert.deepEqual(await loadSessionState(projectDir, "gemini", "session-1"), state);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/session-state.test.js
```

Expected:

- Fails because session-state module does not exist.

- [x] **Step 3: Implement hashing helper**

Create `src/runtime/hashing.ts`:

```ts
import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJsonHash(value: unknown): string {
  return sha256(JSON.stringify(sortJson(value)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortJson(nestedValue)]),
    );
  }
  return value;
}
```

- [x] **Step 4: Implement session state store**

Create `src/runtime/session-state.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../interfaces.js";
import { sha256 } from "./hashing.js";

export interface SessionState {
  harness: Platform;
  harnessSessionId?: string;
  sessionKey: string;
  projectDirectory: string;
  conversationId?: string;
  createdAt: string;
  lastRecallAt?: string;
  lastUserMessageHash?: string;
  lastAssistantMessageHash?: string;
  seenTranscriptEntryIds: string[];
  seenReasoningStepHashes: string[];
  seenToolCallIds: string[];
}

export interface ResolveSessionKeyInput {
  platform: Platform;
  sessionId?: string;
  projectDirectory: string;
}

export function resolveSessionKey(input: ResolveSessionKeyInput): string {
  if (input.sessionId !== undefined && input.sessionId.trim() !== "") {
    return input.sessionId;
  }
  return `cwd-${sha256(input.projectDirectory)}`;
}

export async function loadSessionState(
  projectDirectory: string,
  platform: Platform,
  sessionKey: string,
): Promise<SessionState | null> {
  try {
    return JSON.parse(await readFile(sessionStatePath(projectDirectory, platform, sessionKey), "utf8")) as SessionState;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveSessionState(
  projectDirectory: string,
  platform: Platform,
  sessionKey: string,
  state: SessionState,
): Promise<void> {
  const statePath = sessionStatePath(projectDirectory, platform, sessionKey);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function createInitialSessionState(input: ResolveSessionKeyInput, now = new Date()): SessionState {
  const sessionKey = resolveSessionKey(input);
  return {
    harness: input.platform,
    ...(input.sessionId !== undefined && input.sessionId.trim() !== "" ? { harnessSessionId: input.sessionId } : {}),
    sessionKey,
    projectDirectory: input.projectDirectory,
    createdAt: now.toISOString(),
    seenTranscriptEntryIds: [],
    seenReasoningStepHashes: [],
    seenToolCallIds: [],
  };
}

function sessionStatePath(projectDirectory: string, platform: Platform, sessionKey: string): string {
  return path.join(projectDirectory, ".nams", "state", "sessions", platform, `${safeFileName(sessionKey)}.json`);
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
```

- [x] **Step 5: Verify green**

Run:

```bash
npm run build && node --test test/session-state.test.js
```

Expected:

- All state tests pass.

- [x] **Step 6: Commit**

```bash
git add src/runtime/hashing.ts src/runtime/session-state.ts test/session-state.test.js
git commit -m "feat: persist hook session state" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Parse Gemini Payloads And Transcripts

**Files:**

- Create: `src/platforms/gemini/payload.ts`
- Create: `src/platforms/gemini/transcript.ts`
- Create: `test/gemini/gemini-payload.test.js`
- Create: `test/gemini/gemini-transcript.test.js`

- [x] **Step 1: Write failing Gemini payload parser tests**

Create `test/gemini/gemini-payload.test.js`:

```js
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const payloadUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "gemini", "payload.js")).href;

test("extracts Gemini prompt and response fields from hook payload", async () => {
  const { parseGeminiPayload } = await import(payloadUrl);
  const info = parseGeminiPayload(
    {
      session_id: "session-1",
      cwd: "/project",
      transcript_path: "/tmp/transcript.jsonl",
      prompt: "Say hello",
      prompt_response: "Hello!",
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    sessionId: "session-1",
    projectDirectory: "/project",
    transcriptPath: "/tmp/transcript.jsonl",
    prompt: "Say hello",
    promptResponse: "Hello!",
  });
});

test("falls back to process cwd when Gemini cwd is absent", async () => {
  const { parseGeminiPayload } = await import(payloadUrl);
  const info = parseGeminiPayload({ session_id: "session-1" }, "/fallback");

  assert.equal(info.projectDirectory, "/fallback");
});
```

- [x] **Step 2: Write failing transcript parser tests**

Create `test/gemini/gemini-transcript.test.js`:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transcriptUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "gemini", "transcript.js")).href;

test("reads Gemini transcript messages, thoughts, and tool metadata", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nams-transcript-"));
  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1", kind: "main" }),
        JSON.stringify({ id: "user-1", type: "user", content: [{ text: "Research autonomo" }] }),
        JSON.stringify({ $set: { lastUpdated: "2026-05-11T12:11:51.396Z" } }),
        JSON.stringify({
          id: "gemini-1",
          type: "gemini",
          content: "Final answer",
          thoughts: [{ subject: "Researching", description: "Searching official guidance", timestamp: "2026-05-11T12:11:55.500Z" }],
          tokens: { total: 10 },
          toolCalls: [{
            id: "google_web_search_1",
            name: "google_web_search",
            args: { query: "autonomo spain" },
            result: [{ functionResponse: { response: { output: "Do not store this" } } }],
            resultDisplay: "Do not store this either",
            status: "success",
            timestamp: "2026-05-11T12:12:10.860Z",
          }],
        }),
      ].join("\n"),
      "utf8",
    );

    const { readGeminiTranscript } = await import(transcriptUrl);
    const entries = await readGeminiTranscript(transcriptPath);

    assert.deepEqual(entries, [
      { kind: "header", sessionId: "session-1" },
      { kind: "user", id: "user-1", content: "Research autonomo" },
      { kind: "assistant", id: "gemini-1", content: "Final answer" },
      { kind: "thought", id: "gemini-1:thought:0", subject: "Researching", description: "Searching official guidance", timestamp: "2026-05-11T12:11:55.500Z" },
      { kind: "toolCall", id: "google_web_search_1", name: "google_web_search", args: { query: "autonomo spain" }, status: "success", timestamp: "2026-05-11T12:12:10.860Z" },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 3: Verify red**

Run:

```bash
npm run build && node --test test/gemini/gemini-payload.test.js test/gemini/gemini-transcript.test.js
```

Expected:

- Fails because the parser modules do not exist.

- [x] **Step 4: Implement payload parser**

Create `src/platforms/gemini/payload.ts`:

```ts
export interface GeminiPayloadInfo {
  sessionId?: string;
  projectDirectory: string;
  transcriptPath?: string;
  prompt?: string;
  promptResponse?: string;
}

export function parseGeminiPayload(payload: Record<string, unknown>, processCwd: string): GeminiPayloadInfo {
  const projectDirectory = firstString(payload.cwd, payload.GEMINI_PROJECT_DIR) ?? processCwd;
  return {
    ...(firstString(payload.session_id, payload.sessionId) !== undefined
      ? { sessionId: firstString(payload.session_id, payload.sessionId) }
      : {}),
    projectDirectory,
    ...(firstString(payload.transcript_path, payload.transcriptPath) !== undefined
      ? { transcriptPath: firstString(payload.transcript_path, payload.transcriptPath) }
      : {}),
    ...(firstString(payload.prompt, payload.user_prompt, payload.userPrompt) !== undefined
      ? { prompt: firstString(payload.prompt, payload.user_prompt, payload.userPrompt) }
      : {}),
    ...(firstString(payload.prompt_response, payload.promptResponse) !== undefined
      ? { promptResponse: firstString(payload.prompt_response, payload.promptResponse) }
      : {}),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}
```

- [x] **Step 5: Implement transcript reader**

Create `src/platforms/gemini/transcript.ts`:

```ts
import { readFile } from "node:fs/promises";

export type GeminiTranscriptEntry =
  | { kind: "header"; sessionId?: string }
  | { kind: "user"; id?: string; content: string; timestamp?: string }
  | { kind: "assistant"; id?: string; content: string; timestamp?: string }
  | { kind: "thought"; id?: string; subject: string; description: string; timestamp?: string }
  | { kind: "toolCall"; id?: string; name: string; args: unknown; status?: string; timestamp?: string };

export async function readGeminiTranscript(transcriptPath: string): Promise<GeminiTranscriptEntry[]> {
  const content = await readFile(transcriptPath, "utf8");
  const entries: GeminiTranscriptEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    const raw = JSON.parse(line) as Record<string, unknown>;
    entries.push(...toEntries(raw));
  }
  return entries;
}

function toEntries(raw: Record<string, unknown>): GeminiTranscriptEntry[] {
  if ("$set" in raw) {
    return [];
  }
  if (typeof raw.sessionId === "string" && raw.type === undefined) {
    return [{ kind: "header", sessionId: raw.sessionId }];
  }
  if (raw.type === "user") {
    const content = extractUserText(raw.content);
    return content === "" ? [] : [{ kind: "user", ...idAndTimestamp(raw), content }];
  }
  if (raw.type === "gemini") {
    return [
      ...assistantEntry(raw),
      ...thoughtEntries(raw),
      ...toolCallEntries(raw),
    ];
  }
  return [];
}

function assistantEntry(raw: Record<string, unknown>): GeminiTranscriptEntry[] {
  if (typeof raw.content !== "string" || raw.content.trim() === "") {
    return [];
  }
  return [{ kind: "assistant", ...idAndTimestamp(raw), content: raw.content }];
}

function thoughtEntries(raw: Record<string, unknown>): GeminiTranscriptEntry[] {
  if (!Array.isArray(raw.thoughts)) {
    return [];
  }
  return raw.thoughts.flatMap((thought, index) => {
    if (typeof thought !== "object" || thought === null) {
      return [];
    }
    const candidate = thought as Record<string, unknown>;
    if (typeof candidate.subject !== "string" || typeof candidate.description !== "string") {
      return [];
    }
    return [{
      kind: "thought" as const,
      id: `${String(raw.id ?? "entry")}:thought:${index}`,
      subject: candidate.subject,
      description: candidate.description,
      ...(typeof candidate.timestamp === "string" ? { timestamp: candidate.timestamp } : {}),
    }];
  });
}

function toolCallEntries(raw: Record<string, unknown>): GeminiTranscriptEntry[] {
  if (!Array.isArray(raw.toolCalls)) {
    return [];
  }
  return raw.toolCalls.flatMap((toolCall) => {
    if (typeof toolCall !== "object" || toolCall === null) {
      return [];
    }
    const candidate = toolCall as Record<string, unknown>;
    if (typeof candidate.name !== "string") {
      return [];
    }
    return [{
      kind: "toolCall" as const,
      ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
      name: candidate.name,
      args: candidate.args,
      ...(typeof candidate.status === "string" ? { status: candidate.status } : {}),
      ...(typeof candidate.timestamp === "string" ? { timestamp: candidate.timestamp } : {}),
    }];
  });
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

function idAndTimestamp(raw: Record<string, unknown>): { id?: string; timestamp?: string } {
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw.timestamp === "string" ? { timestamp: raw.timestamp } : {}),
  };
}
```

- [x] **Step 6: Verify green**

Run:

```bash
npm run build && node --test test/gemini/gemini-payload.test.js test/gemini/gemini-transcript.test.js
```

Expected:

- Payload and transcript parser tests pass.

- [x] **Step 7: Commit**

```bash
git add src/platforms/gemini/payload.ts src/platforms/gemini/transcript.ts test/gemini/gemini-payload.test.js test/gemini/gemini-transcript.test.js
git commit -m "feat: parse gemini hook payloads and transcripts" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 6: Add NAMS Memory Service

**Files:**

- Create: `src/runtime/memory-service.ts`
- Create: `test/memory-service.test.js`

- [x] **Step 1: Write failing memory service tests**

Create `test/memory-service.test.js`:

```js
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "memory-service.js")).href;

test("creates conversation with minimal Gemini metadata", async () => {
  const requests = [];
  const { NamsMemoryService } = await import(serviceUrl);
  const service = new NamsMemoryService({
    apiKey: "key",
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
  assert.equal(JSON.parse(requests[0].init.body).metadata.harness, "gemini");
  assert.equal(JSON.parse(requests[0].init.body).metadata.projectDirectory, "/project");
});

test("formats recalled context for Gemini additionalContext", async () => {
  const { formatMemoryContext } = await import(serviceUrl);
  const context = formatMemoryContext({
    reflections: [{ content: "User prefers fixture-driven tests." }],
    observations: [{ content: "Project uses Node test runner." }],
    recentMessages: [{ role: "user", content: "Remember Gemini memory flow." }],
  });

  assert.match(context, /Relevant memory context/);
  assert.match(context, /User prefers fixture-driven tests/);
  assert.match(context, /Use this context silently/);
});

test("sanitizes tool input and omits tool output", async () => {
  const requests = [];
  const { NamsMemoryService } = await import(serviceUrl);
  const service = new NamsMemoryService({
    apiKey: "key",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ id: "tool-call-1" }), { status: 201 });
    },
  });

  await service.recordToolCall({
    toolName: "google_web_search",
    input: { query: "autonomo spain", secret: "visible-test-value" },
    status: "success",
  });

  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.toolName, "google_web_search");
  assert.equal(body.output, "");
  assert.doesNotMatch(body.input, /functionResponse|resultDisplay/);
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/memory-service.test.js
```

Expected:

- Fails because memory-service module does not exist.

- [x] **Step 3: Implement memory service**

Create `src/runtime/memory-service.ts`:

```ts
import { NamsClient, type ContextResponse } from "../generated/nams-client.js";
import type { NamsRuntimeConfig } from "./config.js";

export interface NamsMemoryServiceOptions extends NamsRuntimeConfig {
  fetch?: typeof fetch;
}

export interface CreateConversationInput {
  harness: string;
  projectDirectory: string;
}

export interface ToolCallInput {
  stepId?: string;
  toolName: string;
  input: unknown;
  status?: string;
  durationMs?: number;
}

export class NamsMemoryService {
  private readonly client: NamsClient;

  constructor(options: NamsMemoryServiceOptions) {
    this.client = new NamsClient({
      apiKey: options.apiKey,
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });
  }

  async createConversation(input: CreateConversationInput): Promise<string> {
    const response = await this.client.createConversation({
      metadata: {
        harness: input.harness,
        projectDirectory: input.projectDirectory,
      },
    });
    if (response.id === undefined || response.id.trim() === "") {
      throw new Error("NAMS conversation response did not include id");
    }
    return response.id;
  }

  async recall(conversationId: string): Promise<string> {
    return formatMemoryContext(await this.client.getConversationContext(conversationId));
  }

  async searchEntities(query: string): Promise<string> {
    const response = await this.client.searchEntities({ query, limit: 5 });
    const lines = (response.entities ?? [])
      .flatMap((entity) => [entity.name, entity.description].filter((value): value is string => typeof value === "string" && value.trim() !== ""))
      .slice(0, 8);
    return lines.length === 0 ? "" : formatMemoryContext({ observations: lines.map((content) => ({ content })) });
  }

  async storeUserMessage(conversationId: string, content: string): Promise<void> {
    await this.client.addMessage(conversationId, { role: "user", content });
  }

  async storeAssistantMessage(conversationId: string, content: string): Promise<void> {
    await this.client.addMessage(conversationId, { role: "assistant", content });
  }

  async recordReasoningStep(input: { conversationId: string; reasoning: string; actionTaken: string; result?: string }): Promise<string | undefined> {
    const response = await this.client.recordReasoningStep(input);
    return response.id;
  }

  async recordToolCall(input: ToolCallInput): Promise<void> {
    await this.client.recordToolCall({
      toolName: input.toolName,
      input: serializeToolInput(input.input),
      output: "",
      ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    });
  }
}

export function formatMemoryContext(context: ContextResponse): string {
  const lines = [
    ...sectionLines("Reflections", context.reflections?.map((entry) => entry.content)),
    ...sectionLines("Observations", context.observations?.map((entry) => entry.content)),
    ...sectionLines("Recent messages", context.recentMessages?.map((entry) => [entry.role, entry.content].filter(Boolean).join(": "))),
  ];
  if (lines.length === 0) {
    return "";
  }
  return [
    "Relevant memory context:",
    ...lines.slice(0, 24),
    "",
    "Use this context silently when it is relevant. Do not narrate memory mechanics.",
  ].join("\n");
}

function sectionLines(label: string, values: Array<string | undefined> | undefined): string[] {
  const presentValues = (values ?? []).filter((value): value is string => typeof value === "string" && value.trim() !== "");
  if (presentValues.length === 0) {
    return [];
  }
  return [`${label}:`, ...presentValues.map((value) => `- ${value}`)];
}

function serializeToolInput(input: unknown): string {
  const serialized = JSON.stringify(input ?? {});
  return serialized.length > 4000 ? `${serialized.slice(0, 4000)}...[truncated]` : serialized;
}
```

- [x] **Step 4: Verify green**

Run:

```bash
npm run build && node --test test/memory-service.test.js
```

Expected:

- Memory service tests pass.

- [x] **Step 5: Commit**

```bash
git add src/runtime/memory-service.ts test/memory-service.test.js
git commit -m "feat: add nams memory service" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 7: Implement Gemini SessionStart State Initialization

**Files:**

- Modify: `src/platforms/gemini/index.ts`
- Create: `test/gemini/gemini-memory-flow.test.js`

- [x] **Step 1: Write failing SessionStart test**

Create `test/gemini/gemini-memory-flow.test.js` with this first test and helper:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const geminiUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "gemini", "index.js")).href;

test("Gemini SessionStart creates local state without NAMS conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-flow-"));
  try {
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter();

    const result = await adapter.startConversation({
      platform: "gemini",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const statePath = path.join(projectDir, ".nams", "state", "sessions", "gemini", "session-1.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.conversationId, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/gemini/gemini-memory-flow.test.js
```

Expected:

- Fails because `SessionStart` only writes logs and does not create session state.

- [x] **Step 3: Implement SessionStart state initialization**

Modify `src/platforms/gemini/index.ts`:

```ts
import { createInitialSessionState, loadSessionState, saveSessionState } from "../runtime/session-state.js";
import { parseGeminiPayload } from "./payload.js";
```

Inside `startConversation`, after logging:

```ts
const info = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
const initialState = createInitialSessionState({
  platform: invocation.platform,
  sessionId: info.sessionId,
  projectDirectory: info.projectDirectory,
});
const existingState = await loadSessionState(info.projectDirectory, invocation.platform, initialState.sessionKey);
await saveSessionState(info.projectDirectory, invocation.platform, initialState.sessionKey, existingState ?? initialState);
```

Keep return value unchanged:

```ts
return { stdout: { continue: true, suppressOutput: true } };
```

- [x] **Step 4: Verify green**

Run:

```bash
npm run build && node --test test/gemini/gemini-memory-flow.test.js
```

Expected:

- SessionStart flow test passes.

- [x] **Step 5: Commit**

```bash
git add src/platforms/gemini/index.ts test/gemini/gemini-memory-flow.test.js
git commit -m "feat: initialize gemini session state" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 8: Implement Gemini BeforeAgent Core Memory Flow

**Files:**

- Modify: `src/platforms/gemini/index.ts`
- Modify: `test/gemini/gemini-memory-flow.test.js`

- [x] **Step 1: Add failing BeforeAgent integration test**

Append to `test/gemini/gemini-memory-flow.test.js`:

```js
test("Gemini BeforeAgent creates conversation, recalls memory, stores prompt, and injects context", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-flow-"));
  try {
    const requests = [];
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" },
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (String(url).endsWith("/v1/conversations")) {
          return new Response(JSON.stringify({ id: "conversation-1" }), { status: 201 });
        }
        if (String(url).endsWith("/v1/conversations/conversation-1/context")) {
          return new Response(JSON.stringify({ observations: [{ content: "Use fixture-driven tests." }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: "message-1" }), { status: 201 });
      },
    });

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Build Gemini memory flow",
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Use fixture-driven tests/);
    const requestBodies = requests.map((request) => request.init.body && JSON.parse(request.init.body));
    assert.equal(requestBodies[0].metadata.harness, "gemini");
    assert.deepEqual(requestBodies[1], { role: "user", content: "Build Gemini memory flow" });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/gemini/gemini-memory-flow.test.js
```

Expected:

- Fails because `GeminiAdapter` does not accept injected `env` and `fetch`, and `beforeAgent` does not call NAMS.

- [x] **Step 3: Add GeminiAdapter dependency injection**

In `src/platforms/gemini/index.ts`, add:

```ts
import type { NamsRuntimeConfig } from "../runtime/config.js";

export interface GeminiAdapterOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export class GeminiAdapter implements PlatformAdapter {
  constructor(private readonly options: GeminiAdapterOptions = {}) {}
```

Use `this.options.env` when loading config and `this.options.fetch` when creating the memory service.

- [x] **Step 4: Implement BeforeAgent flow**

In `src/platforms/gemini/index.ts`, implement `beforeAgent` with this control flow:

```ts
const info = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
const state = await resolveGeminiState(invocation.platform, info);
if (info.prompt === undefined) {
  await saveSessionState(info.projectDirectory, invocation.platform, state.sessionKey, state);
  return { stdout: { continue: true, suppressOutput: true } };
}

const config = await loadNamsConfig(info.projectDirectory, this.options.env);
if (config === null) {
  await appendPlatformLog({ platform: invocation.platform, event: invocation.event, payload: { message: "NAMS_API_KEY missing" }, projectDirectory: info.projectDirectory });
  await saveSessionState(info.projectDirectory, invocation.platform, state.sessionKey, state);
  return { stdout: { continue: true, suppressOutput: true } };
}

const memory = new NamsMemoryService({ ...config, ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}) });
let conversationId = state.conversationId;
if (conversationId === undefined) {
  conversationId = await memory.createConversation({ harness: invocation.platform, projectDirectory: info.projectDirectory });
  state.conversationId = conversationId;
}

let additionalContext = "";
if (state.lastRecallAt === undefined) {
  additionalContext = await memory.recall(conversationId);
  state.lastRecallAt = new Date().toISOString();
}

const userHash = messageHash(invocation.platform, state.sessionKey, "user", info.prompt);
if (state.lastUserMessageHash !== userHash) {
  await memory.storeUserMessage(conversationId, info.prompt);
  state.lastUserMessageHash = userHash;
}

await saveSessionState(info.projectDirectory, invocation.platform, state.sessionKey, state);
return additionalContext === ""
  ? { stdout: { continue: true, suppressOutput: true } }
  : {
      stdout: {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext },
      },
    };
```

Define local helpers in `src/platforms/gemini/index.ts`:

```ts
function messageHash(platform: string, sessionKey: string, role: string, content: string): string {
  return sha256([platform, sessionKey, role, content.trim()].join("\n"));
}
```

`resolveGeminiState` should load existing state or create a new one using `createInitialSessionState`.

- [x] **Step 5: Verify green**

Run:

```bash
npm run build && node --test test/gemini/gemini-memory-flow.test.js
```

Expected:

- SessionStart and BeforeAgent tests pass.

- [x] **Step 6: Add duplicate user prompt assertion**

Append a test that calls `beforeAgent` twice with the same prompt and asserts only one `addMessage` request with role `user` is made:

```js
test("Gemini BeforeAgent suppresses duplicate user prompt writes", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-flow-"));
  try {
    const messageBodies = [];
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" },
      fetch: async (url, init) => {
        if (String(url).endsWith("/v1/conversations")) {
          return new Response(JSON.stringify({ id: "conversation-1" }), { status: 201 });
        }
        if (String(url).endsWith("/context")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        messageBodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: `message-${messageBodies.length}` }), { status: 201 });
      },
    });
    const invocation = {
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: { session_id: "session-1", cwd: projectDir, prompt: "same prompt" },
    };

    await adapter.beforeAgent(invocation);
    await adapter.beforeAgent(invocation);

    assert.deepEqual(messageBodies, [{ role: "user", content: "same prompt" }]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 7: Verify duplicate suppression**

Run:

```bash
npm run build && node --test test/gemini/gemini-memory-flow.test.js
```

Expected:

- All Gemini memory-flow tests pass.

- [x] **Step 8: Commit**

```bash
git add src/platforms/gemini/index.ts test/gemini/gemini-memory-flow.test.js
git commit -m "feat: persist gemini user prompts" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 9: Implement Gemini AfterAgent Assistant Persistence

**Files:**

- Modify: `src/platforms/gemini/index.ts`
- Modify: `test/gemini/gemini-memory-flow.test.js`

- [x] **Step 1: Add failing prompt_response test**

Append to `test/gemini/gemini-memory-flow.test.js`:

```js
test("Gemini AfterAgent stores prompt_response as assistant message", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-flow-"));
  try {
    const messageBodies = [];
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" },
      fetch: async (url, init) => {
        if (String(url).endsWith("/v1/conversations")) {
          return new Response(JSON.stringify({ id: "conversation-1" }), { status: 201 });
        }
        if (String(url).endsWith("/context")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        messageBodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: `message-${messageBodies.length}` }), { status: 201 });
      },
    });

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: { session_id: "session-1", cwd: projectDir, prompt: "Say hello" },
    });
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: { session_id: "session-1", cwd: projectDir, prompt_response: "Hello!" },
    });

    assert.deepEqual(messageBodies.at(-1), { role: "assistant", content: "Hello!" });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/gemini/gemini-memory-flow.test.js
```

Expected:

- Fails because `afterAgent` does not persist assistant responses.

- [x] **Step 3: Implement prompt_response persistence**

In `src/platforms/gemini/index.ts`, implement `afterAgent`:

```ts
const info = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
const state = await resolveGeminiState(invocation.platform, info);
if (state.conversationId === undefined) {
  await saveSessionState(info.projectDirectory, invocation.platform, state.sessionKey, state);
  return { stdout: { continue: true, suppressOutput: true } };
}
const config = await loadNamsConfig(info.projectDirectory, this.options.env);
if (config === null) {
  await saveSessionState(info.projectDirectory, invocation.platform, state.sessionKey, state);
  return { stdout: { continue: true, suppressOutput: true } };
}
const memory = new NamsMemoryService({ ...config, ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}) });
const response = info.promptResponse;
if (response !== undefined && response.trim() !== "") {
  const assistantHash = messageHash(invocation.platform, state.sessionKey, "assistant", response);
  if (state.lastAssistantMessageHash !== assistantHash) {
    await memory.storeAssistantMessage(state.conversationId, response);
    state.lastAssistantMessageHash = assistantHash;
  }
}
await saveSessionState(info.projectDirectory, invocation.platform, state.sessionKey, state);
return { stdout: { continue: true, suppressOutput: true } };
```

- [x] **Step 4: Add failing transcript fallback test**

Append:

```js
test("Gemini AfterAgent falls back to unseen transcript assistant entries", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1", kind: "main" }),
        JSON.stringify({ id: "assistant-1", type: "gemini", content: "Fallback response" }),
      ].join("\n"),
      "utf8",
    );

    const messageBodies = [];
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" },
      fetch: async (url, init) => {
        if (String(url).endsWith("/v1/conversations")) {
          return new Response(JSON.stringify({ id: "conversation-1" }), { status: 201 });
        }
        if (String(url).endsWith("/context")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        messageBodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: `message-${messageBodies.length}` }), { status: 201 });
      },
    });

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: { session_id: "session-1", cwd: projectDir, prompt: "Say hello" },
    });
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: { session_id: "session-1", cwd: projectDir, transcript_path: transcriptPath },
    });

    assert.deepEqual(messageBodies.at(-1), { role: "assistant", content: "Fallback response" });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

Add `writeFile` to the imports in `test/gemini/gemini-memory-flow.test.js`.

- [x] **Step 5: Implement transcript assistant fallback**

In `afterAgent`, after the `prompt_response` branch, add:

```ts
if ((response === undefined || response.trim() === "") && info.transcriptPath !== undefined) {
  const transcriptEntries = await readGeminiTranscript(info.transcriptPath);
  for (const entry of transcriptEntries) {
    if (entry.kind !== "assistant") {
      continue;
    }
    if (entry.id !== undefined && state.seenTranscriptEntryIds.includes(entry.id)) {
      continue;
    }
    const assistantHash = messageHash(invocation.platform, state.sessionKey, "assistant", entry.content);
    if (state.lastAssistantMessageHash !== assistantHash) {
      await memory.storeAssistantMessage(state.conversationId, entry.content);
      state.lastAssistantMessageHash = assistantHash;
    }
    if (entry.id !== undefined) {
      state.seenTranscriptEntryIds.push(entry.id);
    }
  }
}
```

- [x] **Step 6: Verify green**

Run:

```bash
npm run build && node --test test/gemini/gemini-memory-flow.test.js
```

Expected:

- Assistant response and transcript fallback tests pass.

- [x] **Step 7: Commit**

```bash
git add src/platforms/gemini/index.ts test/gemini/gemini-memory-flow.test.js
git commit -m "feat: persist gemini assistant responses" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 10: Implement Reasoning Thoughts And Tool Metadata

**Files:**

- Modify: `src/platforms/gemini/index.ts`
- Modify: `test/gemini/gemini-memory-flow.test.js`

- [x] **Step 1: Add failing transcript thoughts and toolCalls test**

Append to `test/gemini/gemini-memory-flow.test.js`:

```js
test("Gemini transcript thoughts and toolCalls become reasoning and tool metadata without output", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-flow-"));
  try {
    const transcriptPath = path.join(projectDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1", kind: "main" }),
        JSON.stringify({
          id: "gemini-1",
          type: "gemini",
          content: "",
          thoughts: [{ subject: "Researching", description: "Searching official guidance", timestamp: "2026-05-11T12:11:55.500Z" }],
          toolCalls: [{
            id: "google_web_search_1",
            name: "google_web_search",
            args: { query: "autonomo spain" },
            result: [{ functionResponse: { response: { output: "raw output" } } }],
            resultDisplay: "raw display",
            status: "success",
            timestamp: "2026-05-11T12:12:10.860Z",
          }],
        }),
      ].join("\n"),
      "utf8",
    );

    const reasoningBodies = [];
    const toolBodies = [];
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" },
      fetch: async (url, init) => {
        const urlString = String(url);
        if (urlString.endsWith("/v1/conversations")) {
          return new Response(JSON.stringify({ id: "conversation-1" }), { status: 201 });
        }
        if (urlString.endsWith("/context")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        if (urlString.endsWith("/v1/reasoning/steps")) {
          reasoningBodies.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ id: "step-1" }), { status: 201 });
        }
        if (urlString.endsWith("/v1/reasoning/tool-calls")) {
          toolBodies.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ id: "tool-1" }), { status: 201 });
        }
        return new Response(JSON.stringify({ id: "message-1" }), { status: 201 });
      },
    });

    await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: { session_id: "session-1", cwd: projectDir, prompt: "Research autonomo" },
    });
    await adapter.afterAgent({
      platform: "gemini",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: { session_id: "session-1", cwd: projectDir, transcript_path: transcriptPath },
    });

    assert.deepEqual(reasoningBodies, [{
      conversationId: "conversation-1",
      reasoning: "Searching official guidance",
      actionTaken: "Researching",
    }]);
    assert.equal(toolBodies[0].toolName, "google_web_search");
    assert.equal(toolBodies[0].status, "success");
    assert.equal(toolBodies[0].stepId, "step-1");
    assert.equal(toolBodies[0].output, "");
    assert.match(toolBodies[0].input, /autonomo spain/);
    assert.doesNotMatch(toolBodies[0].input, /raw output|raw display|functionResponse/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/gemini/gemini-memory-flow.test.js
```

Expected:

- Fails because `afterAgent` does not process transcript thoughts or tool calls.

- [x] **Step 3: Implement reasoning and tool metadata processing**

In `src/platforms/gemini/index.ts`, add helper logic used by `afterAgent` when `transcriptPath` is present:

```ts
async function processTraceEntries(input: {
  platform: string;
  state: SessionState;
  memory: NamsMemoryService;
  transcriptEntries: GeminiTranscriptEntry[];
}): Promise<void> {
  let currentStepId: string | undefined;
  for (const entry of input.transcriptEntries) {
    if (entry.kind === "thought") {
      const thoughtHash = stableJsonHash({
        sessionKey: input.state.sessionKey,
        id: entry.id,
        subject: entry.subject,
        description: entry.description,
        timestamp: entry.timestamp,
      });
      if (input.state.seenReasoningStepHashes.includes(thoughtHash)) {
        continue;
      }
      currentStepId = await input.memory.recordReasoningStep({
        conversationId: input.state.conversationId ?? "",
        reasoning: entry.description,
        actionTaken: entry.subject,
      });
      input.state.seenReasoningStepHashes.push(thoughtHash);
      continue;
    }

    if (entry.kind === "toolCall") {
      const toolCallKey = entry.id ?? stableJsonHash({
        sessionKey: input.state.sessionKey,
        name: entry.name,
        args: entry.args,
      });
      if (input.state.seenToolCallIds.includes(toolCallKey)) {
        continue;
      }
      await input.memory.recordToolCall({
        ...(currentStepId !== undefined ? { stepId: currentStepId } : {}),
        toolName: entry.name,
        input: entry.args,
        ...(entry.status !== undefined ? { status: entry.status } : {}),
      });
      input.state.seenToolCallIds.push(toolCallKey);
    }
  }
}
```

Call this helper after transcript entries are read. Guard it with `state.conversationId !== undefined`.

- [x] **Step 4: Verify green**

Run:

```bash
npm run build && node --test test/gemini/gemini-memory-flow.test.js
```

Expected:

- Reasoning and tool metadata tests pass.

- [x] **Step 5: Commit**

```bash
git add src/platforms/gemini/index.ts test/gemini/gemini-memory-flow.test.js
git commit -m "feat: record gemini reasoning and tool metadata" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 11: Harden Non-Blocking Error Paths

**Files:**

- Modify: `src/platforms/gemini/index.ts`
- Modify: `test/gemini/gemini-memory-flow.test.js`

- [x] **Step 1: Add failing missing API key test**

Append:

```js
test("Gemini BeforeAgent continues when NAMS_API_KEY is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-flow-"));
  try {
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({ env: {} });

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: { session_id: "session-1", cwd: projectDir, prompt: "Hello" },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const logPath = path.join(projectDir, ".nams", "logs", "gemini-beforeagent.jsonl");
    const log = await readFile(logPath, "utf8");
    assert.match(log, /NAMS_API_KEY missing/);
    assert.doesNotMatch(log, /Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Add failing NAMS request failure test**

Append:

```js
test("Gemini BeforeAgent continues when NAMS request fails", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-flow-"));
  try {
    const { GeminiAdapter } = await import(geminiUrl);
    const adapter = new GeminiAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" },
      fetch: async () => new Response(JSON.stringify({ error: "service unavailable" }), { status: 503 }),
    });

    const result = await adapter.beforeAgent({
      platform: "gemini",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: { session_id: "session-1", cwd: projectDir, prompt: "Hello" },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const logPath = path.join(projectDir, ".nams", "logs", "gemini-beforeagent.jsonl");
    const log = await readFile(logPath, "utf8");
    assert.match(log, /NAMS request failed/);
    assert.doesNotMatch(log, /Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 3: Verify red**

Run:

```bash
npm run build && node --test test/gemini/gemini-memory-flow.test.js
```

Expected:

- One or both new tests fail because logging paths or catch behavior are incomplete.

- [x] **Step 4: Implement hook-safe error handling**

Wrap NAMS work in `beforeAgent`, `afterAgent`, and `afterTool` with:

```ts
try {
  // existing NAMS work
} catch (error) {
  await appendPlatformLog({
    platform: invocation.platform,
    event: invocation.event,
    projectDirectory: info.projectDirectory,
    payload: {
      message: "NAMS request failed",
      error: error instanceof Error ? error.message : String(error),
    },
  });
  await saveSessionState(info.projectDirectory, invocation.platform, state.sessionKey, state);
  return { stdout: { continue: true, suppressOutput: true } };
}
```

For missing config, log:

```ts
payload: { message: "NAMS_API_KEY missing" }
```

Do not include raw request bodies, API keys, Authorization headers, or full config objects in logs.

- [x] **Step 5: Verify green**

Run:

```bash
npm run build && node --test test/gemini/gemini-memory-flow.test.js
```

Expected:

- Error path tests pass.

- [x] **Step 6: Commit**

```bash
git add src/platforms/gemini/index.ts test/gemini/gemini-memory-flow.test.js
git commit -m "fix: keep gemini hooks non-blocking" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 12: Final Verification And Distribution Check

**Files:**

- Modify if needed: `scripts/build-dist.mjs`
- Modify if needed: `templates/gemini/hooks/hooks.json`

- [x] **Step 1: Run package verification**

Run:

```bash
npm run package:check
```

Expected:

- `openapi:check` passes.
- `npm run build` passes.
- `npm test` passes.
- `npm run dist` passes.
- `npm run dist:check` passes.

- [x] **Step 2: Inspect generated Gemini hook template in dist**

Run:

```bash
sed -n '1,220p' dist/hooks/hooks.json
```

Expected:

- Contains `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- Each command invokes `node "${extensionPath}/bin/cli.js" run gemini --event <EventName>`.

- [x] **Step 3: Commit any distribution-template fixes**

If Step 1 or Step 2 required source fixes, commit those source fixes:

```bash
git add scripts/build-dist.mjs templates/gemini/hooks/hooks.json
git commit -m "fix: include gemini memory hooks in dist" -m "Co-authored-by: Codex <codex@openai.com>"
```

If no source fixes were needed, do not create an empty commit.

- [x] **Step 4: Final status check**

Run:

```bash
git status --short --branch
```

Expected:

- No uncommitted source changes.
- Generated ignored artifacts such as `dist/` and `.build/` may exist locally but should not appear in status.

---

## Self-Review

Spec coverage:

- Conversation creation only on first utterance: Task 8.
- `SessionStart` local state only: Task 7.
- `session_id` primary and cwd fallback: Task 4 and Task 7.
- First-response recall and `additionalContext`: Task 8.
- User prompt persistence: Task 8.
- Assistant persistence from `prompt_response`: Task 9.
- Transcript assistant fallback: Task 9.
- Exposed transcript `thoughts` as reasoning steps: Task 10.
- Transcript `toolCalls[]` and `AfterTool` as metadata only: Task 10.
- No raw tool output persistence: Task 6 and Task 10.
- Non-blocking errors: Task 11.
- Architecture guards: Task 1.
- Gemini hook template coverage: Task 2 and Task 12.

Implementation must keep generated client code unchanged unless `npm run openapi:generate` intentionally changes it. This plan does not require OpenAPI regeneration.
