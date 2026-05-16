# JSON Config And Global Runtime Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace project `.nams/.env` and project-local runtime state/logs with JSON configuration, environment-final overrides, and user-local `~/.nams` state/log storage.

**Architecture:** Add one shared runtime path helper that owns all `~/.nams` path resolution, then update config, state, and logging to use it. The config loader returns a structured result with sanitized source metadata so adapters can log which source supplied `apiKey` and `baseUrl` without logging secret values. Platform adapters keep parsing platform payloads locally, but pass their injected test environment into shared runtime helpers so tests never touch a real home directory.

**Tech Stack:** TypeScript, Node.js built-ins only for runtime, Node's `node:test`, existing mocked NAMS fetch support, and the current TypeScript build/check pipeline.

---

## Scope

Included:

- Load persistent configuration from `~/.nams/config.json`.
- Overlay optional project configuration from `<project>/.nams/config.json`.
- Overlay `NAMS_API_KEY` and `NAMS_BASE_URL` from the real environment or injected test environment last.
- Support only JSON keys `apiKey` and `baseUrl`.
- Stop reading project `.nams/.env`.
- Move session state from `<project>/.nams/state/sessions/<platform>/` to `~/.nams/state/<platform>/`.
- Move logs from `<project>/.nams/logs/` to `~/.nams/logs/<platform>/`.
- Keep project `.nams/config.json` as the only project-local NAMS runtime file.
- Log sanitized config-source diagnostics, never secret values or full config objects.
- Update tests and user-facing docs that still describe `.nams/.env` or project-local state/logs.

Deferred:

- Installer and doctor command implementation.
- Automatic migration of existing project `.nams/.env`, `.nams/state/`, or `.nams/logs/`.
- Changing NAMS API behavior or platform hook payload contracts.
- Adding new config keys beyond `apiKey` and `baseUrl`.

## File Structure

Create:

- `src/runtime/paths.ts`: shared `~/.nams` path resolution for config, logs, and state.
- `test/runtime-paths.test.js`: path helper tests using temp `HOME`.
- `test/support/runtime-home.js`: test helpers for temp NAMS home paths, session logs, and session state files.

Modify:

- `src/runtime/config.ts`: replace `.env` parser with JSON config hierarchy and source metadata.
- `src/runtime/session-state.ts`: persist state under `~/.nams/state/<platform>/<session-hash>.json`.
- `src/runtime/logging.ts`: write logs under `~/.nams/logs/<platform>/`.
- `src/platforms/gemini/index.ts`: consume structured config results, pass env to state/log helpers, and log config sources.
- `src/platforms/codex/index.ts`: consume structured config results, pass env to state/log helpers, and log config sources.
- `src/platforms/opencode/index.ts`: consume structured config results, pass env to state/log helpers, and log config sources.
- `src/platforms/claude/index.ts`: write Claude logs under `~/.nams/logs/claude/`.
- `test/runtime-config.test.js`: replace `.env` tests with JSON hierarchy and source tests.
- `test/session-state.test.js`: update path assertions to `~/.nams/state/<platform>/`.
- `test/cli-session-start.test.js`: update child process `HOME`, state assertions, and log path helpers.
- `test/gemini/gemini-memory-flow.test.js`: pass temp `HOME` through adapter env and read global logs/state.
- `test/codex/codex-memory-flow.test.js`: pass temp `HOME` through adapter env and read global logs/state.
- `test/opencode/opencode-memory-flow.test.js`: pass temp `HOME` through adapter env and read global logs/state.
- `README.md`: remove stale `.env` language if present.
- `INSTALL.md`: replace `.nams/.env` setup with JSON config instructions.
- `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`: only update if implementation discovers a small naming mismatch in the already-approved design.
- `docs/superpowers/specs/2026-05-11-gemini-memory-flow-design.md`: only update if implementation discovers a small naming mismatch in the already-approved design.
- `docs/superpowers/specs/2026-05-12-codex-memory-flow-design.md`: only update if implementation discovers a small naming mismatch in the already-approved design.
- `docs/superpowers/specs/2026-05-12-opencode-memory-flow-design.md`: only update if implementation discovers a small naming mismatch in the already-approved design.

## Public APIs

The implementation should converge on these shared runtime APIs.

```ts
// src/runtime/paths.ts
export function resolveNamsHome(env?: Record<string, string | undefined>): string;
export function globalConfigPath(env?: Record<string, string | undefined>): string;
export function projectConfigPath(projectDirectory: string): string;
export function sessionStatePath(
  platform: Platform,
  sessionKey: string,
  env?: Record<string, string | undefined>,
): string;
export function platformLogDirectory(platform: Platform, env?: Record<string, string | undefined>): string;
```

```ts
// src/runtime/config.ts
export interface NamsRuntimeConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface NamsConfigSources {
  apiKey: "missing" | "global:~/.nams/config.json" | "project:.nams/config.json" | "env:NAMS_API_KEY";
  baseUrl: "default" | "global:~/.nams/config.json" | "project:.nams/config.json" | "env:NAMS_BASE_URL";
}

export type NamsConfigLoadResult =
  | {
      ok: true;
      config: NamsRuntimeConfig;
      sources: NamsConfigSources;
    }
  | {
      ok: false;
      reason: "missing-api-key" | "invalid-json";
      sources: NamsConfigSources;
      errorSource?: "global:~/.nams/config.json" | "project:.nams/config.json";
    };

export async function loadNamsConfig(
  projectDirectory: string,
  env?: Record<string, string | undefined>,
): Promise<NamsConfigLoadResult>;

export function configDiagnosticPayload(result: NamsConfigLoadResult): Record<string, unknown>;
```

