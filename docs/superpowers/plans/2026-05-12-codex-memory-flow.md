# Codex Memory Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Codex NAMS memory flow parity with the current Gemini implementation: map Codex `UserPromptSubmit` to NAMS `BeforeAgent`, map Codex `Stop` to NAMS `AfterAgent`, map Codex `PostToolUse` to NAMS `AfterTool`, and preserve `src/interfaces.ts` as the platform-agnostic NAMS event contract.

**Architecture:** `src/cli.ts` remains the platform-agnostic typed-event gateway for `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`. Codex-specific hook-name translation, payload parsing, and transcript parsing live under `src/platforms/codex/` and `templates/codex/hooks.json`. Shared runtime modules continue to own config, session state, logging, hashing, and NAMS REST calls through the generated client.

**Tech Stack:** TypeScript, Node.js built-ins, Node's `node:test`, generated `NamsClient`, existing `fetch-mock` test support, and existing ArchUnitTS architecture tests.

---

## Scope

This plan implements Phases 1 through 3 from `docs/superpowers/specs/2026-05-12-codex-memory-flow-design.md`.

Included:

- Existing NAMS hook events in shared typed interfaces.
- Codex `SessionStart`, `UserPromptSubmit`, `Stop`, and `PostToolUse` template entries that invoke generic NAMS events.
- Codex payload parser.
- Conservative Codex transcript fallback reader.
- Codex session-scoped logs and state.
- NAMS conversation creation on first prompt only.
- User prompt persistence with duplicate suppression.
- First-response recall and Codex additional context injection.
- Assistant persistence from Codex `Stop.last_assistant_message`, with transcript fallback through NAMS `AfterAgent`.
- Tool metadata persistence from Codex `PostToolUse` through NAMS `AfterTool`.
- Non-blocking/sanitized failure behavior.

Deferred:

- Installer and doctor commands.
- Codex `PreToolUse`, `PermissionRequest`, `PreCompact`, and `PostCompact`.
- Live Codex CLI/Desktop validation as an automated gate.

## File Structure

Create:

- `src/platforms/codex/payload.ts`: parse Codex hook payload fields.
- `src/platforms/codex/transcript.ts`: read conservative assistant/user candidates from Codex rollout JSONL.
- `test/codex/codex-payload.test.js`: parser coverage.
- `test/codex/codex-transcript.test.js`: transcript fallback coverage.
- `test/codex/codex-memory-flow.test.js`: mocked NAMS flow tests.

Modify:

- `src/platforms/codex/index.ts`: implement memory flow.
- `src/runtime/memory-service.ts`: add safe tool-output serialization if needed.
- `templates/codex/hooks.json`: add Codex memory hooks using current command-hook shape.
- `test/cli-session-start.test.js`: add routing tests showing Codex uses generic NAMS events and ignores payload hook names for routing.
- `test/memory-service.test.js`: add tool-output capping coverage if `memory-service.ts` changes.

## Public APIs Introduced

Use these names across tasks:

```ts
export type CodexPayloadInfo = {
  sessionId?: string;
  turnId?: string;
  projectDirectory: string;
  transcriptPath?: string;
  hookEventName?: string;
  source?: string;
  model?: string;
  permissionMode?: string;
  prompt?: string;
  lastAssistantMessage?: string;
  stopHookActive?: boolean;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
};

export type CodexTranscriptEntry =
  | { kind: "user"; id?: string; content: string }
  | { kind: "assistant"; id?: string; content: string };
```

---

### Task 1: Keep NAMS Events And Map Codex Hooks

**Files:**

- Modify: `test/cli-session-start.test.js`
- Modify: `templates/codex/hooks.json`

- [x] **Step 1: Add routing tests**

Append tests that prove Codex uses generic NAMS events and does not route from payload `hook_event_name`:

```js
const codexHookToNamsEvent = [
  ["UserPromptSubmit", "BeforeAgent"],
  ["Stop", "AfterAgent"],
  ["PostToolUse", "AfterTool"],
];

for (const [codexHook, namsEvent] of codexHookToNamsEvent) {
  test(`routes codex ${codexHook} through NAMS ${namsEvent}`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const result = await runCliWithEvent("codex", namsEvent, {
        session_id: `codex-${codexHook}`,
        hook_event_name: codexHook,
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

Also add one negative test that a native Codex hook name is not a valid `--event`:

```js
test("rejects Codex native hook names as NAMS events", async () => {
  const result = await runCli(["run", "codex", "--event", "UserPromptSubmit"], {});
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Invalid hook event/);
});
```

- [x] **Step 2: Verify generic routing behavior**

Run:

```bash
npm run build && node --test test/cli-session-start.test.js
```

Expected: generic Codex event routing passes and native Codex hook names are rejected as `--event` values.

- [x] **Step 3: Preserve the working Codex hook template and extend it**

Before adding memory events, make sure `templates/codex/hooks.json` uses the known-working walking-skeleton shape:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run codex --event SessionStart",
            "statusMessage": "Loading session notes"
          }
        ]
      }
    ]
  }
}
```

Then extend that shape for new Codex memory events. Do not reintroduce the stale short-form object that contains only `command` under `SessionStart`.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run codex --event SessionStart",
            "statusMessage": "Loading session notes"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run codex --event BeforeAgent",
            "statusMessage": "NAMS memory recall"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run codex --event AfterAgent",
            "statusMessage": "NAMS assistant persistence"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run codex --event AfterTool",
            "statusMessage": "NAMS tool metadata"
          }
        ]
      }
    ]
  }
}
```

- [x] **Step 4: Verify green and commit**

Run:

```bash
npm run check
```

Commit:

```bash
git add templates/codex/hooks.json test/cli-session-start.test.js
git commit -m "feat: map codex hooks to nams events" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Parse Codex Hook Payloads

**Files:**

- Create: `src/platforms/codex/payload.ts`
- Create: `test/codex/codex-payload.test.js`

- [x] **Step 1: Write failing parser tests**

Create tests covering the current Codex input fields:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const payloadUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "codex", "payload.js")).href;

test("extracts Codex common and prompt fields", async () => {
  const { parseCodexPayload } = await import(payloadUrl);
  const info = parseCodexPayload({
    session_id: "thread-1",
    turn_id: "turn-1",
    transcript_path: "/tmp/rollout.jsonl",
    cwd: "/tmp/project",
    model: "gpt-test",
    permission_mode: "default",
    hook_event_name: "UserPromptSubmit",
    prompt: "Remember this.",
  }, "/fallback");

  assert.deepEqual(info, {
    sessionId: "thread-1",
    turnId: "turn-1",
    transcriptPath: "/tmp/rollout.jsonl",
    projectDirectory: "/tmp/project",
    hookEventName: "UserPromptSubmit",
    model: "gpt-test",
    permissionMode: "default",
    prompt: "Remember this.",
  });
});

test("extracts Codex stop and post-tool fields", async () => {
  const { parseCodexPayload } = await import(payloadUrl);
  const info = parseCodexPayload({
    session_id: "thread-1",
    turn_id: "turn-2",
    cwd: "/tmp/project",
    last_assistant_message: "Done.",
    stop_hook_active: false,
    tool_name: "Bash",
    tool_use_id: "call-1",
    tool_input: { command: "echo hi" },
    tool_response: "hi",
  }, "/fallback");

  assert.equal(info.lastAssistantMessage, "Done.");
  assert.equal(info.stopHookActive, false);
  assert.equal(info.toolName, "Bash");
  assert.equal(info.toolUseId, "call-1");
  assert.deepEqual(info.toolInput, { command: "echo hi" });
  assert.equal(info.toolResponse, "hi");
});

