# Claude Code Memory Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking: `- [x]` for work already completed in the current branch, and `- [ ]` for remaining implementation work.

**Goal:** Build Claude Code NAMS integration parity with the implemented Gemini, Codex, and OpenCode memory flows: lazy conversation creation, first-turn recall, user and assistant message persistence, session-scoped logs, and successful tool-call trace recording.

**Architecture:** `src/cli.ts` stays a platform-agnostic typed NAMS event gateway. Claude hook templates translate native hooks to existing NAMS events (`UserPromptSubmit` -> `BeforeAgent`, `PostToolUse` -> `AfterTool`, `Stop` -> `AfterAgent`). Claude-specific payload parsing and orchestration live under `src/platforms/claude/`, while shared runtime modules continue to own config, local state, hashing, logging, and NAMS REST calls through the generated client.

**Tech Stack:** TypeScript, Node.js built-ins at runtime, generated `NamsClient`, Node's `node:test`, `fetch-mock` test support, and existing ArchUnitTS architecture checks.

---

## Scope

This plan implements the approved design in `docs/superpowers/specs/2026-05-12-claude-memory-flow-design.md`.

Current branch baseline:

- `src/platforms/claude/index.ts` already has a complete allow-only walking skeleton for `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- `templates/claude/settings.local.json` already translates Claude `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop` to the shared NAMS events.
- `test/claude-template.test.js` and `test/cli-session-start.test.js` already cover the current Claude template and typed-event routing.
- Gemini, Codex, and OpenCode already use session-scoped logs and stateful memory flows; Claude should converge on those runtime patterns.

Included:

- Completed Claude template mapping from native hooks to existing NAMS events.
- Claude payload parser module and tests.
- Claude `SessionStart` state initialization with session-scoped logs.
- NAMS `BeforeAgent` handling for Claude `UserPromptSubmit`: conversation creation, recall, context injection, and user prompt persistence.
- NAMS `AfterAgent` handling for Claude `Stop`: assistant response persistence from `last_assistant_message`.
- NAMS `AfterTool` handling for Claude `PostToolUse`: reasoning step plus tool-call persistence from exposed hook fields.
- Deduplication for user prompts, assistant messages, and tool calls.
- Sanitized diagnostics and NAMS request logging.

Deferred:

- Claude `PostToolUseFailure`, `PostToolBatch`, `StopFailure`, `SessionEnd`, subagent-specific memory, transcript recovery, installer behavior, and doctor checks.

## File Structure

Create:

- `src/platforms/claude/payload.ts`: Claude-only payload extraction helpers.
- `test/claude/claude-payload.test.js`: parser tests.
- `test/claude/claude-memory-flow.test.js`: fixture-driven Claude adapter tests.

Modify:

- `src/platforms/claude/index.ts`: replace the allow-only walking skeleton with full Claude memory flow.
- `src/runtime/memory-service.ts`: add an opt-in untruncated explicit tool-output path while preserving the current capped default for Gemini, Codex, and OpenCode.
- `test/cli-session-start.test.js`: update Claude log expectations when Claude moves to session-scoped logs.
- `test/memory-service.test.js`: cover default capped output plus Claude's opt-in untruncated output path.

Do not modify:

- `src/interfaces.ts`: it keeps the existing NAMS event names.
- `src/cli.ts`: it remains a platform-agnostic NAMS event gateway.
- `templates/claude/settings.local.json`: the native-hook to NAMS-event mapping is already in place unless Claude hook configuration changes.

## Public APIs Introduced

```ts
export interface ClaudePayloadInfo {
  sessionId?: string;
  projectDirectory: string;
  transcriptPath?: string;
  source?: string;
  prompt?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  durationMs?: number;
  lastAssistantMessage?: string;
}
```

```ts
export function parseClaudePayload(payload: Record<string, unknown>, processCwd: string): ClaudePayloadInfo;
```

```ts
export interface ToolCallInput {
  stepId?: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  status?: string;
  durationMs?: number;
  truncateOutput?: boolean;
}
```

```ts
export function serializeToolOutput(output: unknown, options?: { truncate?: boolean }): string;
```

---

### Task 1: Map Claude Hooks To NAMS Events

Status: complete in the current branch. Keep this task as the audit trail for the already-merged walking skeleton and template work; start new implementation at Task 2.

**Files:**

- Modify: `templates/claude/settings.local.json`
- Modify: `test/cli-session-start.test.js`
- Modify: `test/claude-template.test.js`

- [x] **Step 1: Add Claude NAMS-event routing tests**

Append to `test/cli-session-start.test.js`:

```js
const claudeHookMappings = [
  ["UserPromptSubmit", "BeforeAgent"],
  ["PostToolUse", "AfterTool"],
  ["Stop", "AfterAgent"],
];

