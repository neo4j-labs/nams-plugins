# Memory-Turn Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish what `2026-07-02-memory-turn-extraction.md` started: move the store-assistant-message-once and record-tool-call-once turn policies (currently copied at six call sites across the four adapters) into `src/runtime/memory-turn.ts`, and add a `withHookSessionState` bracket that owns the load-state → run → save-state cycle so the 61 repeated `await saveSessionState(...); return ...;` pairs disappear.

**Architecture:** `src/runtime/memory-turn.ts` gains three functions (`withHookSessionState`, `storeAssistantMessageOnce`, `recordToolCallOnce`) plus one hash helper (`assistantContentHash`). Adapters keep everything genuinely platform-specific: payload parsing, hook output formatting, workspace-selection notices, dedupe **key shapes** (Gemini's asymmetric keys are pinned by `test/gemini/gemini-dedupe-keys.test.ts`), Gemini's transcript thought/parent-step trace, OpenCode's pending-context two-phase injection and message-id user dedupe. Because runtime modules must not import `src/platforms/**`, the dedupe helpers move from `src/platforms/dedupe.ts` to `src/runtime/dedupe.ts` first. The per-platform memory-flow tests are the safety net — they test behavior through the adapter surface and must pass unmodified.

**Tech Stack:** TypeScript (Node built-ins only in `src/`), Node built-in test runner via tsx, fetch-mock (dev-only, via `test/support/nams-fetch-mock.ts`).

## Global Constraints

- Zero runtime dependencies: `src/` may import Node built-ins, `src/interfaces.ts`, other `src/runtime/` modules, and `src/generated/nams-client.ts` only.
- Archunit boundaries (enforced by `test/architecture.test.ts`): `src/runtime/**` must not import `src/platforms/**` or `src/cli.ts`; adapters must not import each other; adapter `index.ts` files must not contain the token `fetch`; adapters must not define their own `append...Log`/`append...Diagnostic` functions.
- Behavior must be observably identical over the wire (same NAMS requests, same hook stdout): every existing test in `test/` passes unmodified except where this plan explicitly adds tests.
- Dedupe key shapes do not change. `geminiToolCallDedupeKeys`, `claudeToolCallDedupeKeys`, `codexToolCallId`, `codexReasoningStepHash`, `codexTranscriptToolCallId`, `codexTranscriptReasoningStepHash`, `opencodeToolCallDedupeKey` keep their exact output strings (state files outlive upgrades).
- Run `npm test` from the repo root (it builds first). Per-platform test commands are given in each task.

## Deliberate Unifications

These are the only intended observable differences. None change wire traffic or hook stdout; the first two change local file write behavior only.

1. **Save ordering:** session state is now saved once, after the hook body finishes (previously each early return saved first, and Gemini/Codex saved *before* writing the active-workspace-session marker; now the marker is written first). Safe because `recordActiveWorkspaceSession` (src/runtime/active-workspace-session.ts:57) only stores the state-file *path string* — it never reads the state file.
2. **Save on unexpected throw:** `withHookSessionState` saves state in `finally`, so a throw that escapes a hook body persists state before propagating (previously it skipped the save). Strictly more durable.
3. **OpenCode assistant fallback marking:** the hash-based fallback path now marks dedupe hashes even when the message was already seen (matches Claude/Gemini/Codex, which already mark unconditionally). Dedupe outcome is identical; the state file may additionally record `lastAssistantMessageHash` on a duplicate arrival.
4. **afterTool gate placement (all platforms):** the tool-call dedupe gate moves inside the shared helper, so `createNamsMemoryService` is constructed even for duplicate tool calls (previously each adapter constructed it inside the gate). Construction is pure object wiring (src/runtime/memory-service.ts:88-101) — no I/O happens until a method is called.

---

### Task 1: Move dedupe helpers into runtime

`src/runtime/memory-turn.ts` will need `hasSeenAny`, `markSeen`, `hasSeenAssistantMessage`, `markAssistantMessageSeen`, and the `AssistantMessageState` type — but archunit forbids runtime importing `src/platforms/dedupe.ts`. Move the file. It imports nothing, so the move is mechanical.

**Files:**
- Move: `src/platforms/dedupe.ts` → `src/runtime/dedupe.ts` (content unchanged)
- Modify: `src/platforms/claude/index.ts:3`, `src/platforms/gemini/index.ts:5`, `src/platforms/codex/index.ts:3`, `src/platforms/opencode/index.ts:2` (import specifier only)
- Modify: `test/gemini/gemini-dedupe-keys.test.ts:3` (import specifier only)

**Interfaces:**
- Consumes: nothing new.
- Produces: `src/runtime/dedupe.ts` exporting exactly what `src/platforms/dedupe.ts` exported: `AssistantMessageState`, `hasSeenAny(seen: string[], keys: string[]): boolean`, `markSeen(seen: string[], keys: string[]): void`, `hasSeenAssistantMessage(state: AssistantMessageState, hash: string): boolean`, `markAssistantMessageSeen(state: AssistantMessageState, hashes: string[]): void`. Tasks 2–8 import from `./dedupe.js` (runtime) or `../../runtime/dedupe.js` (adapters).

- [x] **Step 1: Move the file**

```bash
git mv src/platforms/dedupe.ts src/runtime/dedupe.ts
```

- [x] **Step 2: Update the five import sites**

In each of the four adapter files, change:

```ts
from "../dedupe.js"
```

to:

```ts
from "../../runtime/dedupe.js"
```

(Claude imports `hasSeenAny, markSeen`; Gemini imports `hasSeenAny, hasSeenAssistantMessage, markAssistantMessageSeen, markSeen, type AssistantMessageState`; Codex imports `hasSeenAssistantMessage, markAssistantMessageSeen`; OpenCode imports `hasSeenAssistantMessage, markAssistantMessageSeen, markSeen`. Keep each list as-is — only the specifier changes.)

In `test/gemini/gemini-dedupe-keys.test.ts`, change:

```ts
import { hasSeenAny, markSeen } from "../../src/platforms/dedupe.js";
```

to:

```ts
import { hasSeenAny, markSeen } from "../../src/runtime/dedupe.js";
```

- [x] **Step 3: Verify nothing else references the old path**

Run: `rg -n "platforms/dedupe" src test scripts templates`
Expected: no matches.

- [x] **Step 4: Run the full check**

Run: `npm run build && npm run test:typecheck && npm test`
Expected: PASS — the move is pinned by existing tests plus `test/architecture.test.ts`.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move dedupe helpers into runtime"
```

---

### Task 2: Add withHookSessionState to the memory-turn runtime

**Files:**
- Modify: `src/runtime/memory-turn.ts`
- Test: `test/memory-turn.test.ts`

**Interfaces:**
- Consumes: `loadHookSessionState` (same file), `saveSessionState` from `./session-state.js`, `HookResult` from `../interfaces.js`.
- Produces (Tasks 5–8 call this exact signature):
  - `withHookSessionState(invocation: HookInvocation, payload: HookPayloadIdentity, run: (state: SessionState) => Promise<HookResult>): Promise<HookResult>` — loads state (logging the raw payload, as `loadHookSessionState` already does), runs the body, saves state in `finally`, returns the body's result, rethrows the body's exceptions.

- [x] **Step 1: Write the failing tests**

Append to `test/memory-turn.test.ts`. Add `withHookSessionState` to the existing `memory-turn.js` import block and `loadSessionState` to the existing `session-state.js` import block (which currently imports `createInitialSessionState` and `type SessionState`):

```ts
test("withHookSessionState persists state mutations after the run", async () => {
  await withTempHome(async () => {
    const result = await withHookSessionState(
      invocation("SessionStart"),
      { sessionId: "session-1", projectDirectory: "/tmp/project" },
      async (state) => {
        state.conversationId = "conversation-9";
        return { stdout: { continue: true, suppressOutput: true } };
      },
    );

    assert.deepEqual(result, { stdout: { continue: true, suppressOutput: true } });
    const reloaded = await loadSessionState("claude", "session-1");
    assert.equal(reloaded?.conversationId, "conversation-9");
  });
});

test("withHookSessionState persists state even when the run throws", async () => {
  await withTempHome(async () => {
    await assert.rejects(
      withHookSessionState(
        invocation("BeforeAgent"),
        { sessionId: "session-1", projectDirectory: "/tmp/project" },
        async (state) => {
          state.conversationId = "conversation-9";
          throw new Error("boom");
        },
      ),
      /boom/,
    );

    const reloaded = await loadSessionState("claude", "session-1");
    assert.equal(reloaded?.conversationId, "conversation-9");
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --import=tsx --test test/memory-turn.test.ts`
Expected: FAIL — `withHookSessionState` is not exported.

- [x] **Step 3: Implement `withHookSessionState`**

In `src/runtime/memory-turn.ts`, change the imports:

```ts
import type { HookInvocation, HookResult } from "../interfaces.js";
```

and:

```ts
import {
  createInitialSessionState,
  loadSessionState,
  saveSessionState,
  type SessionState,
} from "./session-state.js";
```

Then add below `loadHookSessionState`:

```ts
export async function withHookSessionState(
  invocation: HookInvocation,
  payload: HookPayloadIdentity,
  run: (state: SessionState) => Promise<HookResult>,
): Promise<HookResult> {
  const state = await loadHookSessionState(invocation, payload);
  try {
    return await run(state);
  } finally {
    await saveSessionState(invocation.platform, state.sessionKey, state);
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm run build && npm run test:typecheck && node --import=tsx --test test/memory-turn.test.ts test/architecture.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/runtime/memory-turn.ts test/memory-turn.test.ts
git commit -m "feat: add withHookSessionState bracket to memory-turn runtime"
```

---

### Task 3: Add storeAssistantMessageOnce and assistantContentHash

**Files:**
- Modify: `src/runtime/memory-turn.ts`
- Test: `test/memory-turn.test.ts`

**Interfaces:**
- Consumes: `hasSeenAssistantMessage`, `markAssistantMessageSeen`, `type AssistantMessageState` from `./dedupe.js` (Task 1); `sha256` from `./hashing.js` (already imported).
- Produces (Tasks 5–8 call these exact signatures):
  - `assistantContentHash(platform: string, sessionKey: string, content: string): string` — the shared `sha256([platform, sessionKey, "assistant", content].join("\n"))` shape used today by Claude (claude/index.ts:90), Gemini (gemini/index.ts:101, 345), Codex (codex/index.ts:360), and OpenCode (opencode/index.ts:302).
  - `interface AssistantMessageKeys { lookupHash: string; markHashes: string[] }`
  - `storeAssistantMessageOnce(memory: NamsMemoryService, state: AssistantMessageState, conversationId: string, content: string, keys: AssistantMessageKeys): Promise<void>` — stores when `lookupHash` is unseen, then marks all `markHashes`; marks are skipped when the store throws (exception propagates).

- [x] **Step 1: Write the failing tests**

Append to `test/memory-turn.test.ts` (add `assistantContentHash` and `storeAssistantMessageOnce` to the `memory-turn.js` import block):

```ts
test("storeAssistantMessageOnce stores unseen content and marks all hashes", async () => {
  await withTempHome(async () => {
    const nams = createNamsFetchMock().message();
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);
    const hash = assistantContentHash("claude", state.sessionKey, "answer");

    await storeAssistantMessageOnce(memory, state, "conversation-1", "answer", {
      lookupHash: hash,
      markHashes: [hash, "extra-hash"],
    });
    await storeAssistantMessageOnce(memory, state, "conversation-1", "answer", {
      lookupHash: hash,
      markHashes: [hash, "extra-hash"],
    });

    assert.equal(nams.calls().length, 1);
    assert.deepEqual(nams.requestBody(), { role: "assistant", content: "answer" });
    assert.equal(state.lastAssistantMessageHash, hash);
    assert.deepEqual(state.seenAssistantMessageHashes, [hash, "extra-hash"]);
  });
});

test("storeAssistantMessageOnce does not mark hashes when the store fails", async () => {
  await withTempHome(async () => {
    createNamsFetchMock().all({ error: "unavailable" }, 500);
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);
    const hash = assistantContentHash("claude", state.sessionKey, "answer");

    await assert.rejects(
      storeAssistantMessageOnce(memory, state, "conversation-1", "answer", {
        lookupHash: hash,
        markHashes: [hash],
      }),
    );

    assert.equal(state.lastAssistantMessageHash, undefined);
    assert.deepEqual(state.seenAssistantMessageHashes, []);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --import=tsx --test test/memory-turn.test.ts`
Expected: FAIL — `assistantContentHash` / `storeAssistantMessageOnce` are not exported.

- [x] **Step 3: Implement both exports**

In `src/runtime/memory-turn.ts`, add the import:

```ts
import {
  hasSeenAssistantMessage,
  markAssistantMessageSeen,
  type AssistantMessageState,
} from "./dedupe.js";
```

Then add:

```ts
export interface AssistantMessageKeys {
  lookupHash: string;
  markHashes: string[];
}

export function assistantContentHash(platform: string, sessionKey: string, content: string): string {
  return sha256([platform, sessionKey, "assistant", content].join("\n"));
}

export async function storeAssistantMessageOnce(
  memory: NamsMemoryService,
  state: AssistantMessageState,
  conversationId: string,
  content: string,
  keys: AssistantMessageKeys,
): Promise<void> {
  if (!hasSeenAssistantMessage(state, keys.lookupHash)) {
    await memory.storeAssistantMessage(conversationId, content);
  }
  markAssistantMessageSeen(state, keys.markHashes);
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm run build && npm run test:typecheck && node --import=tsx --test test/memory-turn.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/runtime/memory-turn.ts test/memory-turn.test.ts
git commit -m "feat: add shared storeAssistantMessageOnce turn policy"
```

---

### Task 4: Add recordToolCallOnce

**Files:**
- Modify: `src/runtime/memory-turn.ts`
- Test: `test/memory-turn.test.ts`

**Interfaces:**
- Consumes: `hasSeenAny`, `markSeen` from `./dedupe.js`; `type ReasoningStepInput`, `type ToolCallInput` from `./memory-service.js` (both are exported there, memory-service.ts:13-27).
- Produces (Tasks 5–8 call these exact signatures):
  - `interface ToolCallDedupeKeys { lookupKeys: string[]; markKeys: string[] }`
  - `interface ToolCallTraceState { seenToolCallIds: string[]; seenReasoningStepHashes: string[]; reasoningStepIdsByHash: Record<string, string> }` (structurally satisfied by `SessionState` and by the adapters' narrow transcript-state types)
  - `recordToolCallOnce(memory: NamsMemoryService, state: ToolCallTraceState, keys: ToolCallDedupeKeys, reasoningStep: ReasoningStepInput, reasoningStepHash: string, toolCall: Omit<ToolCallInput, "stepId">): Promise<void>` — returns early when any `lookupKey` was seen; records the reasoning step once per `reasoningStepHash` (reusing the remembered `stepId` otherwise); records the tool call; marks `markKeys` last, so a failed record is retried on the next hook.

- [x] **Step 1: Write the failing tests**

Append to `test/memory-turn.test.ts` (add `recordToolCallOnce` to the `memory-turn.js` import block):

```ts
const reasoningStep = { conversationId: "conversation-1", reasoning: "why", actionTaken: "Ran read" };

test("recordToolCallOnce records the step and tool call once per key", async () => {
  await withTempHome(async () => {
    const nams = createNamsFetchMock().reasoningStep().toolCall();
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);
    const keys = { lookupKeys: ["key-1"], markKeys: ["key-1"] };

    await recordToolCallOnce(memory, state, keys, reasoningStep, "hash-1", { toolName: "read", input: { path: "a" } });
    await recordToolCallOnce(memory, state, keys, reasoningStep, "hash-1", { toolName: "read", input: { path: "a" } });

    assert.equal(nams.calls("addReasoningStep").length, 1);
    assert.equal(nams.calls("addToolCall").length, 1);
    assert.deepEqual(state.seenToolCallIds, ["key-1"]);
    assert.deepEqual(state.reasoningStepIdsByHash, { "hash-1": "step-1" });
    assert.equal(nams.requestBody("addToolCall").stepId, "step-1");
  });
});

test("recordToolCallOnce reuses a seen reasoning step for a new tool call", async () => {
  await withTempHome(async () => {
    const nams = createNamsFetchMock().reasoningStep().toolCall();
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);

    await recordToolCallOnce(
      memory, state,
      { lookupKeys: ["key-1"], markKeys: ["key-1"] },
      reasoningStep, "hash-1",
      { toolName: "read", input: { path: "a" } },
    );
    await recordToolCallOnce(
      memory, state,
      { lookupKeys: ["key-2"], markKeys: ["key-2"] },
      reasoningStep, "hash-1",
      { toolName: "read", input: { path: "b" } },
    );

    assert.equal(nams.calls("addReasoningStep").length, 1);
    assert.equal(nams.calls("addToolCall").length, 2);
    assert.equal(nams.requestBodies("addToolCall").at(1).stepId, "step-1");
  });
});

test("recordToolCallOnce leaves the tool call unmarked when recording fails", async () => {
  await withTempHome(async () => {
    createNamsFetchMock().reasoningStep().toolCall({ error: "unavailable" }, 500);
    const state = freshState();
    const memory = createNamsMemoryService(config, invocation(), state);

    await assert.rejects(
      recordToolCallOnce(
        memory, state,
        { lookupKeys: ["key-1"], markKeys: ["key-1"] },
        reasoningStep, "hash-1",
        { toolName: "read", input: {} },
      ),
    );

    assert.deepEqual(state.seenToolCallIds, []);
    assert.deepEqual(state.seenReasoningStepHashes, ["hash-1"]);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --import=tsx --test test/memory-turn.test.ts`
Expected: FAIL — `recordToolCallOnce` is not exported.

- [x] **Step 3: Implement `recordToolCallOnce`**

In `src/runtime/memory-turn.ts`, extend the dedupe import with `hasSeenAny, markSeen` and the memory-service import with the two types:

```ts
import {
  hasSeenAny,
  hasSeenAssistantMessage,
  markAssistantMessageSeen,
  markSeen,
  type AssistantMessageState,
} from "./dedupe.js";
import {
  combineMemoryContexts,
  type NamsMemoryService,
  type ReasoningStepInput,
  type ToolCallInput,
} from "./memory-service.js";
```

Then add:

```ts
export interface ToolCallDedupeKeys {
  lookupKeys: string[];
  markKeys: string[];
}

export interface ToolCallTraceState {
  seenToolCallIds: string[];
  seenReasoningStepHashes: string[];
  reasoningStepIdsByHash: Record<string, string>;
}

export async function recordToolCallOnce(
  memory: NamsMemoryService,
  state: ToolCallTraceState,
  keys: ToolCallDedupeKeys,
  reasoningStep: ReasoningStepInput,
  reasoningStepHash: string,
  toolCall: Omit<ToolCallInput, "stepId">,
): Promise<void> {
  if (hasSeenAny(state.seenToolCallIds, keys.lookupKeys)) {
    return;
  }
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
    ...toolCall,
  });
  markSeen(state.seenToolCallIds, keys.markKeys);
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm run build && npm run test:typecheck && node --import=tsx --test test/memory-turn.test.ts test/architecture.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/runtime/memory-turn.ts test/memory-turn.test.ts
git commit -m "feat: add shared recordToolCallOnce turn policy"
```

---

### Task 5: Refactor the Claude adapter

**Files:**
- Modify: `src/platforms/claude/index.ts`

**Interfaces:**
- Consumes: `withHookSessionState`, `assistantContentHash`, `storeAssistantMessageOnce`, `recordToolCallOnce` plus the existing `ensureConversation`, `recallMemoryContextOnce`, `storeUserPromptOnce` — exact signatures from Tasks 2–4.
- Produces: `claudeMemoryAdapter` unchanged in observable behavior; `test/claude/*.test.ts` passes unmodified. `claudeToolCallDedupeKeys`, `allowOutput`, `workspaceResultOutput` stay exactly as they are.

- [x] **Step 1: Replace the import block**

```ts
import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { stableJsonHash } from "../../runtime/hashing.js";
import { appendNamsFailureDiagnostic } from "../../runtime/logging.js";
import { createNamsMemoryService } from "../../runtime/memory-service.js";
import {
  assistantContentHash,
  ensureConversation,
  recallMemoryContextOnce,
  recordToolCallOnce,
  storeAssistantMessageOnce,
  storeUserPromptOnce,
  withHookSessionState,
} from "../../runtime/memory-turn.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { discoverClaudeNamsConfig } from "./config.js";
import { parseClaudePayload } from "./payload.js";
```

(`sha256`, `hasSeenAny`, `markSeen`, `loadHookSessionState`, and `saveSessionState` are no longer used here.)

- [x] **Step 2: Replace the four hook functions**

```ts
async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async () => allowOutput());
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      if (payloadInfo.prompt === undefined) {
        return allowOutput();
      }

      const workspaceResult = await resolveWorkspaceForMemory({
        invocation,
        state,
        projectDirectory: payloadInfo.projectDirectory,
        discoverConfig: discoverClaudeNamsConfig,
      });
      if (workspaceResult.status !== "ready") {
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

      return allowOutput(additionalContext);
    });
}

async function afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      if (state.conversationId === undefined) {
        return allowOutput();
      }

      const response = payloadInfo.lastAssistantMessage?.trim();
      if (response === undefined || response === "") {
        return allowOutput();
      }

      const config = await loadEffectiveNamsConfigForMemory(
        invocation,
        state,
        payloadInfo.projectDirectory,
        discoverClaudeNamsConfig,
      );
      if (config === undefined) {
        return allowOutput();
      }

      try {
        const memory = createNamsMemoryService(config, invocation, state);
        const responseHash = assistantContentHash(invocation.platform, state.sessionKey, response);
        await storeAssistantMessageOnce(memory, state, state.conversationId, response, {
          lookupHash: responseHash,
          markHashes: [responseHash],
        });
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowOutput();
    });
}

async function afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      if (state.conversationId === undefined || payloadInfo.toolName === undefined) {
        return allowOutput();
      }

      const config = await loadEffectiveNamsConfigForMemory(
        invocation,
        state,
        payloadInfo.projectDirectory,
        discoverClaudeNamsConfig,
      );
      if (config === undefined) {
        return allowOutput();
      }

      try {
        const memory = createNamsMemoryService(config, invocation, state);
        const reasoningStep = {
          conversationId: state.conversationId,
          reasoning: `Claude Code ran ${payloadInfo.toolName} with the provided tool input.`,
          actionTaken: `Ran ${payloadInfo.toolName}`,
        };
        await recordToolCallOnce(
          memory,
          state,
          claudeToolCallDedupeKeys(state.sessionKey, payloadInfo.toolUseId, payloadInfo.toolName, payloadInfo.toolInput),
          reasoningStep,
          stableJsonHash({ sessionKey: state.sessionKey, ...reasoningStep }),
          {
            toolName: payloadInfo.toolName,
            input: payloadInfo.toolInput,
            ...(payloadInfo.toolResponse !== undefined ? { output: payloadInfo.toolResponse } : {}),
            status: "success",
            ...(payloadInfo.durationMs !== undefined ? { durationMs: payloadInfo.durationMs } : {}),
          },
        );
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowOutput();
    });
}
```

`claudeToolCallDedupeKeys`, `allowOutput`, `workspaceResultOutput`, and the `claudeMemoryAdapter` export stay exactly as they are.

- [x] **Step 3: Run the Claude tests and full typecheck**

Run: `npm run build && npm run test:typecheck && node --import=tsx --test test/claude/*.test.ts test/claude-template.test.ts test/cli-session-start.test.ts test/architecture.test.ts`
Expected: PASS with no test modifications.

- [x] **Step 4: Commit**

```bash
git add src/platforms/claude/index.ts
git commit -m "refactor: claude adapter uses shared turn policies and state bracket"
```

---

### Task 6: Refactor the Gemini adapter

Gemini keeps: `recordActiveGeminiWorkspaceSession`, `isWorkspaceCommandResultPrompt`, `geminiToolCallDedupeKeys` (pinned key shapes — do not touch), `parseGeminiAfterToolPayload`, and the entire `recordTraceFromTranscript` thought/parent-step trace (its policy differs from the shared one: reasoning steps come from separate `thought` entries and tool calls attach to accumulated parent step ids). Only `storeAssistantMessagesFromTranscript` adopts `storeAssistantMessageOnce`.

**Files:**
- Modify: `src/platforms/gemini/index.ts`

**Interfaces:**
- Consumes: Tasks 2–4 functions, exact signatures.
- Produces: `geminiMemoryAdapter` unchanged in observable behavior; `test/gemini/*.test.ts` passes unmodified.

- [x] **Step 1: Replace the import block**

```ts
import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { stableJsonHash } from "../../runtime/hashing.js";
import { recordActiveWorkspaceSession } from "../../runtime/active-workspace-session.js";
import { firstDefined, firstRecord, firstString } from "../../runtime/util.js";
import { hasSeenAny, markSeen, type AssistantMessageState } from "../../runtime/dedupe.js";
import { pickStringFields } from "../payload.js";
import { appendNamsFailureDiagnostic } from "../../runtime/logging.js";
import { createNamsMemoryService, type NamsMemoryService } from "../../runtime/memory-service.js";
import {
  assistantContentHash,
  ensureConversation,
  recallMemoryContextOnce,
  recordToolCallOnce,
  storeAssistantMessageOnce,
  storeUserPromptOnce,
  withHookSessionState,
} from "../../runtime/memory-turn.js";
import { sessionStatePath } from "../../runtime/paths.js";
import { type SessionState } from "../../runtime/session-state.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { parseGeminiPayload } from "./payload.js";
import { readGeminiTranscript, type GeminiTranscriptEntry } from "./transcript.js";
```

(`sha256`, `hasSeenAssistantMessage`, `markAssistantMessageSeen`, `loadHookSessionState`, and `saveSessionState` are no longer used here.)

- [x] **Step 2: Replace the four hook functions**

```ts
async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      await recordActiveGeminiWorkspaceSession(
        invocation,
        state,
        payloadInfo.projectDirectory,
        payloadInfo.sessionId,
      );
      return { stdout: { continue: true, suppressOutput: true } };
    });
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      if (payloadInfo.prompt === undefined || isWorkspaceCommandResultPrompt(payloadInfo.prompt)) {
        return allowOutput();
      }

      const workspaceResult = await resolveWorkspaceForMemory({
        invocation,
        state,
        projectDirectory: payloadInfo.projectDirectory,
      });
      if (workspaceResult.status !== "ready") {
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

      return allowOutput(additionalContext);
    });
}

async function afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      if (state.conversationId === undefined) {
        return allowOutput();
      }
      const conversationId = state.conversationId;

      const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
      if (config === undefined) {
        return allowOutput();
      }

      try {
        const memory = createNamsMemoryService(config, invocation, state);
        const response = payloadInfo.promptResponse?.trim();
        if (response !== undefined && response !== "") {
          const responseHash = assistantContentHash(invocation.platform, state.sessionKey, response);
          await storeAssistantMessageOnce(memory, state, conversationId, response, {
            lookupHash: responseHash,
            markHashes: [responseHash],
          });
        }

        if (payloadInfo.transcriptPath !== undefined) {
          const entries = await readGeminiTranscript(payloadInfo.transcriptPath);
          if (response === undefined || response === "") {
            await storeAssistantMessagesFromTranscript(invocation.platform, conversationId, state, memory, entries);
          }
          await recordTraceFromTranscript(conversationId, state, memory, entries);
        }
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowOutput();
    });
}

async function afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      if (state.conversationId === undefined) {
        return allowOutput();
      }

      const toolPayload = parseGeminiAfterToolPayload(invocation.rawPayload);
      if (toolPayload.toolName === undefined) {
        return allowOutput();
      }

      const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
      if (config === undefined) {
        return allowOutput();
      }

      try {
        const memory = createNamsMemoryService(config, invocation, state);
        const reasoningStep = {
          conversationId: state.conversationId,
          reasoning: `Gemini invoked ${toolPayload.toolName} with the provided tool input.`,
          actionTaken: `Ran ${toolPayload.toolName}`,
          ...(toolPayload.outputSummary !== undefined ? { result: toolPayload.outputSummary } : {}),
        };
        await recordToolCallOnce(
          memory,
          state,
          geminiToolCallDedupeKeys(state.sessionKey, toolPayload.toolName, toolPayload.input),
          reasoningStep,
          stableJsonHash({ sessionKey: state.sessionKey, ...reasoningStep }),
          {
            toolName: toolPayload.toolName,
            input: toolPayload.input,
            ...(toolPayload.output !== undefined ? { output: toolPayload.output } : {}),
          },
        );
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowOutput();
    });
}
```

- [x] **Step 3: Update `storeAssistantMessagesFromTranscript`**

Replace its body's hash-and-store block so the whole function reads:

```ts
async function storeAssistantMessagesFromTranscript(
  platform: string,
  conversationId: string,
  state: AssistantMessageState & { sessionKey: string; seenTranscriptEntryIds: string[] },
  memory: NamsMemoryService,
  entries: GeminiTranscriptEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.kind !== "assistant") {
      continue;
    }
    if (entry.id !== undefined && state.seenTranscriptEntryIds.includes(entry.id)) {
      continue;
    }

    const content = entry.content.trim();
    if (content !== "") {
      const responseHash = assistantContentHash(platform, state.sessionKey, content);
      await storeAssistantMessageOnce(memory, state, conversationId, content, {
        lookupHash: responseHash,
        markHashes: [responseHash],
      });
    }

    if (entry.id !== undefined) {
      state.seenTranscriptEntryIds.push(entry.id);
    }
  }
}
```

Everything else — `geminiToolCallDedupeKeys` (and its invariant comment), `recordTraceFromTranscript`, `TraceState`, `addCurrentParentStepId`, `transcriptParentKey`, `parseGeminiAfterToolPayload`, `isWorkspaceCommandResultPrompt`, `recordActiveGeminiWorkspaceSession`, `allowOutput`, `workspaceResultOutput` — stays unchanged.

- [x] **Step 4: Run the Gemini tests**

Run: `npm run build && npm run test:typecheck && node --import=tsx --test test/gemini/*.test.ts test/gemini-template.test.ts test/architecture.test.ts`
Expected: PASS with no test modifications.

- [x] **Step 5: Commit**

```bash
git add src/platforms/gemini/index.ts
git commit -m "refactor: gemini adapter uses shared turn policies and state bracket"
```

---

### Task 7: Refactor the Codex adapter

Codex keeps: `isWorkspaceSkillPrompt`, `recordSelectionRequiredWorkspaceSession`, `allowPostToolUseOutput`, and all key/hash builders (`codexToolCallId`, `codexReasoningStepHash`, `codexTranscriptToolCallId`, `codexTranscriptReasoningStepHash`, `assistantMessageDedupeHash`, `assistantMessageHashes`). Deleted: the local `assistantContentHash` (replaced by the shared export with the identical signature and output), the local `AssistantMessageState`/`TraceState` type aliases, and `markReasoningStepSeen`/`markToolCallSeen` (absorbed by `recordToolCallOnce`).

**Files:**
- Modify: `src/platforms/codex/index.ts`

**Interfaces:**
- Consumes: Tasks 2–4 functions plus `type ToolCallTraceState` from `../../runtime/memory-turn.js` and `type AssistantMessageState` from `../../runtime/dedupe.js`.
- Produces: `codexMemoryAdapter` unchanged in observable behavior; `test/codex/*.test.ts` passes unmodified.

- [x] **Step 1: Replace the import block**

```ts
import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { recordActiveWorkspaceSession } from "../../runtime/active-workspace-session.js";
import { type AssistantMessageState } from "../../runtime/dedupe.js";
import { sha256 } from "../../runtime/hashing.js";
import { appendNamsFailureDiagnostic } from "../../runtime/logging.js";
import {
  createNamsMemoryService,
  serializeToolInput,
  type NamsMemoryService,
} from "../../runtime/memory-service.js";
import {
  assistantContentHash,
  ensureConversation,
  recallMemoryContextOnce,
  recordToolCallOnce,
  storeAssistantMessageOnce,
  storeUserPromptOnce,
  withHookSessionState,
  type ToolCallTraceState,
} from "../../runtime/memory-turn.js";
import { sessionStatePath } from "../../runtime/paths.js";
import { type SessionState } from "../../runtime/session-state.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { parseCodexPayload } from "./payload.js";
import { readCodexTranscript, type CodexTranscriptEntry } from "./transcript.js";
```

- [x] **Step 2: Replace the four hook functions**

```ts
async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async () => {
      return { stdout: { continue: true, suppressOutput: true } };
    });
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      if (payloadInfo.prompt === undefined) {
        return allowOutput();
      }
      if (isWorkspaceSkillPrompt(payloadInfo.prompt)) {
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

      return allowOutput(additionalContext);
    });
}

async function afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      if (state.conversationId === undefined) {
        return allowOutput();
      }
      const conversationId = state.conversationId;

      const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
      if (config === undefined) {
        return allowOutput();
      }

      try {
        const memory = createNamsMemoryService(config, invocation, state);
        const response = payloadInfo.lastAssistantMessage?.trim();
        if (response !== undefined && response !== "") {
          await storeAssistantMessageOnce(memory, state, conversationId, response, {
            lookupHash: assistantMessageDedupeHash(invocation.platform, state.sessionKey, response, payloadInfo.turnId),
            markHashes: assistantMessageHashes(invocation.platform, state.sessionKey, response, payloadInfo.turnId),
          });
        }
        if (payloadInfo.transcriptPath !== undefined) {
          const entries = await readCodexTranscript(payloadInfo.transcriptPath);
          if (response === undefined || response === "") {
            await storeAssistantMessagesFromTranscript(invocation.platform, conversationId, state, memory, entries);
          }
          await recordTraceFromTranscript(conversationId, state, memory, entries);
        }
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
        return allowOutput();
      }

      return allowOutput();
    });
}

async function afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      const conversationId = state.conversationId;
      const toolName = payloadInfo.toolName;
      if (conversationId === undefined || toolName === undefined) {
        return allowPostToolUseOutput();
      }

      const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
      if (config === undefined) {
        return allowPostToolUseOutput();
      }

      const toolInput = payloadInfo.toolInput ?? {};
      const toolCallId = codexToolCallId({
        sessionKey: state.sessionKey,
        toolName,
        turnId: payloadInfo.turnId,
        toolUseId: payloadInfo.toolUseId,
        toolInput,
      });

      try {
        const memory = createNamsMemoryService(config, invocation, state);
        await recordToolCallOnce(
          memory,
          state,
          { lookupKeys: [toolCallId], markKeys: [toolCallId] },
          {
            conversationId,
            reasoning: `Codex ran ${toolName} for the current turn.`,
            actionTaken: `Ran ${toolName}`,
            ...(payloadInfo.toolResponse !== undefined ? { result: "Codex exposed post-tool output." } : {}),
          },
          codexReasoningStepHash({ sessionKey: state.sessionKey, toolName, turnId: payloadInfo.turnId }),
          {
            toolName,
            input: toolInput,
            ...(payloadInfo.toolResponse !== undefined ? { output: payloadInfo.toolResponse } : {}),
          },
        );
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowPostToolUseOutput();
    });
}
```

- [x] **Step 3: Update the transcript helpers and delete the absorbed locals**

Delete the local `type AssistantMessageState = {...}` and `type TraceState = {...}` aliases, the local `assistantContentHash` function, and `markReasoningStepSeen`/`markToolCallSeen`. Replace the two transcript helpers with:

```ts
async function storeAssistantMessagesFromTranscript(
  platform: string,
  conversationId: string,
  state: AssistantMessageState & { seenTranscriptEntryIds: string[]; sessionKey: string },
  memory: NamsMemoryService,
  entries: CodexTranscriptEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.kind !== "assistant") {
      continue;
    }
    if (entry.id !== undefined && state.seenTranscriptEntryIds.includes(entry.id)) {
      continue;
    }

    const content = entry.content.trim();
    if (content !== "") {
      const responseHash = assistantContentHash(platform, state.sessionKey, content);
      await storeAssistantMessageOnce(memory, state, conversationId, content, {
        lookupHash: responseHash,
        markHashes: [responseHash],
      });
    }

    if (entry.id !== undefined) {
      state.seenTranscriptEntryIds.push(entry.id);
    }
  }
}

async function recordTraceFromTranscript(
  conversationId: string,
  state: ToolCallTraceState & { sessionKey: string },
  memory: NamsMemoryService,
  entries: CodexTranscriptEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.kind !== "toolCall") {
      continue;
    }

    const toolCallId = codexTranscriptToolCallId(state.sessionKey, entry);
    await recordToolCallOnce(
      memory,
      state,
      { lookupKeys: [toolCallId], markKeys: [toolCallId] },
      {
        conversationId,
        reasoning: `Codex exposed ${entry.name} from the session transcript.`,
        actionTaken: `Ran ${entry.name}`,
        ...(entry.status !== undefined ? { result: `Codex transcript recorded status: ${entry.status}.` } : {}),
      },
      codexTranscriptReasoningStepHash(state.sessionKey, entry.name, entry.status),
      {
        toolName: entry.name,
        input: entry.args,
        ...(entry.status !== undefined ? { status: entry.status } : {}),
      },
    );
  }
}
```

`assistantMessageDedupeHash`, `assistantMessageHashes` (both now calling the shared `assistantContentHash`), `codexToolCallId`, `codexReasoningStepHash`, `codexTranscriptToolCallId`, `codexTranscriptReasoningStepHash`, `isWorkspaceSkillPrompt`, `recordSelectionRequiredWorkspaceSession`, `allowOutput`, `allowPostToolUseOutput`, `workspaceResultOutput` stay unchanged.

- [x] **Step 4: Run the Codex tests**

Run: `npm run build && npm run test:typecheck && node --import=tsx --test test/codex/*.test.ts test/codex-template.test.ts test/architecture.test.ts`
Expected: PASS with no test modifications.

- [x] **Step 5: Commit**

```bash
git add src/platforms/codex/index.ts
git commit -m "refactor: codex adapter uses shared turn policies and state bracket"
```

---

### Task 8: Refactor the OpenCode adapter

OpenCode keeps: `hookName` routing (it happens before state is loaded, so it stays outside the bracket), the pending-context two-phase injection, message-id user dedupe (`hasSeenUserMessage`/`markUserMessageSeen`/`userMessageHash`), the assistant part-id branch, `assistantPartKey`, and `opencodeToolCallDedupeKey`. Deleted: the local `assistantMessageHash` (replaced by the shared `assistantContentHash` — identical output). Deliberate unification #3 applies here: the hash fallback path now marks unconditionally.

**Files:**
- Modify: `src/platforms/opencode/index.ts`

**Interfaces:**
- Consumes: Tasks 2–4 functions, exact signatures (`storeUserPromptOnce` is still not used — OpenCode keeps message-id user dedupe).
- Produces: `opencodeMemoryAdapter` unchanged in observable behavior; `test/opencode/*.test.ts` passes unmodified.

- [x] **Step 1: Replace the import block**

```ts
import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { markSeen } from "../../runtime/dedupe.js";
import { sha256, stableJsonHash } from "../../runtime/hashing.js";
import {
  assistantContentHash,
  ensureConversation,
  recallMemoryContextOnce,
  recordToolCallOnce,
  storeAssistantMessageOnce,
  withHookSessionState,
} from "../../runtime/memory-turn.js";
import {
  appendNamsFailureDiagnostic,
} from "../../runtime/logging.js";
import { createNamsMemoryService, serializeToolInput } from "../../runtime/memory-service.js";
import type { SessionState } from "../../runtime/session-state.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { parseOpenCodePayload, type OpenCodePayloadInfo } from "./payload.js";
```

(`hasSeenAssistantMessage`, `markAssistantMessageSeen`, `loadHookSessionState`, and `saveSessionState` are no longer used here.)

- [x] **Step 2: Replace the hook functions and `consumePendingContext`**

```ts
async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async () => allowOutput());
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    if (payloadInfo.hookName === "experimental.chat.system.transform") {
      return consumePendingContext(invocation, payloadInfo);
    }
    if (payloadInfo.hookName !== "chat.message") {
      return allowOutput();
    }

    return withHookSessionState(invocation, payloadInfo, async (state) => {
      state.seenUserMessageIds ??= [];

      const userPrompt = payloadInfo.userPrompt;
      if (userPrompt === undefined || userPrompt.trim() === "") {
        return allowOutput();
      }

      const workspaceResult = await resolveWorkspaceForMemory({
        invocation,
        state,
        projectDirectory: payloadInfo.projectDirectory,
      });
      if (workspaceResult.status !== "ready") {
        return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
      }

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

        if (!hasSeenUserMessage(state, payloadInfo.messageId, invocation.platform, userPrompt)) {
          await memory.storeUserMessage(conversationId, userPrompt);
          markUserMessageSeen(state, payloadInfo.messageId, invocation.platform, userPrompt);
        }
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowOutput();
    });
}

async function afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      state.seenAssistantPartIds ??= [];

      if (payloadInfo.hookName !== "experimental.text.complete") {
        return allowOutput();
      }

      if (state.conversationId === undefined) {
        return allowOutput();
      }

      const assistantText = payloadInfo.assistantText?.trim();
      if (assistantText === undefined || assistantText === "") {
        return allowOutput();
      }

      const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
      if (config === undefined) {
        return allowOutput();
      }

      try {
        const memory = createNamsMemoryService(config, invocation, state);
        const assistantPartId = assistantPartKey(payloadInfo);
        if (assistantPartId !== undefined) {
          if (!state.seenAssistantPartIds.includes(assistantPartId)) {
            await memory.storeAssistantMessage(state.conversationId, assistantText);
            markSeen(state.seenAssistantPartIds, [assistantPartId]);
          }
        } else {
          const assistantHash = assistantContentHash(invocation.platform, state.sessionKey, assistantText);
          await storeAssistantMessageOnce(memory, state, state.conversationId, assistantText, {
            lookupHash: assistantHash,
            markHashes: [assistantHash],
          });
        }
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowOutput();
    });
}

async function afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      if (state.conversationId === undefined) {
        return allowOutput();
      }

      if (payloadInfo.hookName !== "tool.execute.after") {
        return allowOutput();
      }

      if (payloadInfo.toolName === undefined || payloadInfo.toolName.trim() === "") {
        return allowOutput();
      }

      const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
      if (config === undefined) {
        return allowOutput();
      }

      try {
        const memory = createNamsMemoryService(config, invocation, state);
        const dedupeKey = opencodeToolCallDedupeKey(
          state.sessionKey,
          payloadInfo.toolCallId,
          payloadInfo.toolName,
          payloadInfo.toolInput,
        );
        const reasoningStep = {
          conversationId: state.conversationId,
          reasoning: `OpenCode invoked ${payloadInfo.toolName} with the provided tool input.`,
          actionTaken: `Ran ${payloadInfo.toolName}`,
          ...(payloadInfo.toolTitle !== undefined ? { result: payloadInfo.toolTitle } : {}),
        };
        await recordToolCallOnce(
          memory,
          state,
          { lookupKeys: [dedupeKey], markKeys: [dedupeKey] },
          reasoningStep,
          stableJsonHash({ sessionKey: state.sessionKey, ...reasoningStep }),
          {
            toolName: payloadInfo.toolName,
            input: payloadInfo.toolInput,
            ...(payloadInfo.toolOutput !== undefined ? { output: payloadInfo.toolOutput } : {}),
            status: payloadInfo.toolStatus ?? "completed",
          },
        );
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowOutput();
    });
}
```

And replace `consumePendingContext`:

```ts
async function consumePendingContext(
  invocation: HookInvocation<"BeforeAgent">,
  payloadInfo: OpenCodePayloadInfo,
): Promise<HookResult> {
  return withHookSessionState(invocation, payloadInfo, async (state) => {
    const pendingContext = state.pendingMemoryContext;
    if (pendingContext === undefined) {
      return allowOutput();
    }

    delete state.pendingMemoryContext;
    return {
      stdout: {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: "BeforeAgent",
          additionalContext: pendingContext.content,
        },
      },
    };
  });
}
```

- [x] **Step 3: Delete the absorbed local helper**

Delete `assistantMessageHash` (the shared `assistantContentHash` produces the identical string). Keep `hasSeenUserMessage`, `markUserMessageSeen`, `userMessageHash`, `assistantPartKey`, `opencodeToolCallDedupeKey`, `allowOutput`, `workspaceResultOutput` unchanged.

- [x] **Step 4: Run the OpenCode tests**

Run: `npm run build && npm run test:typecheck && node --import=tsx --test test/opencode/*.test.ts test/architecture.test.ts`
Expected: PASS with no test modifications. If `opencode-memory-flow.test.ts` asserts state-file contents on a duplicate fallback-path assistant message, the failure will show `lastAssistantMessageHash` now being set — that is deliberate unification #3; flag it in review rather than silently adapting the test.

- [x] **Step 5: Commit**

```bash
git add src/platforms/opencode/index.ts
git commit -m "refactor: opencode adapter uses shared turn policies and state bracket"
```

---

### Task 9: Full verification

**Files:**
- No new changes; verification only.

- [x] **Step 1: Run the complete check**

Run: `npm run check`
Expected: OpenAPI freshness, build, typecheck, and all tests PASS.

- [x] **Step 2: Verify the duplication actually shrank**

Run: `rg -l "saveSessionState|loadHookSessionState" src/platforms`
Expected: no matches — every adapter goes through `withHookSessionState`.

Run: `wc -l src/platforms/claude/index.ts src/platforms/gemini/index.ts src/platforms/codex/index.ts src/platforms/opencode/index.ts`
Expected: each adapter meaningfully smaller than baseline (claude 246, gemini 435, codex 412, opencode 316). If one did not shrink, a hook function was missed — grep it for `try {` blocks containing `recordReasoningStep` or `storeAssistantMessage`; only the OpenCode part-id branch and the Gemini thought-trace may call `memory.*` directly.

- [x] **Step 3: Verify the generated artifacts still build**

Run: `npm run package:check`
Expected: PASS — `runtime/dedupe.js` and the updated `runtime/memory-turn.js` must appear under `dist/bin/runtime/`, and no artifact references `platforms/dedupe.js`.

- [x] **Step 4: Commit any generated-artifact metadata updates and finish**

```bash
git status --short
git add -A
git commit -m "chore: verify dist projections after memory-turn completion" --allow-empty
```
