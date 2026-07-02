# Memory-Turn Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the memory-turn policy (load-or-create session state, conversation create-or-reuse, recall-once, store-user-prompt-once) that is currently copied into all four platform adapters into one shared runtime module, so a policy change is one edit instead of four.

**Architecture:** A new `src/runtime/memory-turn.ts` exposes four small functions. Adapters keep everything genuinely platform-specific: payload parsing, hook output formatting, workspace-selection notices, transcript handling, OpenCode's pending-context two-phase injection, and per-platform dedupe keys. The runtime module imports only `interfaces.ts` and other runtime modules, satisfying the archunit rule that runtime never imports platforms. The existing per-platform memory-flow tests are the safety net — they test behavior through the adapter surface and must pass unmodified.

**Tech Stack:** TypeScript (Node built-ins only in `src/`), Node built-in test runner via tsx, fetch-mock (dev-only, via `test/support/nams-fetch-mock.ts`).

**Prerequisite:** Execute `docs/superpowers/plans/2026-07-02-architecture-test-pruning.md` first. It removes signature-regex tests that would otherwise constrain this refactor.

## Global Constraints

- Zero runtime dependencies: `src/` may import Node built-ins, `src/interfaces.ts`, other `src/runtime/` modules, and `src/generated/nams-client.ts` only.
- Archunit boundaries (enforced by `test/architecture.test.ts`): `src/runtime/**` must not import `src/platforms/**` or `src/cli.ts`; adapters must not import each other; adapters must not contain the token `fetch`.
- Behavior must be observably identical: every existing test in `test/` passes unmodified except where this plan explicitly adds tests.
- One deliberate unification: Claude's recall currently uses `Promise.all` while Gemini/Codex/OpenCode recall sequentially. The shared helper recalls sequentially (context, then entity search). Same requests, same error isolation; only concurrency changes.
- Run `npm test` from the repo root (it builds first). Per-platform test commands are given in each task.

---

### Task 1: Normalize seen-collections when loading session state

The adapters each carry `state.seenToolCallIds ??= [];`-style lines because a state file written by an older build may lack those arrays. Move that normalization into `loadSessionState` so adapters can drop the lines.

**Files:**
- Modify: `src/runtime/session-state.ts:58-81` (`loadSessionState`)
- Test: `test/session-state.test.ts`

**Interfaces:**
- Consumes: existing `loadSessionState(platform: Platform, sessionKey: string): Promise<SessionState | null>`.
- Produces: the same signature, now guaranteeing that a non-null result has `seenAssistantMessageHashes`, `seenTranscriptEntryIds`, `seenReasoningStepHashes`, `seenToolCallIds` (arrays) and `reasoningStepIdsByHash` (object) present. Tasks 3–6 rely on this guarantee. Note: the optional fields `seenUserMessageIds` and `seenAssistantPartIds` stay optional — OpenCode keeps its local `??=` for those two.

- [ ] **Step 1: Write the failing test**

Append to `test/session-state.test.ts`, following the file's existing env-juggling pattern (temp dir as `HOME`):

```ts
test("loadSessionState normalizes missing seen collections from legacy state files", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-session-state-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    const statePath = sessionStatePath("claude", "legacy-session", "2026-01-01T00:00:00.000Z");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        harness: "claude",
        sessionKey: "legacy-session",
        projectDirectory: "/tmp/project",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const state = (await loadSessionState("claude", "legacy-session"))!;

    assert.notEqual(state, null);
    assert.deepEqual(state.seenAssistantMessageHashes, []);
    assert.deepEqual(state.seenTranscriptEntryIds, []);
    assert.deepEqual(state.seenReasoningStepHashes, []);
    assert.deepEqual(state.seenToolCallIds, []);
    assert.deepEqual(state.reasoningStepIdsByHash, {});
  } finally {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousProfile;
    await rm(homeDir, { recursive: true, force: true });
  }
});
```

Add any missing imports to the top of the file: `mkdir`, `writeFile`, `mkdtemp`, `rm` from `node:fs/promises`; `tmpdir` from `node:os`; `sessionStatePath` from `../src/runtime/paths.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --import=tsx --test test/session-state.test.ts`
Expected: FAIL — `state.seenAssistantMessageHashes` is `undefined`, not `[]`.