for (const [claudeHook, namsEvent] of claudeHookMappings) {
  test(`routes claude ${claudeHook} through NAMS ${namsEvent}`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const payload = {
        session_id: `claude-${namsEvent}`,
        hook_event_name: claudeHook,
        cwd: projectDir,
      };

      const result = await runCliWithEvent("claude", namsEvent, payload, projectDir);

      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).continue, true);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
}
```

- [x] **Step 2: Verify routing baseline**

Run:

```bash
npm run build && node --test test/cli-session-start.test.js
```

Expected:

- Build passes.
- The new tests pass against the current platform-agnostic CLI because they use existing NAMS events.

- [x] **Step 3: Update Claude hook template**

Replace `templates/claude/settings.local.json` with:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run claude --event SessionStart"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run claude --event BeforeAgent"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run claude --event AfterTool"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run claude --event AfterAgent"
          }
        ]
      }
    ]
  }
}
```

- [x] **Step 4: Verify template and routing tests**

Run:

```bash
npm run build && node --test test/cli-session-start.test.js test/claude-template.test.js
```

Expected:

- All CLI routing tests pass.
- Claude template maps `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop` to NAMS events.

- [x] **Step 5: Commit mapping changes**

```bash
git add templates/claude/settings.local.json test/cli-session-start.test.js test/claude-template.test.js
git commit -m "feat: map claude hooks to nams events" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Add Claude Payload Parser

**Files:**

- Create: `src/platforms/claude/payload.ts`
- Create: `test/claude/claude-payload.test.js`

- [ ] **Step 1: Write parser tests**

Create `test/claude/claude-payload.test.js`:

```js
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const payloadUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "claude", "payload.js")).href;

test("extracts Claude prompt and session fields", async () => {
  const { parseClaudePayload } = await import(payloadUrl);

  assert.deepEqual(
    parseClaudePayload(
      {
        session_id: "session-1",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/tmp/project",
        source: "startup",
        prompt: "Remember my test preference.",
      },
      "/fallback",
    ),
    {
      sessionId: "session-1",
      projectDirectory: "/tmp/project",
      transcriptPath: "/tmp/transcript.jsonl",
      source: "startup",
      prompt: "Remember my test preference.",
    },
  );
});

test("extracts Claude tool fields and numeric duration", async () => {
  const { parseClaudePayload } = await import(payloadUrl);

  assert.deepEqual(
    parseClaudePayload(
      {
        cwd: "/tmp/project",
        tool_use_id: "toolu_1",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_response: { stdout: "ok" },
        duration_ms: "42",
      },
      "/fallback",
    ),
    {
      projectDirectory: "/tmp/project",
      toolUseId: "toolu_1",
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolResponse: { stdout: "ok" },
      durationMs: 42,
    },
  );
});

test("extracts Claude stop assistant message and falls back to process cwd", async () => {
  const { parseClaudePayload } = await import(payloadUrl);

  assert.deepEqual(
    parseClaudePayload(
      {
        session_id: "session-1",
        last_assistant_message: "Done.",
      },
      "/fallback",
    ),
    {
      sessionId: "session-1",
      projectDirectory: "/fallback",
      lastAssistantMessage: "Done.",
    },
  );
});

