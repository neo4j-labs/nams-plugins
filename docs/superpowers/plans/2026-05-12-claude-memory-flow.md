# Claude Code Memory Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking: `- [x]` for work already completed in the current branch, and `- [ ]` for remaining implementation work.

**Goal:** Build Claude Code NAMS integration parity with the implemented Gemini, Codex, and OpenCode memory flows: lazy conversation creation, first-turn recall, user and assistant message persistence, session-scoped logs, and successful tool-call trace recording.

**Architecture:** `src/cli.ts` stays a platform-agnostic typed NAMS event gateway. Claude hook templates translate native hooks to existing NAMS events (`UserPromptSubmit` -> `BeforeAgent`, `PostToolUse` -> `AfterTool`, `Stop` -> `AfterAgent`). Claude-specific payload parsing and orchestration live under `src/platforms/claude/`, while shared runtime modules continue to own JSON config loading, global runtime storage, local state, hashing, logging, and NAMS REST calls through the generated client.

**Tech Stack:** TypeScript, Node.js built-ins at runtime, generated `NamsClient`, Node's `node:test`, TypeScript-authored tests run through `tsx`, `tsconfig.test.json` for test type-checking, `fetch-mock` test support, and existing ArchUnitTS architecture checks.

---

## Scope

This plan implements the approved design in `docs/superpowers/specs/2026-05-12-claude-memory-flow-design.md`.

Current branch baseline:

- `src/platforms/claude/index.ts` already has a complete allow-only walking skeleton for `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- `templates/claude/.claude/settings.local.json` already translates Claude `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop` to the shared NAMS events.
- `test/claude-template.test.ts` and `test/cli-session-start.test.ts` already cover the current Claude template and typed-event routing.
- Gemini, Codex, and OpenCode already use session-scoped logs and stateful memory flows; Claude should converge on those runtime patterns.
- Configuration now loads from `~/.nams/config.json`, then `<project>/.nams/config.json`, then `NAMS_API_KEY` and `NAMS_BASE_URL` environment overrides. Adapters receive a structured config result and log sanitized diagnostics with source metadata.
- Runtime state and logs now live under `~/.nams/state/<platform>/` and `~/.nams/logs/<platform>/`, not under the project `.nams/` directory.

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
- `test/claude/claude-payload.test.ts`: parser tests.
- `test/claude/claude-memory-flow.test.ts`: fixture-driven Claude adapter tests.

Modify:

- `src/platforms/claude/index.ts`: replace the allow-only walking skeleton with full Claude memory flow.
- `src/runtime/memory-service.ts`: serialize explicit tool output in full while keeping sanitized tool input capped.
- `test/cli-session-start.test.ts`: update Claude log expectations when Claude moves to session-scoped logs.
- `test/memory-service.test.ts`: cover capped sanitized input plus untruncated explicit output serialization.

Do not modify:

- `src/interfaces.ts`: it keeps the existing NAMS event names.
- `src/cli.ts`: it remains a platform-agnostic NAMS event gateway.
- `templates/claude/.claude/settings.local.json`: the native-hook to NAMS-event mapping is already in place unless Claude hook configuration changes.

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
}
```

```ts
export function serializeToolOutput(output: unknown): string;
```

---

### Task 1: Map Claude Hooks To NAMS Events

Status: complete in the current branch. Keep this task as the audit trail for the already-merged walking skeleton and template work; start new implementation at Task 2.

**Files:**

- Modify: `templates/claude/.claude/settings.local.json`
- Modify: `test/cli-session-start.test.ts`
- Modify: `test/claude-template.test.ts`

- [x] **Step 1: Add Claude NAMS-event routing tests**

Append to `test/cli-session-start.test.ts`:

```ts
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
npm run test:typecheck && node --import=tsx --test test/cli-session-start.test.ts
```

Expected:

- TypeScript test type-checking passes.
- The new tests pass against the current platform-agnostic CLI because they use existing NAMS events.

- [x] **Step 3: Update Claude hook template**

Replace `templates/claude/.claude/settings.local.json` with:

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
npm run test:typecheck && node --import=tsx --test test/cli-session-start.test.ts test/claude-template.test.ts
```

Expected:

- All CLI routing tests pass.
- Claude template maps `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop` to NAMS events.

- [x] **Step 5: Commit mapping changes**

```bash
git add templates/claude/.claude/settings.local.json test/cli-session-start.test.ts test/claude-template.test.ts
git commit -m "feat: map claude hooks to nams events" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Add Claude Payload Parser