- [ ] **Step 3: Implement normalization in `loadSessionState`**

In `src/runtime/session-state.ts`, inside `loadSessionState`, after the `lastMemorySearchAt` migration and before `return state;`:

```ts
    state.seenAssistantMessageHashes ??= [];
    state.seenTranscriptEntryIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.seenToolCallIds ??= [];
    state.reasoningStepIdsByHash ??= {};
    return state;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --import=tsx --test test/session-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/session-state.ts test/session-state.test.ts
git commit -m "feat: normalize seen collections when loading legacy session state"
```

---

### Task 2: Create the shared memory-turn runtime module

**Files:**
- Create: `src/runtime/memory-turn.ts`
- Test: `test/memory-turn.test.ts`

**Interfaces:**
- Consumes: `createInitialSessionState`, `loadSessionState`, `SessionState` from `./session-state.js`; `appendNamsFailureDiagnostic`, `appendRawPlatformLog` from `./logging.js`; `combineMemoryContexts`, `NamsMemoryService` from `./memory-service.js`; `sha256` from `./hashing.js`; `HookInvocation` from `../interfaces.js`.
- Produces (Tasks 3–6 call these exact signatures):
  - `loadHookSessionState(invocation: HookInvocation, payload: HookPayloadIdentity): Promise<SessionState>`
  - `ensureConversation(memory: NamsMemoryService, invocation: HookInvocation, state: SessionState, projectDirectory: string): Promise<string>`
  - `recallMemoryContextOnce(memory: NamsMemoryService, invocation: HookInvocation, state: SessionState, conversationId: string, prompt: string): Promise<string | undefined>`
  - `storeUserPromptOnce(memory: NamsMemoryService, invocation: HookInvocation, state: SessionState, conversationId: string, prompt: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `test/memory-turn.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HookInvocation } from "../src/interfaces.js";
import { createNamsMemoryService } from "../src/runtime/memory-service.js";
import {
  ensureConversation,
  loadHookSessionState,
  recallMemoryContextOnce,
  storeUserPromptOnce,
} from "../src/runtime/memory-turn.js";
import { createInitialSessionState, type SessionState } from "../src/runtime/session-state.js";
import { createNamsFetchMock, namsBaseUrl } from "./support/nams-fetch-mock.js";
import { readSingleSessionLog } from "./support/runtime-home.js";

const config = { apiKey: "key", workspaceId: "workspace-1", baseUrl: namsBaseUrl };

function invocation(event: "SessionStart" | "BeforeAgent" = "BeforeAgent"): HookInvocation {
  return { platform: "claude", event, rawPayload: {}, processCwd: "/tmp" };
}

function freshState(): SessionState {
  return createInitialSessionState({
    platform: "claude",
    sessionId: "session-1",
    projectDirectory: "/tmp/project",
  });
}

async function withTempHome(run: () => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-memory-turn-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    await run();
  } finally {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousProfile;
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("ensureConversation creates one conversation and reuses it", async () => {
  await withTempHome(async () => {
    const nams = createNamsFetchMock().createConversation();
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);

    const first = await ensureConversation(memory, invocation(), state, "/tmp/project");
    const second = await ensureConversation(memory, invocation(), state, "/tmp/project");

    assert.equal(first, "conversation-1");
    assert.equal(second, "conversation-1");
    assert.equal(state.conversationId, "conversation-1");
    assert.equal(nams.calls().length, 1);
  });
});

test("recallMemoryContextOnce recalls once and returns combined context", async () => {
  await withTempHome(async () => {
    const nams = createNamsFetchMock()
      .context({ observations: [{ content: "User prefers tabs." }] })
      .searchEntities({ entities: [{ name: "Tabs", description: "User prefers tabs." }] });
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);

    const context = await recallMemoryContextOnce(memory, invocation(), state, "conversation-1", "hello");

    assert.ok(context !== undefined);
    assert.match(context, /Relevant memory context:/);
    assert.match(context, /User prefers tabs\./);
    assert.ok(state.lastRecallAt !== undefined);

    const again = await recallMemoryContextOnce(memory, invocation(), state, "conversation-1", "hello");
    assert.equal(again, undefined);
    assert.equal(nams.calls().length, 2);
  });
});