test("ignores blank string aliases", async () => {
  const { parseClaudePayload } = await import(payloadUrl);

  assert.deepEqual(
    parseClaudePayload(
      {
        session_id: "",
        cwd: "  ",
        prompt: "",
        tool_name: "Read",
      },
      "/fallback",
    ),
    {
      projectDirectory: "/fallback",
      toolName: "Read",
    },
  );
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/claude/claude-payload.test.js
```

Expected:

- Build fails because `src/platforms/claude/payload.ts` does not exist.

- [ ] **Step 3: Implement parser**

Create `src/platforms/claude/payload.ts`:

```ts
export interface ClaudePayloadInfo {
  sessionId?: string;
  projectDirectory: string;
  transcriptPath?: string;
  source?: string;
  prompt?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  durationMs?: number;
  lastAssistantMessage?: string;
}

export function parseClaudePayload(payload: Record<string, unknown>, processCwd: string): ClaudePayloadInfo {
  const sessionId = firstString(payload.session_id, payload.sessionId);
  const projectDirectory = firstString(payload.cwd, payload.CLAUDE_PROJECT_DIR) ?? processCwd;
  const transcriptPath = firstString(payload.transcript_path, payload.transcriptPath);
  const source = firstString(payload.source);
  const prompt = firstString(payload.prompt);
  const toolUseId = firstString(payload.tool_use_id, payload.toolUseId);
  const toolName = firstString(payload.tool_name, payload.toolName);
  const durationMs = firstNumber(payload.duration_ms, payload.durationMs);
  const lastAssistantMessage = firstString(payload.last_assistant_message, payload.lastAssistantMessage);

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    projectDirectory,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(payload.tool_input !== undefined ? { toolInput: payload.tool_input } : {}),
    ...(payload.toolInput !== undefined && payload.tool_input === undefined ? { toolInput: payload.toolInput } : {}),
    ...(payload.tool_response !== undefined ? { toolResponse: payload.tool_response } : {}),
    ...(payload.toolResponse !== undefined && payload.tool_response === undefined ? { toolResponse: payload.toolResponse } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(lastAssistantMessage !== undefined ? { lastAssistantMessage } : {}),
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

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Verify parser tests**

Run:

```bash
npm run build && node --test test/claude/claude-payload.test.js
```

Expected:

- All Claude parser tests pass.

- [ ] **Step 5: Commit parser**

```bash
git add src/platforms/claude/payload.ts test/claude/claude-payload.test.js
git commit -m "feat: parse claude hook payloads" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Initialize Claude Session State And Logs

**Files:**

- Create: `test/claude/claude-memory-flow.test.js`
- Modify: `src/platforms/claude/index.ts`
- Modify: `test/cli-session-start.test.js`

- [ ] **Step 1: Write SessionStart state test**

Create the first test in `test/claude/claude-memory-flow.test.js`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const claudeUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "claude", "index.js")).href;
const stateUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "session-state.js")).href;

test("initializes Claude session state on SessionStart without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const { ClaudeAdapter } = await import(claudeUrl);
    const { loadSessionState } = await import(stateUrl);
    const adapter = new ClaudeAdapter();

    const result = await adapter.startConversation({
      platform: "claude",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        source: "startup",
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const state = await loadSessionState(projectDir, "claude", "session-1");
    assert.notEqual(state, null);
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.conversationId, undefined);

    const { lines } = await readSingleSessionLog(projectDir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].harness, "claude");
    assert.equal(lines[0].event, "SessionStart");
    assert.equal(lines[0].kind, "hook.event");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

async function readSingleSessionLog(projectDir) {
  const logDir = path.join(projectDir, ".nams", "logs");
  const logFiles = (await readdir(logDir)).filter((fileName) => /^session-.*\.jsonl$/.test(fileName));
  assert.equal(logFiles.length, 1, `expected one session log file, got ${logFiles.join(", ")}`);
  const log = await readFile(path.join(logDir, logFiles[0]), "utf8");
  return {
    fileName: logFiles[0],
    log,
    lines: log
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}
```

- [ ] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/claude/claude-memory-flow.test.js
```

Expected:

- Test fails because Claude still writes the event-scoped walking-skeleton log and does not create session state.

- [ ] **Step 3: Refactor Claude adapter constructor and SessionStart**

Replace `src/platforms/claude/index.ts` with the adapter shell:

```ts
import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import type { NamsRequestEvent } from "../../generated/nams-client.js";
import { loadNamsConfig, type NamsRuntimeConfig } from "../../runtime/config.js";
import { appendPlatformLog } from "../../runtime/logging.js";
import { NamsMemoryService } from "../../runtime/memory-service.js";
import {
  createInitialSessionState,
  loadSessionState,
  saveSessionState,
  type SessionState,
} from "../../runtime/session-state.js";
import { parseClaudePayload } from "./payload.js";

export interface ClaudeAdapterOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export class ClaudeAdapter implements PlatformAdapter {
  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadOrCreateClaudeState(invocation, payloadInfo.projectDirectory, payloadInfo.sessionId);
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);
    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  private createMemoryService(
    config: NamsRuntimeConfig,
    invocation: HookInvocation,
    projectDirectory: string,
    state: SessionState,
  ): NamsMemoryService {
    return new NamsMemoryService({
      ...config,
      ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
      onRequest: (event) => appendNamsRequestLog(invocation, projectDirectory, state, event),
    });
  }
}

function allowOutput(additionalContext?: string, hookEventName?: string): HookResult {
  return {
    stdout: {
      continue: true,
      suppressOutput: true,
      ...(additionalContext !== undefined && hookEventName !== undefined
        ? {
            hookSpecificOutput: {
              hookEventName,
              additionalContext,
            },
          }
        : {}),
    },
  };
}

async function loadOrCreateClaudeState(
  invocation: HookInvocation,
  projectDirectory: string,
  sessionId: string | undefined,
): Promise<SessionState> {
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    sessionId,
    projectDirectory,
  });
  return (await loadSessionState(projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
}

async function appendRawPlatformLog(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
): Promise<void> {
  try {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      kind: "hook.event",
      payload: invocation.rawPayload,
      projectDirectory,
      sessionCreatedAt: state.createdAt,
      sessionKey: state.sessionKey,
    });
  } catch {
    // Claude hooks must not fail because observability writes failed.
  }
}

async function appendNamsRequestLog(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
  payload: NamsRequestEvent,
): Promise<void> {
  await appendPlatformLog({
    platform: invocation.platform,
    event: invocation.event,
    kind: "nams.request",
    projectDirectory,
    payload: { ...payload },
    sessionCreatedAt: state.createdAt,
    sessionKey: state.sessionKey,
  });
}
```

Remove imports that are not used by this step so TypeScript passes.

- [ ] **Step 4: Update walking-skeleton log expectation**

In `test/cli-session-start.test.js`, update the log path selection so Claude uses `singleSessionLogPath()`:

```js
const logPath =
  harness === "gemini" || harness === "claude" || harness === "codex" || harness === "opencode"
    ? await singleSessionLogPath(projectDir)
    : path.join(projectDir, ".nams", "logs", `${harness}-session-start.jsonl`);
```

- [ ] **Step 5: Verify session tests**

Run:

```bash
npm run build && node --test test/claude/claude-memory-flow.test.js test/cli-session-start.test.js
```

Expected:

- Claude `SessionStart` initializes state.
- Existing CLI session-start tests pass with the new Claude session log.

- [ ] **Step 6: Commit SessionStart flow**

```bash
git add src/platforms/claude/index.ts test/claude/claude-memory-flow.test.js test/cli-session-start.test.js
git commit -m "feat: initialize claude session state" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Implement NAMS BeforeAgent For Claude UserPromptSubmit

**Files:**

- Modify: `src/platforms/claude/index.ts`
- Modify: `test/claude/claude-memory-flow.test.js`

- [ ] **Step 1: Add BeforeAgent tests**

Append to `test/claude/claude-memory-flow.test.js`:

```js
test("creates Claude conversation, recalls memory, and stores first UserPromptSubmit prompt through BeforeAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const prompt = "Please remember that I prefer fixture-driven tests.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User prefers fixture-driven tests." }] })
      .searchEntities({
        entities: [{ name: "Fixture-driven tests", description: "User prefers fixture-driven tests." }],
      })
      .message();
    const { ClaudeAdapter } = await import(claudeUrl);
    const adapter = new ClaudeAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        hook_event_name: "UserPromptSubmit",
        cwd: projectDir,
        prompt,
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, true);
    assert.equal(result.stdout.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /User prefers fixture-driven tests\./);
    assert.equal(Object.hasOwn(result.stdout, "additionalContext"), false);
    assert.deepEqual(nams.requestBody("createConversation"), {
      metadata: {
        harness: "claude",
        projectDirectory: projectDir,
      },
    });
    assert.deepEqual(nams.requestBody("searchEntities"), {
      query: prompt,
      limit: 5,
    });
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: prompt,
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not store duplicate Claude UserPromptSubmit prompt twice through BeforeAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const prompt = "Remember this only once.";
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { ClaudeAdapter } = await import(claudeUrl);
    const adapter = new ClaudeAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });
    const invocation = {
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        hook_event_name: "UserPromptSubmit",
        cwd: projectDir,
        prompt,
      },
    };

    await adapter.beforeAgent(invocation);
    await adapter.beforeAgent(invocation);

    assert.equal(nams.calls("addMessage").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Claude UserPromptSubmit through BeforeAgent continues when NAMS_API_KEY is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const { ClaudeAdapter } = await import(claudeUrl);
    const adapter = new ClaudeAdapter({ env: {} });

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        hook_event_name: "UserPromptSubmit",
        cwd: projectDir,
        prompt: "Hello",
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /NAMS_API_KEY missing/);
    assert.doesNotMatch(log, /Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/claude/claude-memory-flow.test.js
```

Expected:

- Tests fail because `ClaudeAdapter.beforeAgent` is not implemented for Claude.

- [ ] **Step 3: Add imports and BeforeAgent method**

Add imports in `src/platforms/claude/index.ts`:

```ts
import { sha256 } from "../../runtime/hashing.js";
import { combineMemoryContexts } from "../../runtime/memory-service.js";
```

Add the method to `ClaudeAdapter`:

```ts
  async beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadOrCreateClaudeState(invocation, payloadInfo.projectDirectory, payloadInfo.sessionId);
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);

    if (payloadInfo.prompt === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const config = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    if (config === null) {
      await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    let additionalContext: string | undefined;
    try {
      const memory = this.createMemoryService(config, invocation, payloadInfo.projectDirectory, state);
      let conversationId = state.conversationId;
      if (conversationId === undefined) {
        conversationId = await memory.createConversation({
          harness: invocation.platform,
          projectDirectory: payloadInfo.projectDirectory,
        });
        state.conversationId = conversationId;
      }

      if (state.lastRecallAt === undefined) {
        const recallContexts: string[] = [];
        try {
          recallContexts.push(await memory.recall(conversationId));
        } catch {
          await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
        }
        try {
          recallContexts.push(await memory.searchEntities(payloadInfo.prompt));
        } catch {
          await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
        }
        state.lastRecallAt = new Date().toISOString();
        const recalledContext = combineMemoryContexts(recallContexts);
        if (recalledContext.trim() !== "") {
          additionalContext = recalledContext;
        }
      }

      const promptHash = sha256([invocation.platform, state.sessionKey, "user", payloadInfo.prompt.trim()].join("\n"));
      if (state.lastUserMessageHash !== promptHash) {
        await memory.storeUserMessage(conversationId, payloadInfo.prompt);
        state.lastUserMessageHash = promptHash;
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput(additionalContext, "UserPromptSubmit");
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput(additionalContext, "UserPromptSubmit");
  }
```

Add diagnostics helpers:

```ts
async function appendNamsConfigDiagnostic(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
): Promise<void> {
  await appendClaudeDiagnosticLog(invocation, projectDirectory, state, { message: "NAMS_API_KEY missing" });
}

async function appendNamsFailureDiagnostic(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
): Promise<void> {
  await appendClaudeDiagnosticLog(invocation, projectDirectory, state, { message: "NAMS request failed" });
}

async function appendClaudeDiagnosticLog(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      kind: "diagnostic",
      projectDirectory,
      payload,
      sessionCreatedAt: state.createdAt,
      sessionKey: state.sessionKey,
    });
  } catch {
    // Diagnostics are best-effort and must never block a hook response.
  }
}
```

- [ ] **Step 4: Verify BeforeAgent tests**

Run:

```bash
npm run build && node --test test/claude/claude-memory-flow.test.js
```

Expected:

- Claude `SessionStart` and NAMS `BeforeAgent` tests pass.

- [ ] **Step 5: Commit BeforeAgent flow**

```bash
git add src/platforms/claude/index.ts test/claude/claude-memory-flow.test.js
git commit -m "feat: persist claude user prompts" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Store Claude Stop Assistant Messages Through NAMS AfterAgent

**Files:**

- Modify: `src/platforms/claude/index.ts`
- Modify: `test/claude/claude-memory-flow.test.js`

- [ ] **Step 1: Add AfterAgent tests**

Append to `test/claude/claude-memory-flow.test.js`:

```js
test("stores Claude Stop last_assistant_message as an assistant message through AfterAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { ClaudeAdapter } = await import(claudeUrl);
    const adapter = new ClaudeAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        hook_event_name: "UserPromptSubmit",
        cwd: projectDir,
        prompt: "Say hello.",
      },
    });

    const result = await adapter.afterAgent({
      platform: "claude",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        hook_event_name: "Stop",
        cwd: projectDir,
        last_assistant_message: "Hello!",
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBodies("addMessage").at(-1), {
      role: "assistant",
      content: "Hello!",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not duplicate Claude Stop assistant messages through AfterAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { ClaudeAdapter } = await import(claudeUrl);
    const adapter = new ClaudeAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        hook_event_name: "UserPromptSubmit",
        cwd: projectDir,
        prompt: "Say hello.",
      },
    });
    const invocation = {
      platform: "claude",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        hook_event_name: "Stop",
        cwd: projectDir,
        last_assistant_message: "Hello!",
      },
    };

    await adapter.afterAgent(invocation);
    await adapter.afterAgent(invocation);

    const assistantMessages = nams
      .requestBodies("addMessage")
      .filter((body) => body.role === "assistant");
    assert.equal(assistantMessages.length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/claude/claude-memory-flow.test.js
```

Expected:

- AfterAgent tests fail because `ClaudeAdapter.afterAgent` is not implemented for Claude.

- [ ] **Step 3: Implement AfterAgent method**

Add to `ClaudeAdapter`:

```ts
  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadOrCreateClaudeState(invocation, payloadInfo.projectDirectory, payloadInfo.sessionId);
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);
    state.seenAssistantMessageHashes ??= [];

    if (state.conversationId === undefined || payloadInfo.lastAssistantMessage === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const config = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    if (config === null) {
      await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    try {
      const memory = this.createMemoryService(config, invocation, payloadInfo.projectDirectory, state);
      const response = payloadInfo.lastAssistantMessage.trim();
      if (response !== "") {
        const responseHash = sha256([invocation.platform, state.sessionKey, "assistant", response].join("\n"));
        if (!hasSeenAssistantMessage(state, responseHash)) {
          await memory.storeAssistantMessage(state.conversationId, response);
        }
        markAssistantMessageSeen(state, responseHash);
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput();
  }
```

Add helper types and functions:

```ts
type AssistantMessageState = {
  lastAssistantMessageHash?: string;
  seenAssistantMessageHashes: string[];
};

function hasSeenAssistantMessage(state: AssistantMessageState, messageHash: string): boolean {
  return state.lastAssistantMessageHash === messageHash || state.seenAssistantMessageHashes.includes(messageHash);
}

function markAssistantMessageSeen(state: AssistantMessageState, messageHash: string): void {
  state.lastAssistantMessageHash = messageHash;
  if (!state.seenAssistantMessageHashes.includes(messageHash)) {
    state.seenAssistantMessageHashes.push(messageHash);
  }
}
```

- [ ] **Step 4: Verify AfterAgent tests**

Run:

```bash
npm run build && node --test test/claude/claude-memory-flow.test.js
```

Expected:

- Claude assistant persistence and dedupe tests pass through NAMS `AfterAgent`.

- [ ] **Step 5: Commit AfterAgent flow**

```bash
git add src/platforms/claude/index.ts test/claude/claude-memory-flow.test.js
git commit -m "feat: persist claude assistant responses" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 6: Record Claude PostToolUse Traces Through NAMS AfterTool

**Files:**

- Modify: `src/runtime/memory-service.ts`
- Modify: `src/platforms/claude/index.ts`
- Modify: `test/claude/claude-memory-flow.test.js`
- Modify: `test/memory-service.test.js`

- [ ] **Step 1: Add memory-service output serialization tests**

Add or update tests in `test/memory-service.test.js` so the current capped behavior remains the default and Claude can opt into full explicit output:

```js
test("serializeToolOutput caps explicit output by default and supports untruncated output when requested", async () => {
  const { serializeToolOutput } = await import(serviceUrl);

  assert.equal(serializeToolOutput({ stdout: "ok" }), '{"stdout":"ok"}');
  assert.equal(serializeToolOutput("plain output"), "plain output");
  assert.equal(serializeToolOutput("x".repeat(5000)).length, 4000);
  assert.match(serializeToolOutput("x".repeat(5000)), /\.\.\.\[truncated\]$/);
  assert.equal(serializeToolOutput("x".repeat(5000), { truncate: false }).length, 5000);
});

test("recordToolCall can send untruncated explicit tool output when requested", async () => {
  const requests = [];
  const { NamsMemoryService } = await import(serviceUrl);
  const service = new NamsMemoryService({
    apiKey: "key",
    baseUrl: "https://memory.example.test",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ id: "tool-call-1" }), { status: 201 });
    },
  });

  await service.recordToolCall({
    toolName: "claude-tool",
    input: {},
    output: "x".repeat(5000),
    truncateOutput: false,
  });

  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.output.length, 5000);
});
```

- [ ] **Step 2: Add AfterTool adapter tests**

Append to `test/claude/claude-memory-flow.test.js`:

```js
test("records Claude PostToolUse payload as a reasoning step with tool output through AfterTool", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-post-tool-1" })
      .toolCall();
    const { ClaudeAdapter } = await import(claudeUrl);
    const adapter = new ClaudeAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        hook_event_name: "UserPromptSubmit",
        cwd: projectDir,
        prompt: "Run tests.",
      },
    });

    const result = await adapter.afterTool({
      platform: "claude",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        hook_event_name: "PostToolUse",
        cwd: projectDir,
        tool_use_id: "toolu_1",
        tool_name: "Bash",
        tool_input: { command: "npm test", output: "must be stripped from input" },
        tool_response: { stdout: "tests passed" },
        duration_ms: 42,
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBodies("addReasoningStep"), [
      {
        conversationId: "conversation-1",
        reasoning: "Claude Code ran Bash with the provided tool input.",
        actionTaken: "Ran Bash",
      },
    ]);

    const toolBodies = nams.requestBodies("addToolCall");
    assert.equal(toolBodies.length, 1);
    assert.equal(toolBodies[0].toolName, "Bash");
    assert.equal(toolBodies[0].stepId, "step-post-tool-1");
    assert.equal(toolBodies[0].status, "success");
    assert.equal(toolBodies[0].durationMs, 42);
    assert.equal(toolBodies[0].output, '{"stdout":"tests passed"}');
    assert.match(toolBodies[0].input, /"command":"npm test"/);
    assert.doesNotMatch(toolBodies[0].input, /must be stripped/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not duplicate Claude PostToolUse metadata for the same tool_use_id through AfterTool", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-post-tool-1" })
      .toolCall();
    const { ClaudeAdapter } = await import(claudeUrl);
    const adapter = new ClaudeAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        hook_event_name: "UserPromptSubmit",
        cwd: projectDir,
        prompt: "Run tests once.",
      },
    });

    const invocation = {
      platform: "claude",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        hook_event_name: "PostToolUse",
        cwd: projectDir,
        tool_use_id: "toolu_1",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_response: { stdout: "tests passed" },
      },
    };

    await adapter.afterTool(invocation);
    await adapter.afterTool(invocation);

    assert.equal(nams.calls("addToolCall").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Verify red**

Run:

```bash
npm run build && node --test test/memory-service.test.js test/claude/claude-memory-flow.test.js
```

Expected:

- Tests fail because `serializeToolOutput` does not yet accept the untruncated option and `ClaudeAdapter.afterTool` is not implemented for Claude.

- [ ] **Step 4: Add output serialization**

In `src/runtime/memory-service.ts`, extend `ToolCallInput`:

```ts
export interface ToolCallInput {
  stepId?: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  status?: string;
  durationMs?: number;
  truncateOutput?: boolean;
}
```

Update `recordToolCall()`:

```ts
      output: serializeToolOutput(input.output ?? "", { truncate: input.truncateOutput ?? true }),
```

Update the exported helper while preserving the existing capped default:

```ts
export function serializeToolOutput(output: unknown, options: { truncate?: boolean } = {}): string {
  const serialized = typeof output === "string" ? output : JSON.stringify(output ?? "");
  return options.truncate === false ? serialized : capSerializedToolText(serialized);
}
```

- [ ] **Step 5: Implement AfterTool method**

Add imports in `src/platforms/claude/index.ts`:

```ts
import { stableJsonHash } from "../../runtime/hashing.js";
```

Add to `ClaudeAdapter`:

```ts
  async afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadOrCreateClaudeState(invocation, payloadInfo.projectDirectory, payloadInfo.sessionId);
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);
    state.seenToolCallIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.reasoningStepIdsByHash ??= {};

    if (state.conversationId === undefined || payloadInfo.toolName === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const config = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    if (config === null) {
      await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    try {
      const toolCallKeys = claudeToolCallDedupeKeys(
        state.sessionKey,
        payloadInfo.toolUseId,
        payloadInfo.toolName,
        payloadInfo.toolInput,
      );
      if (!hasSeenAny(state.seenToolCallIds, toolCallKeys.lookupKeys)) {
        const memory = this.createMemoryService(config, invocation, payloadInfo.projectDirectory, state);
        const reasoningStep = {
          conversationId: state.conversationId,
          reasoning: `Claude Code ran ${payloadInfo.toolName} with the provided tool input.`,
          actionTaken: `Ran ${payloadInfo.toolName}`,
        };
        const reasoningStepHash = stableJsonHash({
          sessionKey: state.sessionKey,
          ...reasoningStep,
        });
        let stepId: string | undefined = state.reasoningStepIdsByHash[reasoningStepHash];
        if (!state.seenReasoningStepHashes.includes(reasoningStepHash)) {
          stepId = await memory.recordReasoningStep(reasoningStep);
          state.seenReasoningStepHashes.push(reasoningStepHash);
          if (stepId !== undefined) {
            state.reasoningStepIdsByHash[reasoningStepHash] = stepId;
          }
        }
        await memory.recordToolCall({
          ...(stepId !== undefined ? { stepId } : {}),
          toolName: payloadInfo.toolName,
          input: payloadInfo.toolInput,
          ...(payloadInfo.toolResponse !== undefined ? { output: payloadInfo.toolResponse } : {}),
          status: "success",
          ...(payloadInfo.durationMs !== undefined ? { durationMs: payloadInfo.durationMs } : {}),
          truncateOutput: false,
        });
        markSeen(state.seenToolCallIds, toolCallKeys.markKeys);
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput();
  }
```

Add helper functions:

```ts
function claudeToolCallDedupeKeys(
  sessionKey: string,
  toolUseId: string | undefined,
  toolName: string,
  input: unknown,
): { lookupKeys: string[]; markKeys: string[] } {
  const fallbackHash = stableJsonHash({ sessionKey, toolName, input });
  const fallbackKey = `fallback:${fallbackHash}`;
  const idFallbackKey = `claude-id-fallback:${fallbackHash}`;

  if (toolUseId !== undefined && toolUseId.trim() !== "") {
    const idKey = `claude-id:${stableJsonHash({ sessionKey, toolUseId })}`;
    return {
      lookupKeys: [idKey, fallbackKey, fallbackHash],
      markKeys: [idKey, idFallbackKey],
    };
  }

  return {
    lookupKeys: [fallbackKey, idFallbackKey, fallbackHash],
    markKeys: [fallbackKey, fallbackHash],
  };
}

function hasSeenAny(seen: string[], keys: string[]): boolean {
  return keys.some((key) => seen.includes(key));
}

function markSeen(seen: string[], keys: string[]): void {
  for (const key of keys) {
    if (!seen.includes(key)) {
      seen.push(key);
    }
  }
}
```

- [ ] **Step 6: Verify AfterTool tests**

Run:

```bash
npm run build && node --test test/memory-service.test.js test/claude/claude-memory-flow.test.js
```

Expected:

- Tool output serialization tests preserve the default capped behavior and pass the untruncated opt-in path for Claude output.
- Claude tool trace tests pass through NAMS `AfterTool`.

- [ ] **Step 7: Commit AfterTool flow**

```bash
git add src/runtime/memory-service.ts src/platforms/claude/index.ts test/memory-service.test.js test/claude/claude-memory-flow.test.js
git commit -m "feat: record claude tool traces" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 7: Verification And Documentation Check

**Files:**

- Modify only files changed by previous tasks.

- [ ] **Step 1: Run focused Claude tests**

Run:

```bash
npm run build && node --test test/claude/claude-payload.test.js test/claude/claude-memory-flow.test.js
```

Expected:

- All Claude-specific tests pass.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm run check
```

Expected:

- OpenAPI freshness check passes.
- TypeScript build passes.
- Full Node test suite passes.

- [ ] **Step 3: Inspect changed files**

Run:

```bash
git diff --stat
```

Expected:

- Changes are limited to Claude platform code, shared runtime helpers, Claude tests, CLI routing log expectations, and the plan/spec docs.

- [ ] **Step 4: Commit documentation if it was not committed earlier**

```bash
git add docs/superpowers/specs/2026-05-12-claude-memory-flow-design.md docs/superpowers/plans/2026-05-12-claude-memory-flow.md
git commit -m "docs: plan claude memory flow" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

## Self-Review Checklist

- [ ] The CLI still dispatches only from typed `--event`.
- [ ] `src/cli.ts` does not parse Claude payload fields.
- [ ] Claude-specific parsing stays under `src/platforms/claude/`.
- [ ] Runtime imports still flow downstream under `test/architecture.test.js`.
- [ ] Hooks never fail Claude work because NAMS is unavailable.
- [ ] Diagnostics do not include API keys, arbitrary error text, prompts, or tool output.
- [ ] Tool input is sanitized by `serializeToolInput()`.
- [ ] Existing platforms keep the default capped `serializeToolOutput()` behavior.
- [ ] Claude explicit `tool_response` is serialized without truncation by passing `truncateOutput: false`.
- [ ] No runtime npm dependency was added.
- [ ] `npm run check` passes before completion is claimed.