**Files:**

- Create: `src/platforms/claude/payload.ts`
- Create: `test/claude/claude-payload.test.ts`

- [x] **Step 1: Write parser tests**

Create `test/claude/claude-payload.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClaudePayload } from "../../src/platforms/claude/payload.js";

test("extracts Claude prompt and session fields", () => {
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

test("extracts Claude tool fields and numeric duration", () => {
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

test("extracts Claude stop assistant message and falls back to process cwd", () => {
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

test("ignores blank string aliases", () => {
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

- [x] **Step 2: Verify red**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/claude/claude-payload.test.ts
```

Expected:

- Build fails because `src/platforms/claude/payload.ts` does not exist.

- [x] **Step 3: Implement parser**

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

- [x] **Step 4: Verify parser tests**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/claude/claude-payload.test.ts
```

Expected:

- All Claude parser tests pass.

- [x] **Step 5: Commit parser**

```bash
git add src/platforms/claude/payload.ts test/claude/claude-payload.test.ts
git commit -m "feat: parse claude hook payloads" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Initialize Claude Session State And Logs

**Files:**

- Create: `test/claude/claude-memory-flow.test.ts`
- Modify: `src/platforms/claude/index.ts`
- Modify: `test/cli-session-start.test.ts`

- [x] **Step 1: Write SessionStart state test**

Create the first test in `test/claude/claude-memory-flow.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ClaudeAdapter } from "../../src/platforms/claude/index.js";
import { loadSessionState } from "../../src/runtime/session-state.js";
import { namsHome, readSingleSessionLog as readRuntimeSingleSessionLog } from "../support/runtime-home.js";

type TestEnvOverrides = Record<string, string | undefined>;
interface TestEnv extends TestEnvOverrides {
  HOME: string;
  USERPROFILE: string;
}

function testEnv(projectDir: string, overrides: TestEnvOverrides = {}): TestEnv {
  const env = { HOME: path.join(projectDir, "home"), USERPROFILE: path.join(projectDir, "home"), ...overrides };
  for (const key of ["HOME", "USERPROFILE", "NAMS_API_KEY", "NAMS_BASE_URL"]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  return env;
}

test("initializes Claude session state on SessionStart without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const env = testEnv(projectDir);
    const adapter = new ClaudeAdapter();

    const result = await adapter.startSession({
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
    const state = await loadSessionState("claude", "session-1");
    assert.notEqual(state, null);
    assert.equal(state?.sessionKey, "session-1");
    assert.equal(state?.conversationId, undefined);
    assert.equal((await readdir(path.join(namsHome(env.HOME), "state", "claude"))).length, 1);

    const { lines } = await readRuntimeSingleSessionLog(env.HOME, "claude");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].harness, "claude");
    assert.equal(lines[0].event, "SessionStart");
    assert.equal(lines[0].kind, "hook.event");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/claude/claude-memory-flow.test.ts
```

Expected:

- Test fails because Claude still writes the event-scoped walking-skeleton log and does not create session state.

- [x] **Step 3: Refactor Claude adapter SessionStart**

Replace `src/platforms/claude/index.ts` with the adapter shell, using the current shared runtime helpers:

```ts
import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import { appendRawPlatformLog } from "../../runtime/logging.js";
import {
  createInitialSessionState,
  loadSessionState,
  saveSessionState,
  type SessionState,
} from "../../runtime/session-state.js";
import { parseClaudePayload } from "./payload.js";

export class ClaudeAdapter implements PlatformAdapter {
  async startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadOrCreateClaudeState(invocation, payloadInfo.projectDirectory, payloadInfo.sessionId);
    await appendRawPlatformLog(invocation, state);
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
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
  return (await loadSessionState(invocation.platform, initialState.sessionKey)) ?? initialState;
}
```

Remove imports that are not used by this step so TypeScript passes.

- [x] **Step 4: Update walking-skeleton log expectation**

In `test/cli-session-start.test.ts`, update the log path selection so Claude uses the same global runtime session log helper as the implemented platforms:

```ts
const logPath = await singleSessionLogPath(homeDir, harness);
```

- [x] **Step 5: Verify session tests**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/claude/claude-memory-flow.test.ts test/cli-session-start.test.ts
```

Expected:

- Claude `SessionStart` initializes state.
- Existing CLI session-start tests pass with the new Claude session log.

- [x] **Step 6: Commit SessionStart flow**

```bash
git add src/platforms/claude/index.ts test/claude/claude-memory-flow.test.ts test/cli-session-start.test.ts
git commit -m "feat: initialize claude session state" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Implement NAMS BeforeAgent For Claude UserPromptSubmit

**Files:**

- Modify: `src/platforms/claude/index.ts`
- Modify: `test/claude/claude-memory-flow.test.ts`

- [x] **Step 1: Add BeforeAgent tests**

Append to `test/claude/claude-memory-flow.test.ts`. Also import `createNamsFetchMock` from `../support/nams-fetch-mock.js` if it is not already imported:

```ts
test("creates Claude conversation, recalls memory, and stores first UserPromptSubmit prompt through BeforeAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const prompt = "Please remember that I prefer fixture-driven tests.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User prefers fixture-driven tests." }] })
      .searchEntities({
        entities: [{ name: "Fixture-driven tests", description: "User prefers fixture-driven tests." }],
      })
      .message();
    const adapter = new ClaudeAdapter();

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
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const prompt = "Remember this only once.";
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const adapter = new ClaudeAdapter();
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
    } as const;

    await adapter.beforeAgent(invocation);
    await adapter.beforeAgent(invocation);

    assert.equal(nams.calls("addMessage").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Claude UserPromptSubmit through BeforeAgent continues when apiKey is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const env = testEnv(projectDir);
    const adapter = new ClaudeAdapter();

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
    const { lines } = await readRuntimeSingleSessionLog(env.HOME, "claude");
    assert.equal(lines.at(-1)?.payload.message, "NAMS apiKey missing");
    assert.deepEqual(lines.at(-1)?.payload.configSources, { apiKey: "missing", baseUrl: "default" });
    const log = JSON.stringify(lines);
    assert.doesNotMatch(log, /Bearer|secret|env-key|project-key|global-key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/claude/claude-memory-flow.test.ts
```

Expected:

- Tests fail because `ClaudeAdapter.beforeAgent` is not implemented for Claude.

- [x] **Step 3: Add imports and BeforeAgent method**

Add imports in `src/platforms/claude/index.ts`:

```ts
import { loadNamsConfig } from "../../runtime/config.js";
import { sha256 } from "../../runtime/hashing.js";
import { appendNamsConfigDiagnostic, appendNamsFailureDiagnostic } from "../../runtime/logging.js";
import { combineMemoryContexts, createNamsMemoryService } from "../../runtime/memory-service.js";
```

Add the method to `ClaudeAdapter`:

```ts
  async beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadOrCreateClaudeState(invocation, payloadInfo.projectDirectory, payloadInfo.sessionId);
    await appendRawPlatformLog(invocation, state);

    if (payloadInfo.prompt === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const configResult = await loadNamsConfig(payloadInfo.projectDirectory);
    await appendNamsConfigDiagnostic(invocation, state, configResult);
    if (!configResult.ok) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }
    const config = configResult.config;

    let additionalContext: string | undefined;
    try {
      const memory = createNamsMemoryService(config, invocation, state);
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
          await appendNamsFailureDiagnostic(invocation, state);
        }
        try {
          recallContexts.push(await memory.searchEntities(payloadInfo.prompt));
        } catch {
          await appendNamsFailureDiagnostic(invocation, state);
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
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput(additionalContext, "UserPromptSubmit");
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput(additionalContext, "UserPromptSubmit");
  }
```

Use the shared diagnostics helpers instead of adding Claude-local diagnostic logging functions; they already write fixed messages and sanitized config source metadata through the platform logger.

- [x] **Step 4: Verify BeforeAgent tests**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/claude/claude-memory-flow.test.ts
```

Expected:

- Claude `SessionStart` and NAMS `BeforeAgent` tests pass.

- [x] **Step 5: Commit BeforeAgent flow**

```bash
git add src/platforms/claude/index.ts test/claude/claude-memory-flow.test.ts
git commit -m "feat: persist claude user prompts" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Store Claude Stop Assistant Messages Through NAMS AfterAgent