---

### Task 1: Add Shared NAMS Path Helper

**Files:**

- Create: `src/runtime/paths.ts`
- Create: `test/runtime-paths.test.js`

- [ ] **Step 1: Write failing runtime path tests**

Create `test/runtime-paths.test.js`:

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pathsUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "paths.js")).href;

test("resolves NAMS home from HOME", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  try {
    const { resolveNamsHome } = await import(pathsUrl);

    assert.equal(resolveNamsHome({ HOME: homeDir }), path.join(homeDir, ".nams"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("resolves NAMS home from USERPROFILE when HOME is absent", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  try {
    const { resolveNamsHome } = await import(pathsUrl);

    assert.equal(resolveNamsHome({ USERPROFILE: homeDir }), path.join(homeDir, ".nams"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("builds config, state, and log paths under NAMS home", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  try {
    const { globalConfigPath, platformLogDirectory, projectConfigPath, sessionStatePath } = await import(pathsUrl);
    const env = { HOME: homeDir };

    assert.equal(globalConfigPath(env), path.join(homeDir, ".nams", "config.json"));
    assert.equal(projectConfigPath("/tmp/project"), path.join("/tmp/project", ".nams", "config.json"));
    assert.equal(platformLogDirectory("gemini", env), path.join(homeDir, ".nams", "logs", "gemini"));
    assert.equal(
      sessionStatePath("gemini", "session/1", env),
      path.join(homeDir, ".nams", "state", "gemini", `${sha256("session/1")}.json`),
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("throws a stable error when no home directory is available", async () => {
  const { resolveNamsHome } = await import(pathsUrl);

  assert.throws(() => resolveNamsHome({}), /Unable to resolve NAMS home directory/);
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
```

- [ ] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/runtime-paths.test.js
```

Expected: FAIL with a module-not-found error for `.build/tsc/runtime/paths.js`.

- [ ] **Step 3: Implement path helper**

Create `src/runtime/paths.ts`:

```ts
import path from "node:path";
import type { Platform } from "../interfaces.js";
import { sha256 } from "./hashing.js";

type RuntimeEnv = Record<string, string | undefined>;

export function resolveNamsHome(env: RuntimeEnv = process.env): string {
  const home = firstNonBlank(env.HOME, env.USERPROFILE);
  if (home === undefined) {
    throw new Error("Unable to resolve NAMS home directory from HOME or USERPROFILE");
  }
  return path.join(home, ".nams");
}

export function globalConfigPath(env: RuntimeEnv = process.env): string {
  return path.join(resolveNamsHome(env), "config.json");
}

export function projectConfigPath(projectDirectory: string): string {
  return path.join(projectDirectory, ".nams", "config.json");
}

export function sessionStatePath(platform: Platform, sessionKey: string, env: RuntimeEnv = process.env): string {
  return path.join(resolveNamsHome(env), "state", platform, `${sha256(sessionKey)}.json`);
}

export function platformLogDirectory(platform: Platform, env: RuntimeEnv = process.env): string {
  return path.join(resolveNamsHome(env), "logs", platform);
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "");
}
```

- [ ] **Step 4: Verify green**

Run:

```bash
npm run build && node --test test/runtime-paths.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/paths.ts test/runtime-paths.test.js
git commit -m "feat: add nams runtime path helpers" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Replace `.env` Config Loading With JSON Hierarchy

**Files:**

- Modify: `src/runtime/config.ts`
- Modify: `test/runtime-config.test.js`

- [ ] **Step 1: Replace config tests with JSON hierarchy tests**

Replace `test/runtime-config.test.js` with:

```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "config.js")).href;

test("loads global JSON config by default", async () => {
  const { homeDir, projectDir } = await makeDirs();
  try {
    await writeJson(path.join(homeDir, ".nams", "config.json"), {
      apiKey: "global-key",
      baseUrl: "https://global.example.test",
    });

    const { loadNamsConfig } = await import(configUrl);
    const result = await loadNamsConfig(projectDir, { HOME: homeDir });

    assert.deepEqual(result, {
      ok: true,
      config: {
        apiKey: "global-key",
        baseUrl: "https://global.example.test",
      },
      sources: {
        apiKey: "global:~/.nams/config.json",
        baseUrl: "global:~/.nams/config.json",
      },
    });
  } finally {
    await cleanup(homeDir, projectDir);
  }
});

test("project JSON config overlays global JSON config", async () => {
  const { homeDir, projectDir } = await makeDirs();
  try {
    await writeJson(path.join(homeDir, ".nams", "config.json"), {
      apiKey: "global-key",
      baseUrl: "https://global.example.test",
    });
    await writeJson(path.join(projectDir, ".nams", "config.json"), {
      baseUrl: "https://project.example.test",
    });

    const { loadNamsConfig } = await import(configUrl);
    const result = await loadNamsConfig(projectDir, { HOME: homeDir });

    assert.deepEqual(result, {
      ok: true,
      config: {
        apiKey: "global-key",
        baseUrl: "https://project.example.test",
      },
      sources: {
        apiKey: "global:~/.nams/config.json",
        baseUrl: "project:.nams/config.json",
      },
    });
  } finally {
    await cleanup(homeDir, projectDir);
  }
});

test("environment variables overlay project and global JSON config", async () => {
  const { homeDir, projectDir } = await makeDirs();
  try {
    await writeJson(path.join(homeDir, ".nams", "config.json"), {
      apiKey: "global-key",
      baseUrl: "https://global.example.test",
    });
    await writeJson(path.join(projectDir, ".nams", "config.json"), {
      apiKey: "project-key",
      baseUrl: "https://project.example.test",
    });

    const { loadNamsConfig } = await import(configUrl);
    const result = await loadNamsConfig(projectDir, {
      HOME: homeDir,
      NAMS_API_KEY: "env-key",
      NAMS_BASE_URL: "https://env.example.test",
    });

    assert.deepEqual(result, {
      ok: true,
      config: {
        apiKey: "env-key",
        baseUrl: "https://env.example.test",
      },
      sources: {
        apiKey: "env:NAMS_API_KEY",
        baseUrl: "env:NAMS_BASE_URL",
      },
    });
  } finally {
    await cleanup(homeDir, projectDir);
  }
});

test("does not read project .nams/.env", async () => {
  const { homeDir, projectDir } = await makeDirs();
  try {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".nams", ".env"),
      "NAMS_API_KEY=file-key\nNAMS_BASE_URL=https://file.example.test\n",
      "utf8",
    );

    const { loadNamsConfig } = await import(configUrl);
    const result = await loadNamsConfig(projectDir, { HOME: homeDir, NAMS_API_KEY: "env-key" });

    assert.deepEqual(result, {
      ok: true,
      config: {
        apiKey: "env-key",
      },
      sources: {
        apiKey: "env:NAMS_API_KEY",
        baseUrl: "default",
      },
    });
  } finally {
    await cleanup(homeDir, projectDir);
  }
});

test("missing apiKey returns a structured non-ok result", async () => {
  const { homeDir, projectDir } = await makeDirs();
  try {
    const { loadNamsConfig } = await import(configUrl);
    const result = await loadNamsConfig(projectDir, { HOME: homeDir });

    assert.deepEqual(result, {
      ok: false,
      reason: "missing-api-key",
      sources: {
        apiKey: "missing",
        baseUrl: "default",
      },
    });
  } finally {
    await cleanup(homeDir, projectDir);
  }
});

test("invalid JSON returns a structured non-ok result without raw file content", async () => {
  const { homeDir, projectDir } = await makeDirs();
  try {
    await mkdir(path.join(homeDir, ".nams"), { recursive: true });
    await writeFile(path.join(homeDir, ".nams", "config.json"), "{", "utf8");

    const { loadNamsConfig } = await import(configUrl);
    const result = await loadNamsConfig(projectDir, { HOME: homeDir, NAMS_API_KEY: "env-key" });

    assert.deepEqual(result, {
      ok: false,
      reason: "invalid-json",
      errorSource: "global:~/.nams/config.json",
      sources: {
        apiKey: "missing",
        baseUrl: "default",
      },
    });
  } finally {
    await cleanup(homeDir, projectDir);
  }
});

test("config diagnostic payload includes sources but not secret values", async () => {
  const { configDiagnosticPayload } = await import(configUrl);
  const payload = configDiagnosticPayload({
    ok: true,
    config: {
      apiKey: "secret-key",
      baseUrl: "https://memory.example.test",
    },
    sources: {
      apiKey: "env:NAMS_API_KEY",
      baseUrl: "project:.nams/config.json",
    },
  });

  assert.deepEqual(payload, {
    message: "NAMS config loaded",
    configSources: {
      apiKey: "env:NAMS_API_KEY",
      baseUrl: "project:.nams/config.json",
    },
  });
  assert.equal(JSON.stringify(payload).includes("secret-key"), false);
});

async function makeDirs() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-project-"));
  return { homeDir, projectDir };
}

async function cleanup(...dirs) {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
```

- [ ] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/runtime-config.test.js
```

Expected: FAIL because `loadNamsConfig()` still reads `.nams/.env` and returns `NamsRuntimeConfig | null`.

- [ ] **Step 3: Implement JSON config loader**

Replace `src/runtime/config.ts` with:

```ts
import { readFile } from "node:fs/promises";
import { globalConfigPath, projectConfigPath } from "./paths.js";

type RuntimeEnv = Record<string, string | undefined>;
type JsonConfigSource = "global:~/.nams/config.json" | "project:.nams/config.json";

export interface NamsRuntimeConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface NamsConfigSources {
  apiKey: "missing" | JsonConfigSource | "env:NAMS_API_KEY";
  baseUrl: "default" | JsonConfigSource | "env:NAMS_BASE_URL";
}

export type NamsConfigLoadResult =
  | {
      ok: true;
      config: NamsRuntimeConfig;
      sources: NamsConfigSources;
    }
  | {
      ok: false;
      reason: "missing-api-key" | "invalid-json";
      sources: NamsConfigSources;
      errorSource?: JsonConfigSource;
    };

interface PartialConfig {
  apiKey?: string;
  baseUrl?: string;
}

export async function loadNamsConfig(
  projectDirectory: string,
  env: RuntimeEnv = process.env,
): Promise<NamsConfigLoadResult> {
  const merged: PartialConfig = {};
  const sources: NamsConfigSources = {
    apiKey: "missing",
    baseUrl: "default",
  };

  const global = await readJsonConfig(globalConfigPath(env), "global:~/.nams/config.json");
  if (!global.ok) {
    return { ok: false, reason: "invalid-json", errorSource: global.source, sources };
  }
  applyJsonConfig(merged, sources, global.value, global.source);

  const project = await readJsonConfig(projectConfigPath(projectDirectory), "project:.nams/config.json");
  if (!project.ok) {
    return { ok: false, reason: "invalid-json", errorSource: project.source, sources };
  }
  applyJsonConfig(merged, sources, project.value, project.source);

  applyEnvConfig(merged, sources, env);

  if (merged.apiKey === undefined) {
    return { ok: false, reason: "missing-api-key", sources };
  }

  return {
    ok: true,
    config: {
      apiKey: merged.apiKey,
      ...(merged.baseUrl !== undefined ? { baseUrl: merged.baseUrl } : {}),
    },
    sources,
  };
}

export function configDiagnosticPayload(result: NamsConfigLoadResult): Record<string, unknown> {
  if (result.ok) {
    return {
      message: "NAMS config loaded",
      configSources: result.sources,
    };
  }
  if (result.reason === "invalid-json") {
    return {
      message: "NAMS config invalid",
      configSources: result.sources,
      errorSource: result.errorSource,
    };
  }
  return {
    message: "NAMS apiKey missing",
    configSources: result.sources,
  };
}

async function readJsonConfig(
  filePath: string,
  source: JsonConfigSource,
): Promise<{ ok: true; source: JsonConfigSource; value: Record<string, unknown> } | { ok: false; source: JsonConfigSource }> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: true, source, value: {} };
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(content);
    return {
      ok: true,
      source,
      value: isPlainRecord(parsed) ? parsed : {},
    };
  } catch {
    return { ok: false, source };
  }
}

function applyJsonConfig(
  merged: PartialConfig,
  sources: NamsConfigSources,
  value: Record<string, unknown>,
  source: JsonConfigSource,
): void {
  const apiKey = nonBlankString(value.apiKey);
  if (apiKey !== undefined) {
    merged.apiKey = apiKey;
    sources.apiKey = source;
  }

  const baseUrl = nonBlankString(value.baseUrl);
  if (baseUrl !== undefined) {
    merged.baseUrl = baseUrl;
    sources.baseUrl = source;
  }
}

function applyEnvConfig(merged: PartialConfig, sources: NamsConfigSources, env: RuntimeEnv): void {
  const apiKey = nonBlankString(env.NAMS_API_KEY);
  if (apiKey !== undefined) {
    merged.apiKey = apiKey;
    sources.apiKey = "env:NAMS_API_KEY";
  }

  const baseUrl = nonBlankString(env.NAMS_BASE_URL);
  if (baseUrl !== undefined) {
    merged.baseUrl = baseUrl;
    sources.baseUrl = "env:NAMS_BASE_URL";
  }
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 4: Verify green**

Run:

```bash
npm run build && node --test test/runtime-config.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/config.ts test/runtime-config.test.js
git commit -m "feat: load nams json config hierarchy" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Move Session State To User-Local Storage

**Files:**

- Modify: `src/runtime/session-state.ts`
- Modify: `test/session-state.test.js`

- [ ] **Step 1: Update session-state tests for `~/.nams/state/<platform>/`**

In `test/session-state.test.js`, change the persistence test name to:

```js
test("persists session state under user-local .nams/state/<platform> using safe session filenames", async () => {
```

Inside that test, create a separate home directory and pass it to state helpers:

```js
const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
const projectDir = await mkdtemp(path.join(tmpdir(), "nams-state-"));
try {
  const env = { HOME: homeDir };
  const { loadSessionState, saveSessionState } = await import(stateUrl);
  const state = {
    harness: "gemini",
    harnessSessionId: "session/1",
    sessionKey: "session/1",
    projectDirectory: projectDir,
    conversationId: "conversation-1",
    createdAt: "2026-05-11T12:00:00.000Z",
    seenAssistantMessageHashes: [],
    seenTranscriptEntryIds: [],
    seenReasoningStepHashes: [],
    seenToolCallIds: [],
    reasoningStepIdsByHash: {},
  };

  await saveSessionState(projectDir, "gemini", "session/1", state, env);

  const savedPath = path.join(homeDir, ".nams", "state", "gemini", `${sha256("session/1")}.json`);
  assert.deepEqual(JSON.parse(await readFile(savedPath, "utf8")), state);
  assert.deepEqual(await loadSessionState(projectDir, "gemini", "session/1", env), state);
} finally {
  await rm(homeDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
}
```

In the legacy `lastMemorySearchAt` test, write the fixture under the new global path:

```js
const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
const projectDir = await mkdtemp(path.join(tmpdir(), "nams-state-"));
try {
  const env = { HOME: homeDir };
  const { loadSessionState } = await import(stateUrl);
  const statePath = path.join(homeDir, ".nams", "state", "gemini", `${sha256("session-1")}.json`);
```

Call:

```js
const state = await loadSessionState(projectDir, "gemini", "session-1", env);
```

In the colliding-looking session keys test, use `homeDir`, `env`, and expected load calls:

```js
await saveSessionState(projectDir, "gemini", "session/1", slashState, env);
await saveSessionState(projectDir, "gemini", "session_1", underscoreState, env);

assert.equal((await loadSessionState(projectDir, "gemini", "session/1", env)).conversationId, "conversation-slash");
assert.equal((await loadSessionState(projectDir, "gemini", "session_1", env)).conversationId, "conversation-underscore");
```

- [ ] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/session-state.test.js
```

Expected: FAIL because `loadSessionState()` and `saveSessionState()` do not accept an env argument and still use project-local paths.

- [ ] **Step 3: Update session-state implementation**

In `src/runtime/session-state.ts`, add the import:

```ts
import { sessionStatePath } from "./paths.js";
```

Change the signatures:

```ts
export async function loadSessionState(
  projectDirectory: string,
  platform: Platform,
  sessionKey: string,
  env: Record<string, string | undefined> = process.env,
): Promise<SessionState | null> {
```

```ts
export async function saveSessionState(
  projectDirectory: string,
  platform: Platform,
  sessionKey: string,
  state: SessionState,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
```

Use the shared path helper:

```ts
const state = JSON.parse(await readFile(sessionStatePath(platform, sessionKey, env), "utf8")) as SessionState & {
  lastMemorySearchAt?: string;
};
```

```ts
const statePath = sessionStatePath(platform, sessionKey, env);
await mkdir(path.dirname(statePath), { recursive: true });
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
```

Remove the old private `sessionStatePath(projectDirectory, platform, sessionKey)` function and remove the now-unused `sha256` import from this file.

- [ ] **Step 4: Verify green**

Run:

```bash
npm run build && node --test test/session-state.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/session-state.ts test/session-state.test.js
git commit -m "feat: store nams session state globally" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Move Logs To User-Local Platform Directories

**Files:**

- Create: `test/support/runtime-home.js`
- Modify: `src/runtime/logging.ts`
- Modify: `test/cli-session-start.test.js`

- [ ] **Step 1: Add test helpers for global runtime home**

Create `test/support/runtime-home.js`:

```js
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export function runtimeEnv(homeDir, extra = {}) {
  return {
    ...extra,
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
}

export function namsHome(homeDir) {
  return path.join(homeDir, ".nams");
}

export async function singleSessionLogPath(homeDir, platform) {
  const logDir = path.join(namsHome(homeDir), "logs", platform);
  const logFiles = (await readdir(logDir)).filter((fileName) => /^session-.*\.jsonl$/.test(fileName));
  assert.equal(logFiles.length, 1, `expected one ${platform} session log file, got ${logFiles.join(", ")}`);
  return path.join(logDir, logFiles[0]);
}

export async function readSingleSessionLog(homeDir, platform) {
  const logPath = await singleSessionLogPath(homeDir, platform);
  const text = await readFile(logPath, "utf8");
  return {
    logPath,
    lines: text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

export async function sessionStateFiles(homeDir, platform) {
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

- [ ] **Step 2: Update CLI tests to set child HOME and expect global logs**

In `test/cli-session-start.test.js`, import the helpers:

```js
import { runtimeEnv, singleSessionLogPath, sessionStateFiles } from "./support/runtime-home.js";
```

Change `runCliWithEvent()` to accept an optional env:

```js
function runCliWithEvent(harness, event, payload, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "run", harness, "--event", event], {
      cwd,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
```

Change `runCli()`:

```js
function runCli(harness, payload, cwd, env = {}) {
  return runCliWithEvent(harness, "SessionStart", payload, cwd, env);
}
```

Change `runCliWithoutEvent()` to accept `env = {}` and pass the same merged `env` object into `spawn()`.

In each CLI test, create a `homeDir`, pass `runtimeEnv(homeDir)` to the CLI, and clean it up. For example, the session-start loop should begin:

```js
const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
try {
```

Call:

```js
const result = await runCli(harness, payload, projectDir, runtimeEnv(homeDir));
```

Replace log path logic with:

```js
const logPath =
  harness === "gemini" || harness === "codex" || harness === "opencode"
    ? await singleSessionLogPath(homeDir, harness)
    : path.join(homeDir, ".nams", "logs", harness, `${harness}-session-start.jsonl`);
```

For the OpenCode directory precedence test, assert state under `homeDir`:

```js
assert.equal((await sessionStateFiles(homeDir, "opencode")).length, 1);
assert.deepEqual(await sessionStateFiles(cwdDir, "opencode"), []);
```

Remove the local helper functions `singleSessionLogPath()` and `sessionStateFiles()` from the bottom of `test/cli-session-start.test.js` after importing them from `test/support/runtime-home.js`.

- [ ] **Step 3: Verify red**

Run:

```bash
npm run build && node --test test/cli-session-start.test.js
```

Expected: FAIL because `appendPlatformLog()` still writes to project-local `.nams/logs`.

- [ ] **Step 4: Update logging implementation**

In `src/runtime/logging.ts`, import the path helper:

```ts
import { platformLogDirectory } from "./paths.js";
```

Add an optional env to `PlatformLogEntry`:

```ts
  env?: Record<string, string | undefined>;
```

Change `appendPlatformLog()` to use the platform directory:

```ts
export async function appendPlatformLog(entry: PlatformLogEntry): Promise<void> {
  const logDir = platformLogDirectory(entry.platform, entry.env);
  const logPath = path.join(logDir, logFileName(entry));
```

Keep `logFileName()` unchanged so state-backed logs keep the existing session file name. Non-state logs now live under the platform directory, for example `~/.nams/logs/claude/claude-session-start.jsonl`.

- [ ] **Step 5: Verify CLI logging behavior**

Run:

```bash
npm run build && node --test test/cli-session-start.test.js
```

Expected at this point:

- Claude logging assertions pass.
- Gemini/Codex/OpenCode session-start tests may still fail until Task 5 passes env into state/logging helpers from adapters.

- [ ] **Step 6: Commit**

Commit only if the CLI test file passes after Task 5 adapter wiring. If it still fails, leave the changes staged for Task 5 and do not commit a broken checkpoint.

```bash
git add src/runtime/logging.ts test/cli-session-start.test.js test/support/runtime-home.js
git commit -m "feat: store nams logs globally" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Wire Platform Adapters To Global Paths And Config Diagnostics

**Files:**

- Modify: `src/platforms/gemini/index.ts`
- Modify: `src/platforms/codex/index.ts`
- Modify: `src/platforms/opencode/index.ts`
- Modify: `src/platforms/claude/index.ts`
- Modify: `test/gemini/gemini-memory-flow.test.js`
- Modify: `test/codex/codex-memory-flow.test.js`
- Modify: `test/opencode/opencode-memory-flow.test.js`
- Modify: `test/cli-session-start.test.js`

- [ ] **Step 1: Update adapter tests to pass temp HOME**

In each memory-flow test file, import helpers:

```js
import { readSingleSessionLog, runtimeEnv } from "../support/runtime-home.js";
```

For every adapter construction without env, pass temp home:

```js
const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
const projectDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-flow-"));
try {
  const { GeminiAdapter } = await import(geminiUrl);
  const { loadSessionState } = await import(stateUrl);
  const adapter = new GeminiAdapter({ env: runtimeEnv(homeDir) });
```

For every adapter construction with NAMS variables, wrap the existing values:

```js
const adapter = new GeminiAdapter({
  env: runtimeEnv(homeDir, {
    NAMS_API_KEY: "key",
    NAMS_BASE_URL: "https://memory.example.test",
  }),
  fetch: nams.fetch,
});
```

Use the same pattern for `CodexAdapter` and `OpenCodeAdapter`.

When calling `loadSessionState()` in tests, pass the same runtime env:

```js
const state = await loadSessionState(projectDir, "gemini", "session-1", runtimeEnv(homeDir));
```

Replace project-local log reads:

```js
const { lines } = await readSingleSessionLog(homeDir, "gemini");
```

Use platform names `"codex"` and `"opencode"` in their respective test files.

In tests that currently inspect `path.join(projectDir, ".nams", "logs")`, replace that assertion with:

```js
const logFileNames = await readdir(path.join(homeDir, ".nams", "logs", "codex"));
assert.equal(logFileNames.filter((fileName) => fileName.startsWith("session-")).length, 1);
assert.equal(logFileNames.includes("codex-session-start.jsonl"), false);
```

- [ ] **Step 2: Update missing config assertions**

Replace test expectations for old diagnostics:

```js
assert.match(log, /NAMS_API_KEY missing/);
```

with:

```js
assert.match(log, /NAMS apiKey missing/);
assert.match(log, /"apiKey":"missing"/);
```

Add one success-source assertion in the first successful Gemini, Codex, and OpenCode memory-flow tests:

```js
const configDiagnostics = lines.filter((entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS config loaded");
assert.equal(configDiagnostics.length, 1);
assert.deepEqual(configDiagnostics[0].payload.configSources, {
  apiKey: "env:NAMS_API_KEY",
  baseUrl: "env:NAMS_BASE_URL",
});
```

- [ ] **Step 3: Verify red**

Run each focused test:

```bash
npm run build && node --test test/gemini/gemini-memory-flow.test.js
npm run build && node --test test/codex/codex-memory-flow.test.js
npm run build && node --test test/opencode/opencode-memory-flow.test.js
npm run build && node --test test/cli-session-start.test.js
```

Expected: FAIL because adapters still call config/state/log helpers with old return shapes and no env propagation.

- [ ] **Step 4: Update Gemini adapter config loading**

In `src/platforms/gemini/index.ts`, change the import:

```ts
import { configDiagnosticPayload, loadNamsConfig, type NamsRuntimeConfig } from "../../runtime/config.js";
```

For each existing `loadNamsConfig(payloadInfo.projectDirectory, this.options.env)` block, use this shape:

```ts
const configResult = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state, configResult);
if (!configResult.ok) {
  await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
  return allowOutput();
}
const config = configResult.config;
```

For the `beforeAgent()` block that can return recalled context after a NAMS failure, keep the existing `allowOutput(additionalContext)` behavior in the catch block. Only the config-missing path returns `allowOutput()` because no memory request was attempted.

Change every Gemini state call to pass env:

```ts
await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey, this.options.env)
await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env)
```

Change each Gemini log helper call signature to accept env:

```ts
await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state, this.options.env);
await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state, this.options.env);
```

Replace the Gemini config diagnostic helper with:

```ts
async function appendNamsConfigDiagnostic(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
  result: NamsConfigLoadResult,
  env: Record<string, string | undefined> | undefined,
): Promise<void> {
  await appendGeminiDiagnosticLog({
    platform: invocation.platform,
    event: invocation.event,
    projectDirectory,
    state,
    payload: configDiagnosticPayload(result),
    env,
  });
}
```

Update the local diagnostic-log entry type to include env:

```ts
async function appendGeminiDiagnosticLog(entry: {
  platform: HookInvocation["platform"];
  event: HookInvocation["event"];
  projectDirectory: string;
  state: SessionState;
  payload: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}): Promise<void> {
```

Pass env to `appendPlatformLog()` in Gemini diagnostic, raw, and NAMS request logging:

```ts
env: entry.env,
```

```ts
env,
```

Add the missing type import:

```ts
import type { NamsConfigLoadResult } from "../../runtime/config.js";
```

- [ ] **Step 5: Update Codex adapter config loading**

Apply the same config-result pattern in `src/platforms/codex/index.ts`:

```ts
const configResult = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state, configResult, this.options.env);
if (!configResult.ok) {
  await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
  return allowOutput();
}
const config = configResult.config;
```

Change Codex state calls to:

```ts
await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey, this.options.env)
await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env)
```

Change Codex logging helper calls to pass `this.options.env`.

Replace Codex config diagnostic payload:

```ts
payload: configDiagnosticPayload(result),
```

Pass env into every `appendPlatformLog()` call inside Codex helper functions. Keep Codex NAMS request log sanitization unchanged, including the `apiKey` argument, so bearer values remain redacted.

- [ ] **Step 6: Update OpenCode adapter config loading**

Apply the same config-result pattern in `src/platforms/opencode/index.ts`:

```ts
const configResult = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state, configResult, this.options.env);
if (!configResult.ok) {
  await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
  return allowOutput();
}
const config = configResult.config;
```

Change OpenCode state calls to:

```ts
await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey, this.options.env)
await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env)
```

Change OpenCode logging helper calls to pass `this.options.env`.

Replace OpenCode config diagnostic payload:

```ts
payload: configDiagnosticPayload(result),
```

Pass env into every `appendPlatformLog()` call inside OpenCode helper functions.

- [ ] **Step 7: Update Claude log env**

In `src/platforms/claude/index.ts`, keep the adapter minimal but allow test env propagation later by adding options:

```ts
export interface ClaudeAdapterOptions {
  env?: Record<string, string | undefined>;
}

export class ClaudeAdapter implements PlatformAdapter {
  constructor(private readonly options: ClaudeAdapterOptions = {}) {}
```

Pass env into `appendPlatformLog()`:

```ts
await appendPlatformLog({
  platform: invocation.platform,
  event: invocation.event,
  payload: invocation.rawPayload,
  projectDirectory: resolveClaudeProjectDirectory(invocation),
  env: this.options.env,
});
```

If the static platform registry constructs `new ClaudeAdapter()` with no options, no registry change is required.

- [ ] **Step 8: Verify focused tests**

Run:

```bash
npm run build && node --test test/runtime-config.test.js test/session-state.test.js test/cli-session-start.test.js test/gemini/gemini-memory-flow.test.js test/codex/codex-memory-flow.test.js test/opencode/opencode-memory-flow.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/platforms/gemini/index.ts src/platforms/codex/index.ts src/platforms/opencode/index.ts src/platforms/claude/index.ts test/gemini/gemini-memory-flow.test.js test/codex/codex-memory-flow.test.js test/opencode/opencode-memory-flow.test.js test/cli-session-start.test.js test/support/runtime-home.js
git commit -m "feat: wire platforms to global nams runtime storage" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 6: Update User-Facing Docs And Remove Stale References

**Files:**

- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md` only if implementation names differ from design.
- Modify: `docs/superpowers/specs/2026-05-11-gemini-memory-flow-design.md` only if implementation names differ from design.
- Modify: `docs/superpowers/specs/2026-05-12-codex-memory-flow-design.md` only if implementation names differ from design.
- Modify: `docs/superpowers/specs/2026-05-12-opencode-memory-flow-design.md` only if implementation names differ from design.

- [ ] **Step 1: Replace INSTALL configuration section**

In `INSTALL.md`, replace the current `.nams/.env` section with:

````md
## Configuration

Create a user-local config file at `~/.nams/config.json`:

```json
{
  "apiKey": "nams-api-key",
  "baseUrl": "https://memory.neo4jlabs.com"
}
```

`apiKey` is required for NAMS requests. `baseUrl` is optional and defaults to the runtime client's built-in NAMS URL.

Projects may override either key with `<project>/.nams/config.json`:

```json
{
  "baseUrl": "https://memory.neo4jlabs.com"
}
```

Environment variables are final overrides:

- `NAMS_API_KEY` overrides `apiKey`.
- `NAMS_BASE_URL` overrides `baseUrl`.

The runtime does not read `.env` files.
````

- [ ] **Step 2: Update OpenCode install note**

In `INSTALL.md`, replace OpenCode text that references project `.nams/.env` with:

```md
OpenCode uses the same NAMS configuration hierarchy as other harnesses: `~/.nams/config.json`, optional project `.nams/config.json`, then final `NAMS_API_KEY` and `NAMS_BASE_URL` environment overrides.
```

- [ ] **Step 3: Update README if it mentions `.env` or project logs**

Run:

```bash
rg -n "\\.nams/\\.env|\\.nams/logs|\\.nams/state|NAMS_API_KEY" README.md INSTALL.md
```

Expected before edits: stale matches in `INSTALL.md`; possible matches in `README.md`.

Any README configuration paragraph should use this wording:

```md
Runtime configuration is JSON-first: `~/.nams/config.json`, optional project `.nams/config.json`, then final `NAMS_API_KEY` and `NAMS_BASE_URL` environment overrides. Runtime state and logs are user-local under `~/.nams/state/<platform>/` and `~/.nams/logs/<platform>/`.
```

- [ ] **Step 4: Verify stale reference scan**

Run:

```bash
rg -n "\\.nams/\\.env|project-local `\\.nams/(state|logs)|project-local \\.nams/(state|logs)|\\.nams/state/sessions|NAMS_API_KEY missing|\\.nams/logs/session" README.md INSTALL.md src test docs/superpowers/specs
```

Expected: no stale matches. Acceptable matches are:

- `NAMS_API_KEY` as an environment override name.
- `~/.nams/state/` as user-local runtime state.
- `~/.nams/logs/` as user-local runtime logs.
- Old implementation-plan files under `docs/superpowers/plans/` if the scan is intentionally expanded to include historical plans.

- [ ] **Step 5: Commit**

```bash
git add README.md INSTALL.md docs/superpowers/specs/2026-05-10-nams-hooks-design.md docs/superpowers/specs/2026-05-11-gemini-memory-flow-design.md docs/superpowers/specs/2026-05-12-codex-memory-flow-design.md docs/superpowers/specs/2026-05-12-opencode-memory-flow-design.md
git commit -m "docs: update json config runtime storage usage" -m "Co-authored-by: Codex <codex@openai.com>"
```

If no spec files changed, omit them from `git add`.

---

### Task 7: Full Verification And Final Cleanup

**Files:**

- Modify only files already touched by earlier tasks.

- [ ] **Step 1: Run focused stale-reference checks**

Run:

```bash
rg -n "\\.nams/\\.env|\\.nams/state/sessions|NAMS_API_KEY missing|project-local `\\.nams/(state|logs)|project-local \\.nams/(state|logs)" src test README.md INSTALL.md docs/superpowers/specs
```

Expected: no matches.

Run:

```bash
rg -n "NAMS_API_KEY" src test README.md INSTALL.md docs/superpowers/specs
```

Expected: matches only for the supported environment override name or tests that explicitly assert env override behavior.

- [ ] **Step 2: Run format/diff hygiene check**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 3: Run full repository check**

Run:

```bash
npm run check
```

Expected:

- OpenAPI freshness check passes.
- TypeScript build passes.
- All Node tests pass.

- [ ] **Step 4: Run package check**

Run:

```bash
npm run package:check
```

Expected:

- `npm run check` passes.
- `npm run dist` completes.
- `npm run dist:check` passes.
- Generated `dist/` remains ignored on `devel`.

- [ ] **Step 5: Review changed files**

Run:

```bash
git status --short
git diff --stat
```

Expected:

- Changes are limited to runtime config/state/logging, platform adapter wiring, tests, and user-facing docs.
- No generated `dist/` files are staged.
- No project `.nams/` files are present.

- [ ] **Step 6: Final commit if needed**

If Tasks 1-6 already committed every change, skip this step.

If verification required small follow-up edits, commit them:

```bash
git add src test README.md INSTALL.md docs/superpowers/specs
git commit -m "chore: finish json config storage migration" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

## Self-Review Checklist

- [ ] Config hierarchy is covered by Task 2: global JSON, project JSON overlay, env-final overlay.
- [ ] `.env` removal is covered by Task 2 and stale-reference scans in Tasks 6 and 7.
- [ ] Source diagnostics are covered by Task 2 and platform assertions in Task 5.
- [ ] State location is covered by Task 3 and adapter wiring in Task 5.
- [ ] Log location is covered by Task 4 and adapter wiring in Task 5.
- [ ] Claude's simpler logging path is covered by Task 5.
- [ ] User-facing docs are covered by Task 6.
- [ ] Full verification is covered by Task 7.
- [ ] No task requires runtime npm dependencies.
- [ ] No task writes test artifacts into the repository root.