test("recallMemoryContextOnce survives NAMS failures and still marks recall done", async () => {
  await withTempHome(async () => {
    createNamsFetchMock().all({ error: "unavailable" }, 500);
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);

    const context = await recallMemoryContextOnce(memory, invocation(), state, "conversation-1", "hello");

    assert.equal(context, undefined);
    assert.ok(state.lastRecallAt !== undefined);
  });
});

test("storeUserPromptOnce stores each distinct prompt once", async () => {
  await withTempHome(async () => {
    const nams = createNamsFetchMock().message();
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);

    await storeUserPromptOnce(memory, invocation(), state, "conversation-1", "hello");
    await storeUserPromptOnce(memory, invocation(), state, "conversation-1", "hello");

    assert.equal(nams.calls().length, 1);
    assert.deepEqual(nams.requestBody(), { role: "user", content: "hello" });
  });
});

test("loadHookSessionState creates initial state and logs the raw payload", async () => {
  await withTempHome(async () => {
    const hookInvocation: HookInvocation = {
      platform: "claude",
      event: "SessionStart",
      rawPayload: { session_id: "session-1" },
      processCwd: "/tmp",
    };

    const state = await loadHookSessionState(hookInvocation, {
      sessionId: "session-1",
      projectDirectory: "/tmp/project",
    });

    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.projectDirectory, "/tmp/project");
    const { lines } = await readSingleSessionLog(process.env.HOME!, "claude");
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0].payload, { session_id: "session-1" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --import=tsx --test test/memory-turn.test.ts`
Expected: FAIL — `Cannot find module '../src/runtime/memory-turn.js'`.

- [ ] **Step 3: Implement `src/runtime/memory-turn.ts`**

```ts
import type { HookInvocation } from "../interfaces.js";
import { sha256 } from "./hashing.js";
import { appendNamsFailureDiagnostic, appendRawPlatformLog } from "./logging.js";
import { combineMemoryContexts, type NamsMemoryService } from "./memory-service.js";
import { createInitialSessionState, loadSessionState, type SessionState } from "./session-state.js";

export interface HookPayloadIdentity {
  sessionId?: string;
  projectDirectory: string;
}

export async function loadHookSessionState(
  invocation: HookInvocation,
  payload: HookPayloadIdentity,
): Promise<SessionState> {
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
    projectDirectory: payload.projectDirectory,
  });
  const state =
    (await loadSessionState(invocation.platform, initialState.sessionKey)) ?? initialState;
  await appendRawPlatformLog(invocation, state);
  return state;
}

export async function ensureConversation(
  memory: NamsMemoryService,
  invocation: HookInvocation,
  state: SessionState,
  projectDirectory: string,
): Promise<string> {
  if (state.conversationId === undefined) {
    state.conversationId = await memory.createConversation({
      harness: invocation.platform,
      projectDirectory,
    });
  }
  return state.conversationId;
}

export async function recallMemoryContextOnce(
  memory: NamsMemoryService,
  invocation: HookInvocation,
  state: SessionState,
  conversationId: string,
  prompt: string,
): Promise<string | undefined> {
  if (state.lastRecallAt !== undefined) {
    return undefined;
  }
  const recallContexts: string[] = [];
  try {
    recallContexts.push(await memory.recall(conversationId));
  } catch {
    await appendNamsFailureDiagnostic(invocation, state);
  }
  try {
    recallContexts.push(await memory.searchEntities(prompt));
  } catch {
    await appendNamsFailureDiagnostic(invocation, state);
  }
  state.lastRecallAt = new Date().toISOString();
  const recalledContext = combineMemoryContexts(recallContexts);
  return recalledContext.trim() === "" ? undefined : recalledContext;
}

export async function storeUserPromptOnce(
  memory: NamsMemoryService,
  invocation: HookInvocation,
  state: SessionState,
  conversationId: string,
  prompt: string,
): Promise<void> {
  const promptHash = sha256([invocation.platform, state.sessionKey, "user", prompt.trim()].join("\n"));
  if (state.lastUserMessageHash !== promptHash) {
    await memory.storeUserMessage(conversationId, prompt);
    state.lastUserMessageHash = promptHash;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --import=tsx --test test/memory-turn.test.ts test/architecture.test.ts`
Expected: PASS (architecture tests confirm the new runtime module respects boundaries).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/memory-turn.ts test/memory-turn.test.ts
git commit -m "feat: add shared memory-turn runtime helpers"
```

---

### Task 3: Refactor the Claude adapter onto memory-turn

**Files:**
- Modify: `src/platforms/claude/index.ts`

**Interfaces:**
- Consumes: all four Task-2 functions, exact signatures above.
- Produces: `claudeMemoryAdapter` unchanged in observable behavior; `test/claude/*.test.ts` passes unmodified.

- [ ] **Step 1: Replace the import block**

Replace the imports at the top of `src/platforms/claude/index.ts` with:

```ts
import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { sha256, stableJsonHash } from "../../runtime/hashing.js";
import { hasSeenAny, markSeen } from "../dedupe.js";
import { appendNamsFailureDiagnostic } from "../../runtime/logging.js";
import { createNamsMemoryService } from "../../runtime/memory-service.js";
import {
  ensureConversation,
  loadHookSessionState,
  recallMemoryContextOnce,
  storeUserPromptOnce,
} from "../../runtime/memory-turn.js";
import { saveSessionState } from "../../runtime/session-state.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { discoverClaudeNamsConfig } from "./config.js";
import { parseClaudePayload } from "./payload.js";
```

- [ ] **Step 2: Replace `startSession` and `beforeAgent`**

```ts
async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);
    await saveSessionState(invocation.platform, state.sessionKey, state);

    return allowOutput();
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);

    if (payloadInfo.prompt === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const workspaceResult = await resolveWorkspaceForMemory({
      invocation,
      state,
      projectDirectory: payloadInfo.projectDirectory,
      discoverConfig: discoverClaudeNamsConfig,
    });
    if (workspaceResult.status !== "ready") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
    }

    let additionalContext: string | undefined;
    try {
      const memory = createNamsMemoryService(workspaceResult.config, invocation, state);
      const conversationId = await ensureConversation(memory, invocation, state, payloadInfo.projectDirectory);
      additionalContext = await recallMemoryContextOnce(memory, invocation, state, conversationId, payloadInfo.prompt);
      await storeUserPromptOnce(memory, invocation, state, conversationId, payloadInfo.prompt);
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput(additionalContext);
}
```

- [ ] **Step 3: Replace the state-loading heads of `afterAgent` and `afterTool`**

In `afterAgent`, replace:

```ts
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    state.seenAssistantMessageHashes ??= [];
    await appendRawPlatformLog(invocation, state);
```

with:

```ts
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);
```

In `afterTool`, replace:

```ts
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    await appendRawPlatformLog(invocation, state);
    state.seenToolCallIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.reasoningStepIdsByHash ??= {};
```

with:

```ts
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);
```

Everything below those heads (config load, hashing, dedupe, try/catch, saves) stays exactly as it is.

- [ ] **Step 4: Run the Claude tests and full typecheck**

Run: `npm run build && npm run test:typecheck && node --import=tsx --test test/claude/*.test.ts test/claude-template.test.ts test/cli-session-start.test.ts`
Expected: PASS with no test modifications.

- [ ] **Step 5: Commit**

```bash
git add src/platforms/claude/index.ts
git commit -m "refactor: claude adapter uses shared memory-turn helpers"
```

---

### Task 4: Refactor the Gemini adapter onto memory-turn

**Files:**
- Modify: `src/platforms/gemini/index.ts`

**Interfaces:**
- Consumes: Task-2 functions. Gemini keeps: `recordActiveGeminiWorkspaceSession`, `isWorkspaceCommandResultPrompt`, transcript processing, `geminiToolCallDedupeKeys`.
- Produces: `geminiMemoryAdapter` unchanged in observable behavior; `test/gemini/*.test.ts` passes unmodified.

- [ ] **Step 1: Update the import block**

Remove `createInitialSessionState`, `loadSessionState`, `appendRawPlatformLog`, and `combineMemoryContexts` from the imports; add the memory-turn imports. The resulting import block:

```ts
import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { sha256, stableJsonHash } from "../../runtime/hashing.js";
import { recordActiveWorkspaceSession } from "../../runtime/active-workspace-session.js";
import { firstDefined, firstRecord, firstString } from "../../runtime/util.js";
import { hasSeenAny, hasSeenAssistantMessage, markAssistantMessageSeen, markSeen, type AssistantMessageState } from "../dedupe.js";
import { pickStringFields } from "../payload.js";
import { appendNamsFailureDiagnostic } from "../../runtime/logging.js";
import { createNamsMemoryService, type NamsMemoryService } from "../../runtime/memory-service.js";
import {
  ensureConversation,
  loadHookSessionState,
  recallMemoryContextOnce,
  storeUserPromptOnce,
} from "../../runtime/memory-turn.js";
import { sessionStatePath } from "../../runtime/paths.js";
import { saveSessionState, type SessionState } from "../../runtime/session-state.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { parseGeminiPayload } from "./payload.js";
import { readGeminiTranscript, type GeminiTranscriptEntry } from "./transcript.js";
```

- [ ] **Step 2: Replace `startSession` and `beforeAgent`**

```ts
async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);
    await saveSessionState(invocation.platform, state.sessionKey, state);
    await recordActiveGeminiWorkspaceSession(
      invocation,
      state,
      payloadInfo.projectDirectory,
      payloadInfo.sessionId,
    );

    return { stdout: { continue: true, suppressOutput: true } };
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);

    if (payloadInfo.prompt === undefined || isWorkspaceCommandResultPrompt(payloadInfo.prompt)) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const workspaceResult = await resolveWorkspaceForMemory({
      invocation,
      state,
      projectDirectory: payloadInfo.projectDirectory,
    });
    if (workspaceResult.status !== "ready") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      if (workspaceResult.reason === "selection-required") {
        await recordActiveGeminiWorkspaceSession(
          invocation,
          state,
          payloadInfo.projectDirectory,
          payloadInfo.sessionId,
        );
      }
      return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
    }

    let additionalContext: string | undefined;
    try {
      const memory = createNamsMemoryService(workspaceResult.config, invocation, state);
      const conversationId = await ensureConversation(memory, invocation, state, payloadInfo.projectDirectory);
      additionalContext = await recallMemoryContextOnce(memory, invocation, state, conversationId, payloadInfo.prompt);
      await storeUserPromptOnce(memory, invocation, state, conversationId, payloadInfo.prompt);
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput(additionalContext);
}
```

- [ ] **Step 3: Replace the state-loading heads of `afterAgent` and `afterTool`**

In `afterAgent`, replace the block from `const initialState = createInitialSessionState({` down to and including `state.reasoningStepIdsByHash ??= {};` (keeping the `parseGeminiPayload` line above it) with:

```ts
    const state = await loadHookSessionState(invocation, payloadInfo);
```

In `afterTool`, do the same: replace from `const initialState = createInitialSessionState({` down to and including `state.reasoningStepIdsByHash ??= {};` with:

```ts
    const state = await loadHookSessionState(invocation, payloadInfo);
```

Transcript helpers (`storeAssistantMessagesFromTranscript`, `recordTraceFromTranscript`, `geminiToolCallDedupeKeys`, `parseGeminiAfterToolPayload`, etc.) stay unchanged.

- [ ] **Step 4: Run the Gemini tests**

Run: `npm run build && npm run test:typecheck && node --import=tsx --test test/gemini/*.test.ts test/gemini-template.test.ts`
Expected: PASS with no test modifications.

- [ ] **Step 5: Commit**

```bash
git add src/platforms/gemini/index.ts
git commit -m "refactor: gemini adapter uses shared memory-turn helpers"
```

---

### Task 5: Refactor the Codex adapter onto memory-turn

**Files:**
- Modify: `src/platforms/codex/index.ts`

**Interfaces:**
- Consumes: Task-2 functions. Codex keeps: `isWorkspaceSkillPrompt`, `recordSelectionRequiredWorkspaceSession`, transcript processing, `codexToolCallId`/`codexReasoningStepHash` dedupe, `allowPostToolUseOutput`.
- Produces: `codexMemoryAdapter` unchanged in observable behavior; `test/codex/*.test.ts` passes unmodified.

- [ ] **Step 1: Update the import block**

Remove `createInitialSessionState`, `loadSessionState`, `appendRawPlatformLog`, and `combineMemoryContexts`; add:

```ts
import {
  ensureConversation,
  loadHookSessionState,
  recallMemoryContextOnce,
  storeUserPromptOnce,
} from "../../runtime/memory-turn.js";
```

Keep the remaining imports as they are (including `serializeToolInput`, `sessionStatePath`, `recordActiveWorkspaceSession`, dedupe helpers).

- [ ] **Step 2: Replace `startSession` and `beforeAgent`**

```ts
async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);
    await saveSessionState(invocation.platform, state.sessionKey, state);

    return { stdout: { continue: true, suppressOutput: true } };
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);

    if (payloadInfo.prompt === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }
    if (isWorkspaceSkillPrompt(payloadInfo.prompt)) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      await recordSelectionRequiredWorkspaceSession(
        invocation,
        state,
        payloadInfo.projectDirectory,
        payloadInfo.sessionId,
      );
      return allowOutput();
    }

    const workspaceResult = await resolveWorkspaceForMemory({
      invocation,
      state,
      projectDirectory: payloadInfo.projectDirectory,
    });
    if (workspaceResult.status !== "ready") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      if (workspaceResult.reason === "selection-required") {
        await recordSelectionRequiredWorkspaceSession(
          invocation,
          state,
          payloadInfo.projectDirectory,
          payloadInfo.sessionId,
        );
      }
      return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
    }

    let additionalContext: string | undefined;
    try {
      const memory = createNamsMemoryService(workspaceResult.config, invocation, state);
      const conversationId = await ensureConversation(memory, invocation, state, payloadInfo.projectDirectory);
      additionalContext = await recallMemoryContextOnce(memory, invocation, state, conversationId, payloadInfo.prompt);
      await storeUserPromptOnce(memory, invocation, state, conversationId, payloadInfo.prompt);
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput(additionalContext);
}
```

- [ ] **Step 3: Replace the state-loading heads of `afterAgent` and `afterTool`**

In both functions, replace the block from `const initialState = createInitialSessionState({` down to the last `state.… ??= …;` line (keeping the `parseCodexPayload` line above it) with:

```ts
    const state = await loadHookSessionState(invocation, payloadInfo);
```

Everything else in both functions — transcript reading, `assistantMessageDedupeHash`, dedupe key helpers, `allowPostToolUseOutput` — stays unchanged.

- [ ] **Step 4: Run the Codex tests**

Run: `npm run build && npm run test:typecheck && node --import=tsx --test test/codex/*.test.ts test/codex-template.test.ts`
Expected: PASS with no test modifications.

- [ ] **Step 5: Commit**

```bash
git add src/platforms/codex/index.ts
git commit -m "refactor: codex adapter uses shared memory-turn helpers"
```

---

### Task 6: Refactor the OpenCode adapter onto memory-turn

OpenCode is the one adapter with genuinely different policy pieces: it routes on `payloadInfo.hookName`, stores recalled context into `state.pendingMemoryContext` (consumed later by `experimental.chat.system.transform`) instead of returning it, and dedupes user messages by `messageId` when present. Those stay. Only the state loading, conversation creation, and recall-once move to the shared helpers.

**Files:**
- Modify: `src/platforms/opencode/index.ts`

**Interfaces:**
- Consumes: `loadHookSessionState`, `ensureConversation`, `recallMemoryContextOnce` (not `storeUserPromptOnce` — OpenCode keeps `hasSeenUserMessage`/`markUserMessageSeen`).
- Produces: `opencodeMemoryAdapter` unchanged in observable behavior; `test/opencode/*.test.ts` passes unmodified.

- [ ] **Step 1: Update the import block**

Remove `createInitialSessionState`, `loadSessionState`, `appendRawPlatformLog`, and `combineMemoryContexts`; add:

```ts
import {
  ensureConversation,
  loadHookSessionState,
  recallMemoryContextOnce,
} from "../../runtime/memory-turn.js";
```

- [ ] **Step 2: Replace `startSession` and the memory core of `beforeAgent`**

```ts
async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);
    await saveSessionState(invocation.platform, state.sessionKey, state);

    return allowOutput();
}
```

In `beforeAgent`, keep the `hookName` routing at the top exactly as it is, then replace the state-loading block (from `const initialState = createInitialSessionState({` through `state.seenUserMessageIds ??= [];`) with:

```ts
    const state = await loadHookSessionState(invocation, payloadInfo);
    state.seenUserMessageIds ??= [];
```

Then delete the now-unused line `const config = workspaceResult.config;` after the workspace-result check, and replace the `try` block body (conversation creation, recall-once, pending-context, user-message store) with:

```ts
    try {
      const memory = createNamsMemoryService(workspaceResult.config, invocation, state);
      const conversationId = await ensureConversation(memory, invocation, state, payloadInfo.projectDirectory);

      const recalledContext = await recallMemoryContextOnce(memory, invocation, state, conversationId, userPrompt);
      if (recalledContext !== undefined) {
        state.pendingMemoryContext = {
          ...(payloadInfo.messageId !== undefined ? { messageId: payloadInfo.messageId } : {}),
          content: recalledContext,
          createdAt: state.lastRecallAt ?? new Date().toISOString(),
        };
      }

      if (hasSeenUserMessage(state, payloadInfo.messageId, invocation.platform, userPrompt)) {
        await saveSessionState(invocation.platform, state.sessionKey, state);
        return allowOutput();
      }

      await memory.storeUserMessage(conversationId, userPrompt);
      markUserMessageSeen(state, payloadInfo.messageId, invocation.platform, userPrompt);
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }
```

- [ ] **Step 3: Replace the state-loading heads of `afterAgent`, `afterTool`, and `consumePendingContext`**

In `afterAgent`, replace from `const initialState = createInitialSessionState({` through `state.seenAssistantMessageHashes ??= [];` with:

```ts
    const state = await loadHookSessionState(invocation, payloadInfo);
    state.seenAssistantPartIds ??= [];
```

In `afterTool`, replace from `const initialState = createInitialSessionState({` through `state.reasoningStepIdsByHash ??= {};` with:

```ts
    const state = await loadHookSessionState(invocation, payloadInfo);
```

In `consumePendingContext`, replace from `const initialState = createInitialSessionState({` through `await appendRawPlatformLog(invocation, state);` with:

```ts
  const state = await loadHookSessionState(invocation, payloadInfo);
```

`hasSeenUserMessage`, `markUserMessageSeen`, `assistantPartKey`, `assistantMessageHash`, `opencodeToolCallDedupeKey` stay unchanged.

- [ ] **Step 4: Run the OpenCode tests**

Run: `npm run build && npm run test:typecheck && node --import=tsx --test test/opencode/*.test.ts test/opencode-template.test.ts`
Expected: PASS with no test modifications.

- [ ] **Step 5: Commit**

```bash
git add src/platforms/opencode/index.ts
git commit -m "refactor: opencode adapter uses shared memory-turn helpers"
```

---

### Task 7: Full verification

**Files:**
- No new changes; verification only.

- [ ] **Step 1: Run the complete check**

Run: `npm run check`
Expected: OpenAPI freshness, build, typecheck, and all tests PASS.

- [ ] **Step 2: Verify the duplication actually shrank**

Run: `wc -l src/platforms/claude/index.ts src/platforms/gemini/index.ts src/platforms/codex/index.ts src/platforms/opencode/index.ts`
Expected: each adapter meaningfully smaller than before (baseline: claude 315, gemini 499, codex 489, opencode 381). If any adapter did not shrink, a state-loading block was missed — grep for `createInitialSessionState` under `src/platforms/`; it must have zero hits.

- [ ] **Step 3: Verify the generated artifacts still build**

Run: `npm run package:check`
Expected: PASS — `dist/`, `dist-marketplace/`, and `dist-local/` all verify. The new `runtime/memory-turn.js` must appear in `dist/bin/runtime/`.

- [ ] **Step 4: Commit any generated-artifact metadata updates and finish**

```bash
git status --short
git add -A
git commit -m "chore: verify dist projections after memory-turn extraction" --allow-empty
```