**Files:**

- Modify: `src/platforms/claude/index.ts`
- Modify: `test/claude/claude-memory-flow.test.ts`

- [x] **Step 1: Add AfterAgent tests**

Append to `test/claude/claude-memory-flow.test.ts`:

```ts
test("stores Claude Stop last_assistant_message as an assistant message through AfterAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const adapter = new ClaudeAdapter();

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
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const adapter = new ClaudeAdapter();

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
    } as const;

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

- [x] **Step 2: Verify red**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/claude/claude-memory-flow.test.ts
```

Expected:

- AfterAgent tests fail because `ClaudeAdapter.afterAgent` is not implemented for Claude.

- [x] **Step 3: Implement AfterAgent method**

Add to `ClaudeAdapter`:

```ts
  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadOrCreateClaudeState(invocation, payloadInfo.projectDirectory, payloadInfo.sessionId);
    await appendRawPlatformLog(invocation, state);
    state.seenAssistantMessageHashes ??= [];

    if (state.conversationId === undefined || payloadInfo.lastAssistantMessage === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const configResult = await loadNamsConfig(payloadInfo.projectDirectory);
    await appendNamsConfigDiagnostic(invocation, state, configResult);
    if (!configResult.ok) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }
    const config = configResult.config;

    try {
      const memory = createNamsMemoryService(config, invocation, state);
      const response = payloadInfo.lastAssistantMessage.trim();
      if (response !== "") {
        const responseHash = sha256([invocation.platform, state.sessionKey, "assistant", response].join("\n"));
        if (!hasSeenAssistantMessage(state, responseHash)) {
          await memory.storeAssistantMessage(state.conversationId, response);
        }
        markAssistantMessageSeen(state, responseHash);
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
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

- [x] **Step 4: Verify AfterAgent tests**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/claude/claude-memory-flow.test.ts
```

Expected:

- Claude assistant persistence and dedupe tests pass through NAMS `AfterAgent`.

- [x] **Step 5: Commit AfterAgent flow**

```bash
git add src/platforms/claude/index.ts test/claude/claude-memory-flow.test.ts
git commit -m "feat: persist claude assistant responses" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 6: Record Claude PostToolUse Traces Through NAMS AfterTool

**Files:**

- Modify: `src/runtime/memory-service.ts`
- Modify: `src/platforms/claude/index.ts`
- Modify: `test/claude/claude-memory-flow.test.ts`
- Modify: `test/memory-service.test.ts`

- [x] **Step 1: Add memory-service output serialization tests**

Add `serializeToolOutput` to the `test/memory-service.test.ts` runtime import, then add or update tests so sanitized input remains capped and explicit tool output is serialized in full:

```ts
test("serializeToolOutput returns full serialized output", () => {
  assert.equal(serializeToolOutput({ stdout: "ok" }), '{"stdout":"ok"}');
  assert.equal(serializeToolOutput("plain output"), "plain output");
  assert.equal(serializeToolOutput("x".repeat(5000)).length, 5000);
});