test("falls back to process cwd and ignores blank strings", async () => {
  const { parseCodexPayload } = await import(payloadUrl);
  assert.deepEqual(parseCodexPayload({ cwd: " ", session_id: "" }, "/fallback"), {
    projectDirectory: "/fallback",
  });
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/codex/codex-payload.test.js
```

Expected: fails because `src/platforms/codex/payload.ts` does not exist.

- [x] **Step 3: Implement parser**

Create `src/platforms/codex/payload.ts`:

```ts
export interface CodexPayloadInfo {
  sessionId?: string;
  turnId?: string;
  projectDirectory: string;
  transcriptPath?: string;
  hookEventName?: string;
  source?: string;
  model?: string;
  permissionMode?: string;
  prompt?: string;
  lastAssistantMessage?: string;
  stopHookActive?: boolean;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
}

export function parseCodexPayload(payload: Record<string, unknown>, processCwd: string): CodexPayloadInfo {
  const sessionId = firstString(payload.session_id, payload.sessionId);
  const turnId = firstString(payload.turn_id, payload.turnId);
  const projectDirectory = firstString(payload.cwd) ?? processCwd;
  const transcriptPath = firstString(payload.transcript_path, payload.transcriptPath);
  const hookEventName = firstString(payload.hook_event_name, payload.hookEventName);
  const source = firstString(payload.source);
  const model = firstString(payload.model);
  const permissionMode = firstString(payload.permission_mode, payload.permissionMode);
  const prompt = firstString(payload.prompt);
  const lastAssistantMessage = firstString(payload.last_assistant_message, payload.lastAssistantMessage);
  const stopHookActive = typeof payload.stop_hook_active === "boolean" ? payload.stop_hook_active : undefined;
  const toolName = firstString(payload.tool_name, payload.toolName);
  const toolUseId = firstString(payload.tool_use_id, payload.toolUseId);
  const toolInput = firstDefined(payload.tool_input, payload.toolInput);
  const toolResponse = firstDefined(payload.tool_response, payload.toolResponse);

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    projectDirectory,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(hookEventName !== undefined ? { hookEventName } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(lastAssistantMessage !== undefined ? { lastAssistantMessage } : {}),
    ...(stopHookActive !== undefined ? { stopHookActive } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(toolResponse !== undefined ? { toolResponse } : {}),
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

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}
```

- [x] **Step 4: Verify green and commit**

Run:

```bash
npm run check
```

Commit:

```bash
git add src/platforms/codex/payload.ts test/codex/codex-payload.test.js
git commit -m "feat: parse codex hook payloads" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Add Conservative Codex Transcript Reader

**Files:**

- Create: `src/platforms/codex/transcript.ts`
- Create: `test/codex/codex-transcript.test.js`

- [x] **Step 1: Write failing transcript tests**

Create `test/codex/codex-transcript.test.js` with fixtures that reflect Codex rollout message shapes and a nested fallback:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const transcriptUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "codex", "transcript.js")).href;

test("reads user and assistant messages from Codex rollout JSONL", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nams-codex-transcript-"));
  try {
    const transcript = path.join(dir, "rollout.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ item: { type: "response_item", item: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "Hi" }] } } }),
      JSON.stringify({ item: { type: "response_item", item: { type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "Hello" }] } } }),
      JSON.stringify({ item: { type: "compacted", message: "summary" } }),
      "",
    ].join("\n"));

    const { readCodexTranscript } = await import(transcriptUrl);
    assert.deepEqual(await readCodexTranscript(transcript), [
      { kind: "user", id: "u1", content: "Hi" },
      { kind: "assistant", id: "a1", content: "Hello" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/codex/codex-transcript.test.js
```

Expected: fails because `src/platforms/codex/transcript.ts` does not exist.

- [x] **Step 3: Implement transcript reader**

Create `src/platforms/codex/transcript.ts`:

```ts
import { readFile } from "node:fs/promises";

export type CodexTranscriptEntry =
  | { kind: "user"; id?: string; content: string }
  | { kind: "assistant"; id?: string; content: string };

export async function readCodexTranscript(transcriptPath: string): Promise<CodexTranscriptEntry[]> {
  const content = await readFile(transcriptPath, "utf8");
  const entries: CodexTranscriptEntry[] = [];

  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    const raw = JSON.parse(line) as Record<string, unknown>;
    const candidate = responseItem(raw);
    if (candidate !== undefined) {
      entries.push(...messageEntries(candidate));
    }
  }

  return entries;
}

function responseItem(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = record(raw.item);
  if (item?.type === "response_item") {
    return record(item.item);
  }
  if (raw.type === "response_item") {
    return record(raw.item);
  }
  return undefined;
}

function messageEntries(item: Record<string, unknown> | undefined): CodexTranscriptEntry[] {
  if (item?.type !== "message") {
    return [];
  }
  const role = item.role;
  if (role !== "user" && role !== "assistant") {
    return [];
  }
  const content = textContent(item.content).trim();
  if (content === "") {
    return [];
  }
  return [{
    kind: role,
    ...(typeof item.id === "string" && item.id.trim() !== "" ? { id: item.id } : {}),
    content,
  }];
}

function textContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      const candidate = record(part);
      return typeof candidate?.text === "string" ? candidate.text : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
```

- [x] **Step 4: Verify green and commit**

Run:

```bash
npm run check
```

Commit:

```bash
git add src/platforms/codex/transcript.ts test/codex/codex-transcript.test.js
git commit -m "feat: read codex rollout transcript messages" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Implement Codex User Prompt Memory Flow

**Files:**

- Modify: `src/platforms/codex/index.ts`
- Create: `test/codex/codex-memory-flow.test.js`

- [x] **Step 1: Write failing core flow tests**

Create tests matching Gemini's flow style:

```js
test("initializes Codex session state on SessionStart without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const { CodexAdapter } = await import(codexUrl);
    const { loadSessionState } = await import(stateUrl);
    const adapter = new CodexAdapter();

    const result = await adapter.startConversation({
      platform: "codex",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: { session_id: "session-1", cwd: projectDir, source: "startup" },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const state = await loadSessionState(projectDir, "codex", "session-1");
    assert.notEqual(state, null);
    assert.equal(state.conversationId, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("creates Codex conversation, recalls memory, and stores UserPromptSubmit prompt on BeforeAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const prompt = "Please remember that Codex should use NAMS.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "Codex should use NAMS." }] })
      .searchEntities({ entities: [{ name: "NAMS", description: "Codex memory integration target." }] })
      .message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: namsBaseUrl },
      fetch: nams.fetch,
    });

    const result = await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: projectDir,
        hook_event_name: "UserPromptSubmit",
        prompt,
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, true);
    assert.equal(result.stdout.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Codex should use NAMS/);
    assert.deepEqual(nams.requestBody("addMessage"), { role: "user", content: prompt });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/codex/codex-memory-flow.test.js
```

Expected: fails because `CodexAdapter` has no `beforeAgent` memory implementation.

- [x] **Step 3: Implement `SessionStart` state and NAMS `BeforeAgent` from Codex `UserPromptSubmit`**

In `src/platforms/codex/index.ts`, mirror the Gemini structure with Codex parser imports:

```ts
import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import type { NamsRequestEvent } from "../../generated/nams-client.js";
import { loadNamsConfig, type NamsRuntimeConfig } from "../../runtime/config.js";
import { sha256 } from "../../runtime/hashing.js";
import { appendPlatformLog } from "../../runtime/logging.js";
import { combineMemoryContexts, NamsMemoryService } from "../../runtime/memory-service.js";
import { createInitialSessionState, loadSessionState, saveSessionState, type SessionState } from "../../runtime/session-state.js";
import { parseCodexPayload } from "./payload.js";
```

Add `CodexAdapterOptions`, a constructor, `createMemoryService`, `appendRawPlatformLog`, sanitized diagnostics, and an allow-output helper:

```ts
function allowOutput(eventName?: "UserPromptSubmit", additionalContext?: string): HookResult {
  return {
    stdout: {
      continue: true,
      suppressOutput: true,
      ...(eventName !== undefined && additionalContext !== undefined
        ? { hookSpecificOutput: { hookEventName: eventName, additionalContext } }
        : {}),
    },
  };
}
```

Implement `beforeAgent` with this order:

1. Parse payload.
2. Load or create state.
3. Append raw platform log.
4. Return allow output if `prompt` is missing.
5. Load config, logging `NAMS_API_KEY missing` and allowing when absent.
6. Create conversation if missing.
7. If `lastRecallAt` is absent, call `memory.recall(conversationId)` and `memory.searchEntities(prompt)` independently, then combine contexts.
8. Hash and persist the prompt if new.
9. Save state and return Codex `UserPromptSubmit` additional context when present. Even though the NAMS event is `BeforeAgent`, Codex hook output must use `hookSpecificOutput.hookEventName: "UserPromptSubmit"` because that is the native hook that consumes `additionalContext`.

- [x] **Step 4: Add duplicate and failure tests**

Add tests:

- duplicate NAMS `BeforeAgent` from Codex `UserPromptSubmit` stores one user message.
- missing `NAMS_API_KEY` returns allow output and sanitized log.
- NAMS recall failure still stores prompt when message endpoint works.
- NAMS message failure returns recalled additional context.

Use Gemini tests as the local reference, changing the invocation event to `BeforeAgent`, the payload `hook_event_name` to `UserPromptSubmit`, and the expected `hookSpecificOutput.hookEventName` to `UserPromptSubmit`.

- [x] **Step 5: Verify green and commit**

Run:

```bash
npm run check
```

Commit:

```bash
git add src/platforms/codex/index.ts test/codex/codex-memory-flow.test.js
git commit -m "feat: persist codex user prompts" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Persist Codex Assistant Responses

**Files:**

- Modify: `src/platforms/codex/index.ts`
- Modify: `test/codex/codex-memory-flow.test.js`

- [x] **Step 1: Write failing assistant persistence tests**

Add tests:

```js
test("stores Codex Stop last_assistant_message as an assistant message on AfterAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: namsBaseUrl },
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: projectDir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Hello",
      },
    });
    await adapter.afterAgent({
      platform: "codex",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: projectDir,
        hook_event_name: "Stop",
        last_assistant_message: "Assistant reply.",
      },
    });

    assert.deepEqual(nams.requestBodies("addMessage").at(-1), {
      role: "assistant",
      content: "Assistant reply.",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Add transcript fallback test**

Add a test where NAMS `AfterAgent` from Codex `Stop` has no `last_assistant_message`, `transcript_path` points to a fixture with one assistant entry, and the adapter stores that assistant message once.

- [x] **Step 3: Verify red**

Run:

```bash
npm run build && node --test test/codex/codex-memory-flow.test.js
```

Expected: fails because `afterAgent` is not implemented for Codex assistant persistence.

- [x] **Step 4: Implement `afterAgent`**

In `src/platforms/codex/index.ts`:

```ts
async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
  const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    sessionId: payloadInfo.sessionId,
    projectDirectory: payloadInfo.projectDirectory,
  });
  const state = (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
  await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);

  if (state.conversationId === undefined) {
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
    const response = payloadInfo.lastAssistantMessage?.trim();
    if (response !== undefined && response !== "") {
      await storeAssistantMessageIfNew(invocation.platform, state, memory, state.conversationId, response);
    } else if (payloadInfo.transcriptPath !== undefined) {
      const entries = await readCodexTranscript(payloadInfo.transcriptPath);
      await storeAssistantMessagesFromTranscript(invocation.platform, state, memory, state.conversationId, entries);
    }
  } catch {
    await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
  }

  await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
  return allowOutput();
}
```

Add small local helpers equivalent to Gemini's assistant hash helpers. Do not import from Gemini.

- [x] **Step 5: Add dedupe and failure tests**

Add tests:

- repeated NAMS `AfterAgent` from Codex `Stop` with the same `last_assistant_message` stores once.
- transcript fallback does not duplicate an entry id.
- missing config and failed NAMS calls allow Codex to continue.

- [x] **Step 6: Verify green and commit**

Run:

```bash
npm run check
```

Commit:

```bash
git add src/platforms/codex/index.ts test/codex/codex-memory-flow.test.js
git commit -m "feat: persist codex assistant responses" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 6: Record Codex Tool Metadata

**Files:**

- Modify: `src/platforms/codex/index.ts`
- Modify: `src/runtime/memory-service.ts`
- Modify: `test/memory-service.test.js`
- Modify: `test/codex/codex-memory-flow.test.js`

- [x] **Step 1: Add tool-output serialization test**

If `NamsMemoryService` does not already cap tool output, add a test in `test/memory-service.test.js`:

```js
test("recordToolCall caps exposed tool output", async () => {
  const longOutput = "x".repeat(5000);
  const nams = createNamsFetchMock().toolCall();
  const { NamsMemoryService } = await import(memoryServiceUrl);
  const memory = new NamsMemoryService({
    apiKey: "key",
    baseUrl: namsBaseUrl,
    fetch: nams.fetch,
  });

  await memory.recordToolCall({
    toolName: "Bash",
    input: { command: "echo hi" },
    output: longOutput,
  });

  const body = nams.requestBody("addToolCall");
  assert.equal(body.output.endsWith("...[truncated]"), true);
  assert.equal(body.output.length, 4000);
});
```

- [x] **Step 2: Implement safe output serialization**

In `src/runtime/memory-service.ts`, add:

```ts
export function serializeToolOutput(output: unknown): string {
  const serialized = typeof output === "string" ? output : JSON.stringify(output ?? "");
  if (serialized.length <= 4000) {
    return serialized;
  }
  const suffix = "...[truncated]";
  return `${serialized.slice(0, 4000 - suffix.length)}${suffix}`;
}
```

Then change `recordToolCall`:

```ts
output: serializeToolOutput(input.output ?? ""),
```

- [x] **Step 3: Write failing Codex PostToolUse test through NAMS AfterTool**

Add a test:

```js
test("records Codex PostToolUse as reasoning step and tool call on AfterTool", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-1" })
      .toolCall();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: namsBaseUrl },
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: projectDir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Run a tool",
      },
    });
    await adapter.afterTool({
      platform: "codex",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: projectDir,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "call-1",
        tool_input: { command: "echo hi", result: "must be stripped" },
        tool_response: "hi",
      },
    });

    assert.deepEqual(nams.requestBody("addReasoningStep"), {
      conversationId: "conversation-1",
      reasoning: "Codex ran Bash for the current turn.",
      actionTaken: "Ran Bash",
      result: "Codex exposed post-tool output.",
    });
    assert.deepEqual(nams.requestBody("addToolCall"), {
      stepId: "step-1",
      toolName: "Bash",
      input: "{\"command\":\"echo hi\"}",
      output: "hi",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 4: Verify red**

Run:

```bash
npm run build && node --test test/memory-service.test.js test/codex/codex-memory-flow.test.js
```

Expected: fails because output capping and Codex `afterTool` metadata persistence are not implemented.

- [x] **Step 5: Implement `afterTool`**

In `src/platforms/codex/index.ts`:

```ts
async afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
  const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    sessionId: payloadInfo.sessionId,
    projectDirectory: payloadInfo.projectDirectory,
  });
  const state = (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
  await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);

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
    const keys = codexToolCallDedupeKeys(state.sessionKey, payloadInfo.turnId, payloadInfo.toolUseId, payloadInfo.toolName, payloadInfo.toolInput);
    if (!hasSeenAny(state.seenToolCallIds, keys.lookupKeys)) {
      const memory = this.createMemoryService(config, invocation, payloadInfo.projectDirectory, state);
      const stepId = await memory.recordReasoningStep({
        conversationId: state.conversationId,
        reasoning: `Codex ran ${payloadInfo.toolName} for the current turn.`,
        actionTaken: `Ran ${payloadInfo.toolName}`,
        ...(payloadInfo.toolResponse !== undefined ? { result: "Codex exposed post-tool output." } : {}),
      });
      await memory.recordToolCall({
        ...(stepId !== undefined ? { stepId } : {}),
        toolName: payloadInfo.toolName,
        input: payloadInfo.toolInput ?? {},
        ...(payloadInfo.toolResponse !== undefined ? { output: serializeCodexToolResponse(payloadInfo.toolResponse) } : {}),
      });
      markSeen(state.seenToolCallIds, keys.markKeys);
    }
  } catch {
    await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
  }

  await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
  return allowOutput();
}
```

Implement `codexToolCallDedupeKeys`, `hasSeenAny`, `markSeen`, and `serializeCodexToolResponse` locally. `serializeCodexToolResponse` should return strings unchanged and JSON-stringify non-strings.

- [x] **Step 6: Add dedupe/failure tests**

Add tests:

- repeated NAMS `AfterTool` from Codex `PostToolUse` with the same `tool_use_id` records one tool call.
- NAMS `AfterTool` from Codex `PostToolUse` without `tool_use_id` deduplicates by fallback hash.
- missing config and failed NAMS calls allow Codex to continue.
- raw hook payload and NAMS request logs do not contain `Authorization`, `Bearer`, or the test API key.

- [x] **Step 7: Verify green and commit**

Run:

```bash
npm run check
```

Commit:

```bash
git add src/platforms/codex/index.ts src/runtime/memory-service.ts test/memory-service.test.js test/codex/codex-memory-flow.test.js
git commit -m "feat: record codex tool metadata" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 7: Distribution And Final Verification

**Files:**

- Modify only if checks reveal omissions:
  - `scripts/build-dist.mjs`
  - `scripts/check-dist.mjs`

- [x] **Step 1: Run package verification**

Run:

```bash
npm run package:check
```

Expected:

- `npm run check` passes.
- `npm run dist` creates a distribution tree.
- `npm run dist:check` passes.
- Generated `dist/bin/platforms/codex/` includes `index.js`, `payload.js`, and `transcript.js`.

- [x] **Step 2: Inspect dist if verification fails**

If Codex files are missing from `dist/`, update `scripts/build-dist.mjs` using the existing platform copy pattern. Do not hand-edit `dist/`.

- [x] **Step 3: Run targeted smoke command**

After `npm run build`, run:

```bash
printf '{"session_id":"manual","turn_id":"turn-1","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"Remember Codex smoke test."}\n' "$PWD" | node .build/tsc/cli.js run codex --event BeforeAgent
```

Expected without `NAMS_API_KEY`:

```json
{"continue":true,"suppressOutput":true}
```

Also verify `.nams/logs/` is not created under the repository worktree by this smoke test. If it is created, remove it from the worktree before committing and adjust the smoke command to use an OS temp project directory.

- [x] **Step 4: Final commit**

If Task 7 required changes:

```bash
git add scripts/build-dist.mjs scripts/check-dist.mjs
git commit -m "fix: include codex memory flow in dist" -m "Co-authored-by: Codex <codex@openai.com>"
```

Otherwise no commit is needed for this task.

---

## Self-Review Checklist

- [x] Every spec requirement maps to a task.
- [x] No Codex platform module imports Gemini platform modules.
- [x] `src/cli.ts` still ignores platform payload fields for routing.
- [x] Tests use OS temp directories and clean them up.
- [x] No runtime npm dependency was added.
- [x] No `.nams/`, `dist/`, or generated local artifacts are committed from `devel`.
- [x] `npm run check` passes.
- [x] `npm run package:check` passes or the exact blocker is documented.