test("recordToolCall serializes full explicit tool output", async () => {
  const requests: CapturedRequest[] = [];
  const service = createService({
    fetch: async (url, init) => {
      requests.push({ url, init: init as CapturedRequest["init"] });
      return new Response(JSON.stringify({ id: "tool-call-1" }), { status: 201 });
    },
  });

  await service.recordToolCall({
    toolName: "claude-tool",
    input: {},
    output: "x".repeat(5000),
  });

  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.output.length, 5000);
});
```

- [x] **Step 2: Add AfterTool adapter tests**

Append to `test/claude/claude-memory-flow.test.ts`:

```ts
test("records Claude PostToolUse payload as a reasoning step with tool output through AfterTool", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-post-tool-1" })
      .toolCall();
    const adapter = new ClaudeAdapter();

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
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-post-tool-1" })
      .toolCall();
    const adapter = new ClaudeAdapter();

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
    } as const;

    await adapter.afterTool(invocation);
    await adapter.afterTool(invocation);

    assert.equal(nams.calls("addToolCall").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 3: Verify red**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/memory-service.test.ts test/claude/claude-memory-flow.test.ts
```

Expected:

- Tests fail because `serializeToolOutput` does not yet accept the untruncated option and `ClaudeAdapter.afterTool` is not implemented for Claude.

- [x] **Step 4: Add output serialization**

In `src/runtime/memory-service.ts`, extend `ToolCallInput`:

```ts
export interface ToolCallInput {
  stepId?: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  status?: string;
  durationMs?: number;
}
```

Update `recordToolCall()`:

```ts
      output: serializeToolOutput(input.output ?? ""),
```

Update the exported helper so explicit output is not truncated:

```ts
export function serializeToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}
```

- [x] **Step 5: Implement AfterTool method**

Add imports in `src/platforms/claude/index.ts`:

```ts
import { stableJsonHash } from "../../runtime/hashing.js";
```

Add to `ClaudeAdapter`:

```ts
  async afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadOrCreateClaudeState(invocation, payloadInfo.projectDirectory, payloadInfo.sessionId);
    await appendRawPlatformLog(invocation, state);
    state.seenToolCallIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.reasoningStepIdsByHash ??= {};

    if (state.conversationId === undefined || payloadInfo.toolName === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const configResult = await loadNamsConfig(payloadInfo.projectDirectory);
    await appendNamsConfigDiagnostic(invocation, state, configResult);
    if (!configResult.ok) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }
    const config = configResult.config;

    try {
      const toolCallKeys = claudeToolCallDedupeKeys(
        state.sessionKey,
        payloadInfo.toolUseId,
        payloadInfo.toolName,
        payloadInfo.toolInput,
      );
      if (!hasSeenAny(state.seenToolCallIds, toolCallKeys.lookupKeys)) {
        const memory = createNamsMemoryService(config, invocation, state);
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
        });
        markSeen(state.seenToolCallIds, toolCallKeys.markKeys);
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
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

- [x] **Step 6: Verify AfterTool tests**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/memory-service.test.ts test/claude/claude-memory-flow.test.ts
```

Expected:

- Tool output serialization tests preserve capped sanitized input and pass the untruncated explicit output path.
- Claude tool trace tests pass through NAMS `AfterTool`.

- [x] **Step 7: Commit AfterTool flow**

```bash
git add src/runtime/memory-service.ts src/platforms/claude/index.ts test/memory-service.test.ts test/claude/claude-memory-flow.test.ts
git commit -m "feat: record claude tool traces" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 7: Verification And Documentation Check

**Files:**

- Modify only files changed by previous tasks.

- [x] **Step 1: Run focused Claude tests**

Run:

```bash
npm run test:typecheck && node --import=tsx --test test/claude/claude-payload.test.ts test/claude/claude-memory-flow.test.ts
```

Expected:

- All Claude-specific tests pass.

- [x] **Step 2: Run full verification**

Run:

```bash
npm run check
```

Expected:

- OpenAPI client generation passes.
- TypeScript build passes.
- TypeScript test type-checking passes.
- Full Node test suite passes through `tsx`.

- [x] **Step 3: Inspect changed files**

Run:

```bash
git diff --stat
```

Expected:

- Changes are limited to Claude platform code, shared runtime helpers, Claude tests, CLI routing log expectations, and the plan/spec docs.

- [x] **Step 4: Commit documentation if it was not committed earlier**

```bash
git add docs/superpowers/specs/2026-05-12-claude-memory-flow-design.md docs/superpowers/plans/2026-05-12-claude-memory-flow.md
git commit -m "docs: plan claude memory flow" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

## Self-Review Checklist

- [x] The CLI still dispatches only from typed `--event`.
- [x] `src/cli.ts` does not parse Claude payload fields.
- [x] Claude-specific parsing stays under `src/platforms/claude/`.
- [x] Runtime imports still flow downstream under `test/architecture.test.ts`.
- [x] Hooks never fail Claude work because NAMS is unavailable.
- [x] Diagnostics do not include API keys, arbitrary error text, prompts, or tool output.
- [x] Tool input is sanitized by `serializeToolInput()`.
- [x] Existing platforms serialize explicit tool output without truncation through `serializeToolOutput()`.
- [x] Claude explicit `tool_response` is serialized without truncation.
- [x] No runtime npm dependency was added.
- [x] `npm run check` passes before completion is claimed.
