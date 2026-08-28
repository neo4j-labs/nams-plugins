# Codex Session Outbox Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing transcript-by-transcript replay implementation with a Codex-only importer that groups rollout files by Codex `session_id`, assembles tool-bearing Agent Steps per thread and turn, writes a complete private outbox under the OS temporary directory, and sends it to NAMS with fail-fast best-effort semantics.

**Architecture:** Codex rollout parsing becomes a deep platform module: it discovers and filters files by the import root, groups all matching root and subagent files by `session_id`, and produces normalized conversations, messages, Agent Steps, and wrapper-level tool calls without consulting live hook state. A separate Codex outbox module materializes those normalized operations as private JSONL in a unique temporary directory; a fail-fast sender resolves NAMS configuration once, sends the outbox sequentially, and keeps remote conversation/step identifiers only in process memory. This plan supersedes `docs/plans/0002-session-history-import.md`, the current replay adapter/runtime implementation, and replay decisions in `docs/adr/0001-project-replay-from-source-turns-and-semantic-operations.md` wherever they conflict.

**Tech Stack:** TypeScript 5.9, Node.js 20+ ESM and built-ins, generated NAMS REST client, Node `node:test`, `tsx`, and existing dev-only `fetch-mock` test support.

## Global Constraints

- The public command is exactly `nams-hooks replay codex [--working-dir PATH]`; `replay claude` is unsupported.
- Remove Claude replay discovery, parsing, registry, CLI, and tests. Preserve Claude live hooks, payload parsing, configuration discovery, templates, workspaces, and marketplace behavior.
- This plan takes precedence over current replay interfaces, tests, retry behavior, per-file conversation behavior, and historical implementation-plan decisions. Do not preserve an incompatible interface merely for compatibility with the implementation being replaced.
- Replay is Codex-only and offline. It must never resume an agent, invoke a model or tool, recall memory, or simulate a hook event.
- Discover Codex JSONL files only under `CODEX_HOME/{sessions,archived_sessions}` or `~/.codex/{sessions,archived_sessions}` using the existing regular-file traversal rules.
- Filter files by the first usable absolute `session_meta.payload.cwd`. A file matches when that directory is the absolute import root or a descendant. Do not infer ownership from filenames, Git metadata, later cwd values, or string-prefix matching.
- Group every matching root and subagent rollout with the same `session_meta.payload.session_id` into one imported NAMS conversation per replay run. Use `payload.id` as the session-ID fallback only when `session_id` is absent; when `session_id` exists, `payload.id` remains available as the rollout thread identity.
- Validate grouped files have the same normalized project directory. If one `session_id` appears with conflicting project directories, fail collection before creating the outbox.
- Memory usage is not a design constraint for this importer. Read and assemble the filtered corpus in memory; do not add streaming parsers, chunk caches, persistent cursors, or memory-pressure machinery.
- Do not read, create, update, or reuse live `SessionState`. Do not write replay data beneath `.nams/state/` or `.nams/logs/`.
- Persist no replay checkpoint, cursor, deduplication key, sent marker, conversation mapping, or Agent Step mapping outside the temporary outbox and in-process maps.
- Build the complete normalized outbox before sending the first NAMS request.
- Store the outbox beneath a unique `mkdtemp()` directory rooted at `node:os.tmpdir()` in production. Test callers may inject another temporary root.
- Use mode `0700` for the temporary outbox directory and `0600` for the JSONL file. Reuse `ensurePrivateDirectory()` and `writePrivateFile()`.
- Remove the temporary outbox in a `finally` block after success or a handled failure. An abrupt process termination may leave the private directory for OS temporary-file cleanup.
- Delivery is sequential and fail-fast. The first configuration, outbox-validation, transport, HTTP, or response-validation failure stops the process; do not continue to later records or sessions.
- Do not retry failed NAMS requests. Restarting replay rediscovers the corpus, recreates the entire outbox, creates new NAMS conversations, and begins sending from the start.
- Do not deduplicate. Duplicate conversations, messages, Agent Steps, and tool calls after restart are acceptable. Partial/orphaned conversations after failure are acceptable.
- The delivery guarantee is best-effort, at-least-once assuming the operator restarts after failure. Records after a failed operation are not delivered until such a restart.
- Use `event_msg` / `item_completed` / `UserMessage` for human user messages. Do not import raw `response_item` messages with role `user`, because Codex records environment context, plugin recommendations, and skill injection under that role.
- Use root-thread `event_msg` / `item_completed` / `AgentMessage` items for assistant messages. Do not flatten subagent assistant messages or `response_item.agent_message` handoffs into the canonical NAMS message stream.
- Treat `response_item.reasoning` only as an Agent Step boundary. Never store `encrypted_content`, raw reasoning, compaction summaries, or hidden chain-of-thought.
- Isolate open Agent Steps by `(session_id, thread_id, turn_id)`. A reasoning item closes the preceding step in that same stream and opens another. `task_complete` and end-of-file close remaining steps.
- Discard reasoning intervals with no tool calls. If a tool call appears without a preceding reasoning item, create one safe operational fallback step for that `(thread_id, turn_id)`.
- Treat response-level `custom_tool_call` and `function_call` records as the canonical tool calls in this version. Do not also emit nested `CommandExecution`, `FileChange`, `CollabAgentToolCall`, or `SubAgentActivity` records as NAMS tool calls.
- Pair call/output records by explicit `call_id`, scoped by session, thread, and turn. Retain unmatched calls without output and count orphan outputs as unsupported.
- Append every output record and every visible output part in source order. For `custom_tool_call_output.output`, extract each textual part and concatenate with `join("")`; never keep only the first part and never overwrite earlier parts.
- Decode `function_call.arguments` as JSON when possible. Preserve its `namespace` in the input as `{ namespace, input }`. Preserve custom call input as the exposed opaque string/object.
- Normalize only NAMS-compatible statuses: `success`, `failure`, `error`, `timeout`, `cancelled`, or `pending`. Never send Codex `completed` or `in_progress` verbatim.
- Derive custom-wrapper `success` from `Script completed`, `failure` from `Script failed`, and collaboration wait `timeout` from a decoded output with `timed_out: true`. Otherwise omit status when the evidence is ambiguous; the existence of an output alone is not proof of success.
- Derive duration from an explicit numeric duration when present, otherwise from valid call/output timestamps. Do not parse presentation-formatted wall-time text.
- Create one NAMS Agent Step per tool-bearing reasoning boundary and attach all calls collected under that boundary to the returned NAMS step ID.
- Use only safely exposed operational text in Agent Step fields. Prefer visible assistant commentary from the interval; otherwise use `Codex exposed a tool-use step in the persisted rollout.`. Derive `actionTaken` and `result` from tool names and normalized statuses.
- Use existing NAMS configuration precedence, workspace auto-resolution, generated client, provenance headers, tool-input sanitization, and tool-output serialization. Do not add a runtime npm dependency or fetch/inspect OpenAPI at runtime.
- The outbox may contain exposed tool inputs and outputs, so never print its path or contents in progress, errors, stdout, stderr, or tests.
- Send progress to stderr without transcript paths or content. Send one aggregate success summary to stdout. On failure, print one scrubbed error and exit nonzero through the existing CLI top-level error handler.
- Tests use OS temporary fixtures, make no external network calls, leave no `.nams/` or outbox artifacts in the repository, and do not assert documentation content.
- Do not hand-edit `dist/`, `dist-marketplace/`, or `dist-local/`.
- Final verification is the focused replay tests followed by `npm run check`.

---

## Rollout Findings Driving The Plan

- The uploaded corpus contains 11 rollout files but only two `session_id` values; one source session spans one root file and nine subagent files. A file-to-conversation projection therefore fragments one Codex conversation.
- The corpus contains 173 response-level reasoning items. Thirty-seven reasoning intervals contain no tool call, including 22 empty intervals, so treating every boundary as a NAMS Agent Step creates noise.
- It contains 113 `custom_tool_call` wrappers and 29 `function_call` wrappers. Five reasoning intervals contain more than one wrapper call, so one-call/one-step projection loses the observed Agent Step boundary.
- Every sampled wrapper call has a matching output, but custom outputs contain between two and six textual parts, 241 parts in total. Selecting `output[0]` loses exposed output, and overwriting on a later output record is equally unsafe.
- Fifteen persisted response messages use role `user`, while only three are authored human prompts; the remainder are environment, skill, or injected context. Completed `UserMessage` events are the defensible human-message source.
- Root and subagent assistant records coexist. Flattening all of them into one message stream invents dialogue order, while root completed `AgentMessage` events provide a clean canonical assistant stream.
- Codex raw status values include values such as `completed` that the NAMS contract does not accept. Status must be derived from explicit output evidence or omitted.
- Nested event records such as `CommandExecution`, `FileChange`, and collaboration activity describe the same operation as response-level wrappers in this corpus. Emitting both creates duplicate tool calls; this plan chooses the response-level wrapper consistently.

---

## File Map

- `src/platforms/codex/replay-model.ts`: Codex collection, message, Agent Step, tool-call, outbox-record, and summary types.
- `src/platforms/codex/replay-collector.ts`: Codex rollout discovery, cwd filtering, session/thread/turn identity, message extraction, step boundaries, call/output pairing, status normalization, and deterministic session assembly.
- `src/platforms/codex/replay-outbox.ts`: conversion from collected sessions to logical JSONL operations, private temporary directory creation, outbox reading, validation, and cleanup.
- `src/platforms/codex/replay-sender.ts`: one-time NAMS destination resolution and sequential fail-fast delivery using in-memory local-to-remote ID maps.
- `src/platforms/codex/replay-runner.ts`: end-to-end collection, temporary outbox lifecycle, delivery, progress, and final summary.
- `src/platforms/codex/index.ts`: expose `runCodexReplay` through the Codex platform entrypoint while retaining live `codexMemoryAdapter`.
- `src/cli.ts`: accept only `replay codex`, invoke `runCodexReplay`, and report the new summary.
- `src/runtime/provenance.ts`: make replay provenance Codex-specific without a generic replay-platform type.
- `src/interfaces.ts`: remove obsolete generic replay platform/adapter/transcript contracts.
- `src/platforms/index.ts`: remove the replay adapter registry; keep live memory/workspace registries unchanged.
- `src/platforms/claude/index.ts`: stop exporting a Claude replay adapter; keep the live adapter unchanged.
- Delete `src/platforms/claude/replay.ts`: Claude replay is outside the new outbox contract.
- Delete `src/platforms/codex/replay.ts`: the per-file Codex replay adapter is replaced by the collector/runner modules.
- Delete `src/runtime/replay.ts`: the continue-on-failure generic sender is replaced by the Codex sender.
- `test/support/codex-rollout-fixture.ts`: compact builders for realistic Codex JSONL records.
- `test/codex/codex-replay-collector.test.ts`: session grouping, message policy, Agent Step boundaries, call pairing, output concatenation, statuses, fallback steps, filtering, and malformed records.
- `test/codex/codex-replay-outbox.test.ts`: JSONL operation order, local references, private permissions, read validation, and cleanup.
- `test/support/nams-replay-environment.ts`: isolated environment helper for sender and runner tests; restores process variables and removes its OS-temp home.
- `test/codex/codex-replay-sender.test.ts`: exact NAMS request order, shared step IDs, fail-fast behavior, no retries, no state/log writes, and workspace resolution.
- `test/codex/codex-replay-runner.test.ts`: complete temporary-outbox lifecycle, successful import, failure cleanup, and duplicate writes after a fresh restart.
- `test/cli-replay.test.ts`: Codex-only CLI syntax, stdout/stderr, no stdin dependency, and rejected Claude replay.
- `test/provenance.test.ts`: Codex replay headers.
- `test/architecture.test.ts`: absence of generic/Claude replay registries and preservation of live registries.
- Delete `test/claude/claude-replay.test.ts`, `test/codex/codex-replay.test.ts`, and `test/replay-runtime.test.ts`: their contracts are superseded.
- `docs/adr/0001-project-replay-from-source-turns-and-semantic-operations.md`: mark the multi-platform semantic-operation decision superseded.
- `docs/adr/0002-codex-session-outbox-replay.md`: record the Codex-only session/outbox/fail-fast decision.
- `CONTEXT.md`: replace per-file Claude/Codex replay terminology with Codex session, rollout stream, temporary outbox, and best-effort delivery terms.
- `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`: record the Codex-only offline replay architecture and explicit separation from live state.

### Task 1: Codex Session Collector And Agent Step Assembly

**Files:**
- Create: `src/platforms/codex/replay-model.ts`
- Create: `src/platforms/codex/replay-collector.ts`
- Create: `test/support/codex-rollout-fixture.ts`
- Create: `test/codex/codex-replay-collector.test.ts`
- Existing helper: `src/runtime/replay-files.ts`

**Interfaces:**
- Consumes: `discoverRegularJsonlFiles(roots: string[]): Promise<string[]>`, `normalizeAbsolutePath(value: unknown): string | undefined`, `isDirectoryWithinImportRoot(importRoot: string, candidate: string): boolean`, `firstString(...)`, and `isPlainObject(...)`.
- Produces: `discoverCodexRolloutPaths(env?: NodeJS.ProcessEnv): Promise<string[]>` and `collectCodexReplaySessions(input: CollectCodexReplayInput): Promise<CodexReplayCollection>` with the exact types defined in Step 5.

- [x] **Step 1: Create realistic Codex rollout builders**

Create `test/support/codex-rollout-fixture.ts` with these complete builders. They deliberately emit the same wrappers and turn metadata observed in `docs/research/rollouts-codex`:

```ts
export interface RolloutRecord {
  timestamp: string;
  ordinal: number;
  type: string;
  payload: Record<string, unknown>;
}

export function sessionMeta(input: {
  sessionId: string;
  threadId?: string;
  cwd: string;
  threadSource: "user" | "subagent";
  timestamp?: string;
}): RolloutRecord {
  const timestamp = input.timestamp ?? "2026-08-26T12:00:00.000Z";
  return {
    timestamp,
    ordinal: 0,
    type: "session_meta",
    payload: {
      session_id: input.sessionId,
      id: input.threadId ?? input.sessionId,
      timestamp,
      cwd: input.cwd,
      thread_source: input.threadSource,
    },
  };
}

export function responseItem(
  ordinal: number,
  turnId: string,
  payload: Record<string, unknown>,
  timestamp = `2026-08-26T12:00:${String(ordinal).padStart(2, "0")}.000Z`,
): RolloutRecord {
  return {
    timestamp,
    ordinal,
    type: "response_item",
    payload: {
      ...payload,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  };
}

export function completedItem(
  ordinal: number,
  threadId: string,
  turnId: string,
  item: Record<string, unknown>,
  timestamp = `2026-08-26T12:00:${String(ordinal).padStart(2, "0")}.000Z`,
): RolloutRecord {
  return {
    timestamp,
    ordinal,
    type: "event_msg",
    payload: { type: "item_completed", thread_id: threadId, turn_id: turnId, item },
  };
}

export function taskComplete(ordinal: number, threadId: string, turnId: string): RolloutRecord {
  return {
    timestamp: `2026-08-26T12:00:${String(ordinal).padStart(2, "0")}.000Z`,
    ordinal,
    type: "event_msg",
    payload: { type: "task_complete", thread_id: threadId, turn_id: turnId },
  };
}

export function jsonl(records: RolloutRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
```

- [x] **Step 2: Write the failing grouped-session extraction test**

Create `test/codex/codex-replay-collector.test.ts`. The first test must create three files: a matching root rollout, a matching subagent rollout sharing its `session_id`, and an outside-cwd rollout. Use the builders from Step 1 and assert the complete normalized result:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectCodexReplaySessions } from "../../src/platforms/codex/replay-collector.js";
import {
  completedItem,
  jsonl,
  responseItem,
  sessionMeta,
  taskComplete,
  type RolloutRecord,
} from "../support/codex-rollout-fixture.js";

test("groups root and subagent rollouts by session and assembles tool-bearing steps", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-collector-"));
  try {
    const project = path.join(fixture, "project");
    const rootPath = path.join(fixture, "sessions", "root.jsonl");
    const childPath = path.join(fixture, "sessions", "subagents", "child.jsonl");
    const outsidePath = path.join(fixture, "sessions", "outside.jsonl");
    await mkdir(path.dirname(childPath), { recursive: true });
    await mkdir(project, { recursive: true });

    const sessionId = "session-1";
    const rootThread = "thread-root";
    const childThread = "thread-child";
    const rootTurn = "turn-root";
    const childTurn = "turn-child";

    await writeFile(rootPath, jsonl([
      sessionMeta({ sessionId, cwd: project, threadSource: "user" }),
      completedItem(1, rootThread, rootTurn, {
        type: "UserMessage",
        id: "user-1",
        content: [{ type: "text", text: "Build it." }],
      }),
      responseItem(2, rootTurn, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>do not import</environment_context>" }],
      }),
      responseItem(3, rootTurn, {
        type: "reasoning",
        id: "reasoning-1",
        summary: [],
        encrypted_content: "do-not-store",
      }),
      completedItem(4, rootThread, rootTurn, {
        type: "AgentMessage",
        id: "assistant-1",
        phase: "commentary",
        content: [{ type: "Text", text: "I will inspect and test." }],
      }),
      responseItem(5, rootTurn, {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "I will inspect and test." }],
      }),
      responseItem(6, rootTurn, {
        type: "custom_tool_call",
        id: "custom-item-1",
        call_id: "call-1",
        name: "exec",
        input: "run first",
        status: "completed",
      }),
      responseItem(7, rootTurn, {
        type: "custom_tool_call_output",
        call_id: "call-1",
        output: [
          { type: "input_text", text: "Script completed\nOutput:\n" },
          { type: "input_text", text: "first" },
          { type: "input_text", text: " second" },
        ],
      }),
      responseItem(8, rootTurn, {
        type: "function_call",
        id: "function-item-1",
        call_id: "call-2",
        namespace: "collaboration",
        name: "wait_agent",
        arguments: "{\"timeout_ms\":60000}",
        duration_ms: 25,
      }),
      responseItem(9, rootTurn, {
        type: "function_call_output",
        call_id: "call-2",
        output: "{\"message\":\"Wait timed out.\",\"timed_out\":true}",
      }),
      responseItem(10, rootTurn, {
        type: "reasoning",
        id: "reasoning-empty",
        summary: [],
        encrypted_content: "do-not-store",
      }),
      taskComplete(11, rootThread, rootTurn),
    ]), "utf8");

    await writeFile(childPath, jsonl([
      sessionMeta({ sessionId, cwd: project, threadSource: "subagent" }),
      completedItem(1, childThread, childTurn, {
        type: "AgentMessage",
        id: "child-assistant",
        phase: "final_answer",
        content: [{ type: "Text", text: "Do not flatten this child message." }],
      }),
      responseItem(2, childTurn, { type: "reasoning", id: "child-reasoning", summary: [], encrypted_content: "private" }),
      responseItem(3, childTurn, {
        type: "custom_tool_call",
        id: "custom-item-2",
        call_id: "call-3",
        name: "exec",
        input: "run child",
        status: "completed",
      }),
      responseItem(4, childTurn, {
        type: "custom_tool_call_output",
        call_id: "call-3",
        output: [
          { type: "input_text", text: "Script failed\nOutput:\n" },
          { type: "input_text", text: "failure detail" },
        ],
      }),
      taskComplete(5, childThread, childTurn),
    ]), "utf8");

    await writeFile(outsidePath, jsonl([
      sessionMeta({ sessionId: "outside", cwd: path.join(fixture, "other"), threadSource: "user" }),
    ]), "utf8");

    const collection = await collectCodexReplaySessions({
      importRoot: project,
      transcriptPaths: [outsidePath, childPath, rootPath],
    });

    assert.equal(collection.discoveredFiles, 3);
    assert.equal(collection.matchedFiles, 2);
    assert.equal(collection.skippedFiles, 1);
    assert.equal(collection.sessions.length, 1);
    const [session] = collection.sessions;
    assert.equal(session.sourceSessionId, sessionId);
    assert.equal(session.projectDirectory, project);
    assert.deepEqual(session.messages.map(({ timestamp: _timestamp, ordinal: _ordinal, threadId: _threadId, ...message }) => message), [
      { role: "user", content: "Build it." },
      { role: "assistant", content: "I will inspect and test." },
    ]);
    assert.equal(session.steps.length, 2);
    const rootStep = session.steps.find((step) => step.threadId === rootThread);
    const childStep = session.steps.find((step) => step.threadId === childThread);
    assert.ok(rootStep);
    assert.ok(childStep);
    assert.deepEqual(rootStep.toolCalls.map((call) => ({
      toolName: call.toolName,
      input: call.input,
      output: call.output,
      status: call.status,
      durationMs: call.durationMs,
    })), [
      {
        toolName: "exec",
        input: "run first",
        output: "Script completed\nOutput:\nfirst second",
        status: "success",
        durationMs: 1000,
      },
      {
        toolName: "wait_agent",
        input: { namespace: "collaboration", input: { timeout_ms: 60000 } },
        output: "{\"message\":\"Wait timed out.\",\"timed_out\":true}",
        status: "timeout",
        durationMs: 25,
      },
    ]);
    assert.equal(rootStep.reasoning, "I will inspect and test.");
    assert.equal(rootStep.actionTaken, "Ran 2 tool calls: exec, wait_agent");
    assert.equal(childStep.toolCalls[0].output, "Script failed\nOutput:\nfailure detail");
    assert.equal(childStep.toolCalls[0].status, "failure");
    assert.equal(session.messages.some((message) => message.content.includes("environment_context")), false);
    assert.equal(session.messages.some((message) => message.content.includes("child message")), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
```

- [x] **Step 3: Add failing edge-case tests**

In the same test file, add this fixture helper and the focused edge-case tests:

```ts
async function withSingleRollout(
  recordsFor: (project: string) => RolloutRecord[],
  assertion: (
    collection: Awaited<ReturnType<typeof collectCodexReplaySessions>>,
  ) => void | Promise<void>,
): Promise<void> {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-edge-"));
  try {
    const project = path.join(fixture, "project");
    const rolloutPath = path.join(fixture, "sessions", "rollout.jsonl");
    await mkdir(path.dirname(rolloutPath), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(rolloutPath, jsonl(recordsFor(project)), "utf8");
    await assertion(await collectCodexReplaySessions({
      importRoot: project,
      transcriptPaths: [rolloutPath],
    }));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test("keeps output on the originating step when a later reasoning boundary appears", async () => {
  await withSingleRollout((project) => [
    sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
    responseItem(1, "turn-1", {
      type: "reasoning",
      id: "reasoning-1",
      summary: [],
      encrypted_content: "private",
    }),
    responseItem(2, "turn-1", {
      type: "custom_tool_call",
      call_id: "call-1",
      name: "exec",
      input: "first command",
    }),
    responseItem(3, "turn-1", {
      type: "reasoning",
      id: "reasoning-2",
      summary: [],
      encrypted_content: "private",
    }),
    responseItem(4, "turn-1", {
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: [
        { type: "input_text", text: "Script completed\nOutput:\n" },
        { type: "input_text", text: "late" },
      ],
    }),
    responseItem(5, "turn-1", {
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: [
        { type: "input_text", text: " output" },
        { type: "input_text", text: " from every part" },
      ],
    }),
    taskComplete(6, "thread-1", "turn-1"),
  ], (collection) => {
    const [session] = collection.sessions;
    assert.equal(session.steps.length, 1);
    assert.equal(session.steps[0].sourceReasoningId, "reasoning-1");
    assert.equal(
      session.steps[0].toolCalls[0].output,
      "Script completed\nOutput:\nlate output from every part",
    );
    assert.equal(session.steps[0].toolCalls[0].status, "success");
  });
});

test("creates one fallback step for calls before the first reasoning item", async () => {
  await withSingleRollout((project) => [
    sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
    responseItem(1, "turn-1", {
      type: "custom_tool_call",
      call_id: "call-1",
      name: "exec",
      input: "first command",
    }),
    responseItem(2, "turn-1", {
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: [{ type: "input_text", text: "Script completed\nOutput:\nfirst" }],
    }),
    responseItem(3, "turn-1", {
      type: "function_call",
      call_id: "call-2",
      namespace: "collaboration",
      name: "wait_agent",
      arguments: "{\"timeout_ms\":1000}",
    }),
    responseItem(4, "turn-1", {
      type: "function_call_output",
      call_id: "call-2",
      output: "{\"message\":\"done\",\"timed_out\":false}",
    }),
    taskComplete(5, "thread-1", "turn-1"),
  ], (collection) => {
    const [session] = collection.sessions;
    assert.equal(session.steps.length, 1);
    assert.equal(session.steps[0].localStepId.endsWith(":fallback"), true);
    assert.deepEqual(
      session.steps[0].toolCalls.map((call) => call.sourceCallId),
      ["call-1", "call-2"],
    );
    assert.equal(session.steps[0].toolCalls[0].status, "success");
    assert.equal(session.steps[0].toolCalls[1].status, undefined);
  });
});

test("rejects one session id with conflicting project directories", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-conflict-"));
  try {
    const importRoot = path.join(fixture, "project");
    const firstProject = path.join(importRoot, "first");
    const secondProject = path.join(importRoot, "second");
    const firstPath = path.join(fixture, "sessions", "first.jsonl");
    const secondPath = path.join(fixture, "sessions", "second.jsonl");
    await mkdir(path.dirname(firstPath), { recursive: true });
    await mkdir(firstProject, { recursive: true });
    await mkdir(secondProject, { recursive: true });
    await writeFile(firstPath, jsonl([
      sessionMeta({ sessionId: "session-1", cwd: firstProject, threadSource: "user" }),
    ]), "utf8");
    await writeFile(secondPath, jsonl([
      sessionMeta({ sessionId: "session-1", cwd: secondProject, threadSource: "subagent" }),
    ]), "utf8");

    await assert.rejects(
      collectCodexReplaySessions({
        importRoot,
        transcriptPaths: [firstPath, secondPath],
      }),
      new Error("Codex session session-1 has conflicting project directories"),
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("counts malformed lines and orphan outputs as unsupported records", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-malformed-"));
  try {
    const project = path.join(fixture, "project");
    const rolloutPath = path.join(fixture, "sessions", "rollout.jsonl");
    await mkdir(path.dirname(rolloutPath), { recursive: true });
    await mkdir(project, { recursive: true });
    const records = [
      sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
      completedItem(1, "thread-1", "turn-1", {
        type: "UserMessage",
        content: [{ type: "text", text: "Keep parsing." }],
      }),
      responseItem(2, "turn-1", {
        type: "function_call_output",
        call_id: "missing-call",
        output: "orphaned",
      }),
      taskComplete(3, "thread-1", "turn-1"),
    ];
    const contents = [
      JSON.stringify(records[0]),
      "{not valid json",
      ...records.slice(1).map((record) => JSON.stringify(record)),
      "",
    ].join("\n");
    await writeFile(rolloutPath, contents, "utf8");

    const collection = await collectCodexReplaySessions({
      importRoot: project,
      transcriptPaths: [rolloutPath],
    });

    assert.equal(collection.malformedLines, 1);
    assert.equal(collection.unsupportedRecords, 1);
    assert.equal(collection.sessions[0].messages[0].content, "Keep parsing.");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
```

Every test creates and cleans an OS temporary directory. Do not add parser fixtures beneath the repository root.

- [x] **Step 4: Run the collector tests to verify RED**

Run: `node --import=tsx --test test/codex/codex-replay-collector.test.ts`

Expected: FAIL because `replay-collector.ts` and `replay-model.ts` do not exist.

- [x] **Step 5: Define the exact collector model**

Create `src/platforms/codex/replay-model.ts` with:

```ts
export type CodexReplayStatus =
  | "pending"
  | "success"
  | "failure"
  | "error"
  | "timeout"
  | "cancelled";

export interface CodexReplayMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  ordinal: number;
  threadId: string;
}

export interface CodexReplayToolCall {
  sourceCallId: string;
  toolName: string;
  input: unknown;
  output?: string;
  status?: CodexReplayStatus;
  durationMs?: number;
  timestamp: string;
  ordinal: number;
}

export interface CodexReplayStep {
  localStepId: string;
  sourceReasoningId: string;
  threadId: string;
  turnId: string;
  timestamp: string;
  ordinal: number;
  reasoning: string;
  actionTaken: string;
  result?: string;
  toolCalls: CodexReplayToolCall[];
}

export interface CodexReplaySession {
  sourceSessionId: string;
  projectDirectory: string;
  sourceStartedAt?: string;
  messages: CodexReplayMessage[];
  steps: CodexReplayStep[];
}

export interface CodexReplayCollection {
  sessions: CodexReplaySession[];
  discoveredFiles: number;
  matchedFiles: number;
  skippedFiles: number;
  malformedLines: number;
  unsupportedRecords: number;
}

export interface CollectCodexReplayInput {
  importRoot: string;
  transcriptPaths?: string[];
  env?: NodeJS.ProcessEnv;
}
```

- [x] **Step 6: Implement the complete collector**

Create `src/platforms/codex/replay-collector.ts` with the complete implementation below. It deliberately tracks the current `task_started` turn as a fallback for wrappers that omit response metadata, retains a direct call-to-step reference so late output cannot move across a reasoning boundary, and derives status only from explicit evidence:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CodexReplayCollection,
  CodexReplayMessage,
  CodexReplaySession,
  CodexReplayStatus,
  CodexReplayStep,
  CodexReplayToolCall,
  CollectCodexReplayInput,
} from "./replay-model.js";
import {
  discoverRegularJsonlFiles,
  isDirectoryWithinImportRoot,
  normalizeAbsolutePath,
} from "../../runtime/replay-files.js";
import { homeDirectory } from "../../runtime/paths.js";
import { firstString, isPlainObject } from "../../runtime/util.js";

interface ParsedRollout {
  records: Record<string, unknown>[];
  malformedLines: number;
  unsupportedRecords: number;
}

interface SessionMetadata {
  sourceSessionId: string;
  sourceThreadId?: string;
  sourceStartedAt?: string;
  projectDirectory: string;
  threadSource?: string;
}

interface SessionBuilder {
  sourceSessionId: string;
  projectDirectory: string;
  sourceStartedAt?: string;
  messages: CodexReplayMessage[];
  steps: CodexReplayStep[];
}

type StepBuilder = Omit<CodexReplayStep, "toolCalls"> & {
  toolCalls: CallBuilder[];
  commentary: string[];
};

interface CallBuilder extends CodexReplayToolCall {
  step: StepBuilder;
  outputParts: string[];
  callTimestampMs?: number;
  lastOutputTimestampMs?: number;
}

interface StreamResult {
  messages: CodexReplayMessage[];
  steps: CodexReplayStep[];
  unsupportedRecords: number;
}

export async function discoverCodexRolloutPaths(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const configured = firstString(env.CODEX_HOME);
  const home = homeDirectory(env);
  if (configured === undefined && home === undefined) return [];
  const codexRoot = path.resolve(configured ?? path.join(home as string, ".codex"));
  return discoverRegularJsonlFiles([
    path.join(codexRoot, "sessions"),
    path.join(codexRoot, "archived_sessions"),
  ]);
}

export async function collectCodexReplaySessions(
  input: CollectCodexReplayInput,
): Promise<CodexReplayCollection> {
  const importRoot = path.resolve(input.importRoot);
  let transcriptPaths: string[];
  try {
    transcriptPaths = [...(
      input.transcriptPaths ?? await discoverCodexRolloutPaths(input.env)
    )].sort();
  } catch {
    throw new Error("Unable to discover Codex rollouts");
  }
  const groups = new Map<string, SessionBuilder>();
  let matchedFiles = 0;
  let skippedFiles = 0;
  let malformedLines = 0;
  let unsupportedRecords = 0;

  for (const transcriptPath of transcriptPaths) {
    const parsed = await parseRollout(transcriptPath);
    malformedLines += parsed.malformedLines;
    unsupportedRecords += parsed.unsupportedRecords;
    const metadata = rolloutMetadata(parsed.records);
    if (
      metadata === undefined ||
      !isDirectoryWithinImportRoot(importRoot, metadata.projectDirectory)
    ) {
      skippedFiles += 1;
      continue;
    }

    matchedFiles += 1;
    let session = groups.get(metadata.sourceSessionId);
    if (session === undefined) {
      session = {
        sourceSessionId: metadata.sourceSessionId,
        projectDirectory: metadata.projectDirectory,
        ...(metadata.sourceStartedAt !== undefined
          ? { sourceStartedAt: metadata.sourceStartedAt }
          : {}),
        messages: [],
        steps: [],
      };
      groups.set(metadata.sourceSessionId, session);
    } else if (session.projectDirectory !== metadata.projectDirectory) {
      throw new Error(
        `Codex session ${metadata.sourceSessionId} has conflicting project directories`,
      );
    } else if (
      metadata.sourceStartedAt !== undefined &&
      (session.sourceStartedAt === undefined || metadata.sourceStartedAt < session.sourceStartedAt)
    ) {
      session.sourceStartedAt = metadata.sourceStartedAt;
    }

    const threadId = rolloutThreadId(parsed.records)
      ?? metadata.sourceThreadId
      ?? path.basename(transcriptPath, ".jsonl");
    const stream = collectRolloutStream(parsed.records, {
      sessionId: metadata.sourceSessionId,
      threadId,
      isRoot: metadata.threadSource === "user"
        || (metadata.threadSource === undefined && threadId === metadata.sourceSessionId),
    });
    session.messages.push(...stream.messages);
    session.steps.push(...stream.steps);
    unsupportedRecords += stream.unsupportedRecords;
  }

  const sessions: CodexReplaySession[] = [...groups.values()]
    .map((session) => ({
      ...session,
      messages: session.messages.sort(compareTimelineEntry),
      steps: session.steps.sort(compareTimelineEntry),
    }))
    .sort((left, right) =>
      (left.sourceStartedAt ?? "").localeCompare(right.sourceStartedAt ?? "")
      || left.sourceSessionId.localeCompare(right.sourceSessionId)
    );

  return {
    sessions,
    discoveredFiles: transcriptPaths.length,
    matchedFiles,
    skippedFiles,
    malformedLines,
    unsupportedRecords,
  };
}

async function parseRollout(transcriptPath: string): Promise<ParsedRollout> {
  const records: Record<string, unknown>[] = [];
  let malformedLines = 0;
  let unsupportedRecords = 0;
  let contents: string;
  try {
    contents = await readFile(transcriptPath, "utf8");
  } catch {
    throw new Error("Unable to read Codex rollout");
  }
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isPlainObject(parsed)) records.push(parsed);
      else unsupportedRecords += 1;
    } catch {
      malformedLines += 1;
    }
  }
  return { records, malformedLines, unsupportedRecords };
}

function rolloutMetadata(records: Record<string, unknown>[]): SessionMetadata | undefined {
  for (const raw of records) {
    if (raw.type !== "session_meta" || !isPlainObject(raw.payload)) continue;
    const sourceSessionId = firstString(raw.payload.session_id, raw.payload.id);
    const projectDirectory = normalizeAbsolutePath(raw.payload.cwd);
    if (sourceSessionId === undefined || projectDirectory === undefined) continue;
    const sourceThreadId = firstString(raw.payload.id);
    const sourceStartedAt = firstString(raw.payload.timestamp, raw.timestamp);
    const threadSource = firstString(raw.payload.thread_source);
    return {
      sourceSessionId,
      projectDirectory,
      ...(sourceThreadId !== undefined ? { sourceThreadId } : {}),
      ...(sourceStartedAt !== undefined ? { sourceStartedAt } : {}),
      ...(threadSource !== undefined ? { threadSource } : {}),
    };
  }
  return undefined;
}

function rolloutThreadId(records: Record<string, unknown>[]): string | undefined {
  for (const raw of records) {
    if (raw.type !== "event_msg" || !isPlainObject(raw.payload)) continue;
    const threadId = firstString(raw.payload.thread_id);
    if (threadId !== undefined) return threadId;
  }
  return undefined;
}

function collectRolloutStream(
  records: Record<string, unknown>[],
  identity: { sessionId: string; threadId: string; isRoot: boolean },
): StreamResult {
  const activeSteps = new Map<string, StepBuilder>();
  const closedSteps: StepBuilder[] = [];
  const calls = new Map<string, CallBuilder>();
  const messages: CodexReplayMessage[] = [];
  let currentTurnId: string | undefined;
  let unsupportedRecords = 0;

  const closeTurn = (turnId: string): void => {
    const step = activeSteps.get(turnId);
    if (step === undefined) return;
    activeSteps.delete(turnId);
    closedSteps.push(step);
  };

  for (let lineIndex = 0; lineIndex < records.length; lineIndex += 1) {
    const raw = records[lineIndex];
    const timestamp = firstString(raw.timestamp) ?? "";
    const ordinal = finiteNumber(raw.ordinal) ?? lineIndex;
    if (raw.type === "session_meta") continue;

    if (raw.type === "event_msg" && isPlainObject(raw.payload)) {
      const eventType = firstString(raw.payload.type);
      const eventTurnId = firstString(raw.payload.turn_id);
      if (eventType === "task_started") {
        currentTurnId = eventTurnId;
        continue;
      }
      if (eventType === "task_complete") {
        const turnId = eventTurnId ?? currentTurnId;
        if (turnId !== undefined) closeTurn(turnId);
        if (turnId === currentTurnId) currentTurnId = undefined;
        continue;
      }
      if (eventType === "item_completed") {
        const message = completedMessage(raw.payload, {
          isRoot: identity.isRoot,
          threadId: identity.threadId,
          timestamp,
          ordinal,
        });
        if (message !== undefined) messages.push(message);
        continue;
      }
      unsupportedRecords += 1;
      continue;
    }

    if (raw.type !== "response_item" || !isPlainObject(raw.payload)) {
      unsupportedRecords += 1;
      continue;
    }

    const item = raw.payload;
    const turnId = responseTurnId(item) ?? currentTurnId ?? `turn:${ordinal}`;
    if (item.type === "reasoning") {
      closeTurn(turnId);
      const reasoningId = firstString(item.id) ?? `reasoning:${ordinal}`;
      activeSteps.set(turnId, newStep({
        sessionId: identity.sessionId,
        threadId: identity.threadId,
        turnId,
        reasoningId,
        timestamp,
        ordinal,
      }));
      continue;
    }

    if (item.type === "message") {
      if (item.role === "assistant" && item.phase === "commentary") {
        const commentary = responseMessageText(item.content).trim();
        const step = activeSteps.get(turnId);
        if (step !== undefined && commentary !== "") step.commentary.push(commentary);
      }
      continue;
    }

    if (item.type === "custom_tool_call" || item.type === "function_call") {
      const sourceCallId = firstString(item.call_id, item.id);
      const toolName = firstString(item.name);
      if (sourceCallId === undefined || toolName === undefined) {
        unsupportedRecords += 1;
        continue;
      }
      let step = activeSteps.get(turnId);
      if (step === undefined) {
        step = newStep({
          sessionId: identity.sessionId,
          threadId: identity.threadId,
          turnId,
          reasoningId: "fallback",
          timestamp,
          ordinal,
        });
        activeSteps.set(turnId, step);
      }
      const decodedInput = item.type === "function_call"
        ? decodeJson(item.arguments) ?? {}
        : item.input ?? {};
      const namespace = item.type === "function_call" ? firstString(item.namespace) : undefined;
      const call: CallBuilder = {
        sourceCallId,
        toolName,
        input: namespace === undefined
          ? decodedInput
          : { namespace, input: decodedInput },
        timestamp,
        ordinal,
        ...(finiteNumber(item.duration_ms, item.durationMs) !== undefined
          ? { durationMs: finiteNumber(item.duration_ms, item.durationMs) }
          : {}),
        step,
        outputParts: [],
        callTimestampMs: timestampMilliseconds(timestamp),
      };
      step.toolCalls.push(call);
      calls.set(callKey(identity.sessionId, identity.threadId, turnId, sourceCallId), call);
      continue;
    }

    if (item.type === "custom_tool_call_output" || item.type === "function_call_output") {
      const sourceCallId = firstString(item.call_id);
      const call = sourceCallId === undefined
        ? undefined
        : calls.get(callKey(identity.sessionId, identity.threadId, turnId, sourceCallId));
      if (call === undefined) {
        unsupportedRecords += 1;
        continue;
      }
      const parts = item.type === "custom_tool_call_output"
        ? customOutputParts(item.output)
        : [serializedOutput(item.output)];
      call.outputParts.push(...parts);
      call.lastOutputTimestampMs = timestampMilliseconds(timestamp)
        ?? call.lastOutputTimestampMs;
      continue;
    }

    unsupportedRecords += 1;
  }

  for (const turnId of [...activeSteps.keys()]) closeTurn(turnId);
  for (const call of calls.values()) {
    if (call.outputParts.length > 0) call.output = call.outputParts.join("");
    call.status = normalizeStatus(call.toolName, call.output);
    call.durationMs ??= elapsedMilliseconds(
      call.callTimestampMs,
      call.lastOutputTimestampMs,
    );
  }

  const steps = closedSteps
    .filter((step) => step.toolCalls.length > 0)
    .map((step): CodexReplayStep => {
      step.toolCalls.sort(compareTimelineEntry);
      step.reasoning = step.commentary.join("\n").trim()
        || "Codex exposed a tool-use step in the persisted rollout.";
      step.actionTaken = `Ran ${step.toolCalls.length} tool ${
        step.toolCalls.length === 1 ? "call" : "calls"
      }: ${step.toolCalls.map((call) => call.toolName).join(", ")}`;
      const hasStatus = step.toolCalls.some((call) => call.status !== undefined);
      return {
        localStepId: step.localStepId,
        sourceReasoningId: step.sourceReasoningId,
        threadId: step.threadId,
        turnId: step.turnId,
        timestamp: step.timestamp,
        ordinal: step.ordinal,
        reasoning: step.reasoning,
        actionTaken: step.actionTaken,
        ...(hasStatus
          ? { result: `Tool statuses: ${step.toolCalls.map((call) => call.status ?? "unknown").join(", ")}` }
          : {}),
        toolCalls: step.toolCalls.map(({ step: _step, outputParts: _parts, callTimestampMs: _start, lastOutputTimestampMs: _end, ...call }) => call),
      };
    });

  return { messages, steps, unsupportedRecords };
}

function newStep(input: {
  sessionId: string;
  threadId: string;
  turnId: string;
  reasoningId: string;
  timestamp: string;
  ordinal: number;
}): StepBuilder {
  return {
    localStepId: `${input.sessionId}:${input.threadId}:${input.turnId}:${input.reasoningId}`,
    sourceReasoningId: input.reasoningId,
    threadId: input.threadId,
    turnId: input.turnId,
    timestamp: input.timestamp,
    ordinal: input.ordinal,
    reasoning: "",
    actionTaken: "",
    toolCalls: [],
    commentary: [],
  };
}

function completedMessage(
  payload: Record<string, unknown>,
  stream: { isRoot: boolean; threadId: string; timestamp: string; ordinal: number },
): CodexReplayMessage | undefined {
  if (!stream.isRoot || !isPlainObject(payload.item)) return undefined;
  const role = payload.item.type === "UserMessage"
    ? "user"
    : payload.item.type === "AgentMessage"
      ? "assistant"
      : undefined;
  if (role === undefined) return undefined;
  const content = completedItemText(payload.item.content).trim();
  if (content === "") return undefined;
  return {
    role,
    content,
    timestamp: stream.timestamp,
    ordinal: stream.ordinal,
    threadId: stream.threadId,
  };
}

function completedItemText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(isPlainObject)
    .filter((part) => String(part.type).toLowerCase() === "text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter((text) => text !== "")
    .join("\n");
}

function responseMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(isPlainObject)
    .filter((part) => part.type === "output_text" || part.type === "text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter((text) => text !== "")
    .join("\n");
}

function customOutputParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainObject)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter((text) => text !== "");
}

function serializedOutput(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(sortJson(value));
  return serialized ?? String(value ?? "");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function responseTurnId(item: Record<string, unknown>): string | undefined {
  return isPlainObject(item.internal_chat_message_metadata_passthrough)
    ? firstString(item.internal_chat_message_metadata_passthrough.turn_id)
    : undefined;
}

function callKey(
  sessionId: string,
  threadId: string,
  turnId: string,
  sourceCallId: string,
): string {
  return `${sessionId}\n${threadId}\n${turnId}\n${sourceCallId}`;
}

function normalizeStatus(
  toolName: string,
  output: string | undefined,
): CodexReplayStatus | undefined {
  if (output === undefined) return undefined;
  if (toolName === "wait_agent") {
    const decoded = decodeJson(output);
    if (isPlainObject(decoded) && decoded.timed_out === true) return "timeout";
  }
  if (output.startsWith("Script completed\n")) return "success";
  if (output.startsWith("Script failed\n")) return "failure";
  return undefined;
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function elapsedMilliseconds(
  start: number | undefined,
  end: number | undefined,
): number | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

function timestampMilliseconds(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteNumber(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

function compareTimelineEntry(
  left: { timestamp: string; threadId: string; ordinal: number },
  right: { timestamp: string; threadId: string; ordinal: number },
): number {
  return left.timestamp.localeCompare(right.timestamp)
    || left.threadId.localeCompare(right.threadId)
    || left.ordinal - right.ordinal;
}
```

Do not add recognition for nested `event_msg` tool representations. The collector intentionally recognizes those envelopes only enough to skip them without creating duplicate NAMS calls.

- [x] **Step 7: Run collector tests to verify GREEN**

Run: `node --import=tsx --test test/codex/codex-replay-collector.test.ts test/replay-files.test.ts`

Expected: PASS with all collector and filesystem tests.

- [x] **Step 8: Commit the collector**

```bash
git add src/platforms/codex/replay-model.ts src/platforms/codex/replay-collector.ts test/support/codex-rollout-fixture.ts test/codex/codex-replay-collector.test.ts
git commit -m "feat: assemble Codex replay sessions"
```

### Task 2: Private Temporary Replay Outbox

**Files:**
- Create: `src/platforms/codex/replay-outbox.ts`
- Create: `test/codex/codex-replay-outbox.test.ts`
- Modify: `src/platforms/codex/replay-model.ts`
- Existing helper: `src/runtime/permissions.ts`

**Interfaces:**
- Consumes: `CodexReplaySession[]`, `ensurePrivateDirectory()`, and `writePrivateFile()`.
- Produces: `CodexReplayOutboxRecord`, `CodexReplayOutbox`, `createCodexReplayOutbox(input)`, `readCodexReplayOutbox(path)`, and `removeCodexReplayOutbox(outbox)`.

- [x] **Step 1: Write failing outbox order and permission tests**

Create `test/codex/codex-replay-outbox.test.ts` with this complete test file:

```ts
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CodexReplaySession } from "../../src/platforms/codex/replay-model.js";
import {
  createCodexReplayOutbox,
  readCodexReplayOutbox,
  removeCodexReplayOutbox,
} from "../../src/platforms/codex/replay-outbox.js";

test("writes a private deterministic outbox and removes it", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-outbox-test-"));
  const temporaryRoot = path.join(fixture, "temporary-root");
  await mkdir(temporaryRoot);
  const sessions: CodexReplaySession[] = [{
    sourceSessionId: "session-1",
    projectDirectory: "/project",
    sourceStartedAt: "2026-08-26T12:00:00.000Z",
    messages: [{
      role: "user",
      content: "Build it.",
      timestamp: "2026-08-26T12:00:01.000Z",
      ordinal: 1,
      threadId: "thread-1",
    }],
    steps: [{
      localStepId: "session-1:thread-1:turn-1:reasoning-1",
      sourceReasoningId: "reasoning-1",
      threadId: "thread-1",
      turnId: "turn-1",
      timestamp: "2026-08-26T12:00:02.000Z",
      ordinal: 2,
      reasoning: "Visible operation",
      actionTaken: "Ran 2 tool calls: exec, wait_agent",
      result: "Tool statuses: success, timeout",
      toolCalls: [
        {
          sourceCallId: "call-1",
          toolName: "exec",
          input: "pwd",
          output: "Script completed\nOutput:\n/project",
          status: "success",
          timestamp: "2026-08-26T12:00:03.000Z",
          ordinal: 3,
        },
        {
          sourceCallId: "call-2",
          toolName: "wait_agent",
          input: { namespace: "collaboration", input: { timeout_ms: 1000 } },
          output: "{\"timed_out\":true}",
          status: "timeout",
          durationMs: 25,
          timestamp: "2026-08-26T12:00:04.000Z",
          ordinal: 4,
        },
      ],
    }],
  }];

  const outbox = await createCodexReplayOutbox({ sessions, temporaryRoot });
  try {
    const records = await readCodexReplayOutbox(outbox.path);
    assert.deepEqual(records.map((record) => record.kind), [
      "conversation.create",
      "message.add",
      "reasoningStep.create",
      "toolCall.create",
      "toolCall.create",
    ]);
    assert.equal((await stat(outbox.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(outbox.path)).mode & 0o777, 0o600);
    assert.equal(outbox.path.startsWith(temporaryRoot), true);
    assert.equal(outbox.recordCount, 5);
    const toolRecords = records.filter((record) => record.kind === "toolCall.create");
    assert.deepEqual(
      toolRecords.map((record) => record.localStepId),
      ["session-1:thread-1:turn-1:reasoning-1", "session-1:thread-1:turn-1:reasoning-1"],
    );
  } finally {
    await removeCodexReplayOutbox(outbox);
    await rm(fixture, { recursive: true, force: true });
  }
  await assert.rejects(access(outbox.directory), { code: "ENOENT" });
});

test("rejects an invalid outbox record with its line number", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-outbox-invalid-"));
  try {
    const outboxPath = path.join(fixture, "outbox.jsonl");
    await writeFile(outboxPath, [
      JSON.stringify({
        kind: "conversation.create",
        localConversationId: "conversation:session-1",
        sourceSessionId: "session-1",
        projectDirectory: "/project",
      }),
      JSON.stringify({ kind: "unknown" }),
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    await assert.rejects(
      readCodexReplayOutbox(outboxPath),
      new Error("Invalid Codex replay outbox record at line 2"),
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run the outbox tests to verify RED**

Run: `node --import=tsx --test test/codex/codex-replay-outbox.test.ts`

Expected: FAIL because the outbox module and record types do not exist.

- [x] **Step 3: Add the logical outbox record types**

Append to `src/platforms/codex/replay-model.ts`:

```ts
export type CodexReplayOutboxRecord =
  | {
      kind: "conversation.create";
      localConversationId: string;
      sourceSessionId: string;
      projectDirectory: string;
      sourceStartedAt?: string;
    }
  | {
      kind: "message.add";
      localConversationId: string;
      role: "user" | "assistant";
      content: string;
    }
  | {
      kind: "reasoningStep.create";
      localConversationId: string;
      localStepId: string;
      reasoning: string;
      actionTaken: string;
      result?: string;
    }
  | {
      kind: "toolCall.create";
      localStepId: string;
      toolName: string;
      input: unknown;
      output?: string;
      status?: CodexReplayStatus;
      durationMs?: number;
    };

export interface CodexReplayOutbox {
  directory: string;
  path: string;
  recordCount: number;
}

export interface CreateCodexReplayOutboxInput {
  sessions: CodexReplaySession[];
  temporaryRoot?: string;
}
```

- [x] **Step 4: Implement deterministic operation projection**

Create `src/platforms/codex/replay-outbox.ts` with this complete implementation:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CodexReplayOutbox,
  type CodexReplayOutboxRecord,
  type CodexReplaySession,
  type CodexReplayStatus,
  type CreateCodexReplayOutboxInput,
} from "./replay-model.js";
import {
  ensurePrivateDirectory,
  writePrivateFile,
} from "../../runtime/permissions.js";

export function codexReplayOutboxRecords(
  sessions: CodexReplaySession[],
): CodexReplayOutboxRecord[] {
  const records: CodexReplayOutboxRecord[] = [];
  for (const session of sessions) {
    const localConversationId = `conversation:${session.sourceSessionId}`;
    records.push({
      kind: "conversation.create",
      localConversationId,
      sourceSessionId: session.sourceSessionId,
      projectDirectory: session.projectDirectory,
      ...(session.sourceStartedAt !== undefined
        ? { sourceStartedAt: session.sourceStartedAt }
        : {}),
    });
    const timeline = [
      ...session.messages.map((message) => ({ kind: "message" as const, value: message })),
      ...session.steps.map((step) => ({ kind: "step" as const, value: step })),
    ].sort((left, right) =>
      left.value.timestamp.localeCompare(right.value.timestamp)
      || left.value.threadId.localeCompare(right.value.threadId)
      || left.value.ordinal - right.value.ordinal
    );
    for (const entry of timeline) {
      if (entry.kind === "message") {
        records.push({
          kind: "message.add",
          localConversationId,
          role: entry.value.role,
          content: entry.value.content,
        });
        continue;
      }
      records.push({
        kind: "reasoningStep.create",
        localConversationId,
        localStepId: entry.value.localStepId,
        reasoning: entry.value.reasoning,
        actionTaken: entry.value.actionTaken,
        ...(entry.value.result !== undefined ? { result: entry.value.result } : {}),
      });
      for (const call of entry.value.toolCalls) {
        records.push({
          kind: "toolCall.create",
          localStepId: entry.value.localStepId,
          toolName: call.toolName,
          input: call.input,
          ...(call.output !== undefined ? { output: call.output } : {}),
          ...(call.status !== undefined ? { status: call.status } : {}),
          ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
        });
      }
    }
  }
  return records;
}

export async function createCodexReplayOutbox(
  input: CreateCodexReplayOutboxInput,
): Promise<CodexReplayOutbox> {
  const records = codexReplayOutboxRecords(input.sessions);
  const contents = records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(
      input.temporaryRoot ?? tmpdir(),
      "nams-hooks-codex-replay-",
    ));
    await ensurePrivateDirectory(directory);
    const outboxPath = path.join(directory, "outbox.jsonl");
    await writePrivateFile(outboxPath, contents);
    return { directory, path: outboxPath, recordCount: records.length };
  } catch {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new Error("Unable to create Codex replay outbox");
  }
}

export async function readCodexReplayOutbox(
  outboxPath: string,
): Promise<CodexReplayOutboxRecord[]> {
  let contents: string;
  try {
    contents = await readFile(outboxPath, "utf8");
  } catch {
    throw new Error("Unable to read Codex replay outbox");
  }
  const records: CodexReplayOutboxRecord[] = [];
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(lines[index]);
      if (!isCodexReplayOutboxRecord(parsed)) throw new Error("invalid");
      records.push(parsed);
    } catch {
      throw new Error(`Invalid Codex replay outbox record at line ${index + 1}`);
    }
  }
  return records;
}

export async function removeCodexReplayOutbox(
  outbox: CodexReplayOutbox,
): Promise<void> {
  if (
    path.dirname(outbox.path) !== outbox.directory
    || path.basename(outbox.path) !== "outbox.jsonl"
    || !path.basename(outbox.directory).startsWith("nams-hooks-codex-replay-")
  ) {
    throw new Error("Invalid Codex replay outbox cleanup handle");
  }
  try {
    await rm(outbox.directory, { recursive: true, force: true });
  } catch {
    throw new Error("Unable to remove Codex replay outbox");
  }
}

const statuses = new Set<CodexReplayStatus>([
  "pending",
  "success",
  "failure",
  "error",
  "timeout",
  "cancelled",
]);

function isCodexReplayOutboxRecord(value: unknown): value is CodexReplayOutboxRecord {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "conversation.create") {
    return hasStrings(value, [
      "localConversationId",
      "sourceSessionId",
      "projectDirectory",
    ]) && optionalString(value.sourceStartedAt);
  }
  if (value.kind === "message.add") {
    return hasStrings(value, ["localConversationId", "content"])
      && (value.role === "user" || value.role === "assistant");
  }
  if (value.kind === "reasoningStep.create") {
    return hasStrings(value, [
      "localConversationId",
      "localStepId",
      "reasoning",
      "actionTaken",
    ]) && optionalString(value.result);
  }
  if (value.kind === "toolCall.create") {
    return hasStrings(value, ["localStepId", "toolName"])
      && Object.hasOwn(value, "input")
      && optionalString(value.output)
      && (value.status === undefined
        || (typeof value.status === "string" && statuses.has(value.status as CodexReplayStatus)))
      && (value.durationMs === undefined
        || (typeof value.durationMs === "number" && Number.isFinite(value.durationMs)));
  }
  return false;
}

function hasStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === "string" && value[key].trim() !== "");
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

This projection intentionally omits raw timestamps, thread IDs, source call IDs, and encrypted reasoning from the NAMS-facing records. Its generic I/O errors do not disclose the temporary path.

- [x] **Step 5: Run outbox tests to verify GREEN**

Run: `node --import=tsx --test test/codex/codex-replay-outbox.test.ts`

Expected: PASS with the operation-order, permission, validation, and cleanup tests.

- [x] **Step 6: Commit the temporary outbox**

```bash
git add src/platforms/codex/replay-model.ts src/platforms/codex/replay-outbox.ts test/codex/codex-replay-outbox.test.ts
git commit -m "feat: materialize private Codex replay outbox"
```

### Task 3: Fail-Fast NAMS Outbox Sender

**Files:**
- Create: `src/platforms/codex/replay-sender.ts`
- Create: `test/codex/codex-replay-sender.test.ts`
- Create: `test/support/nams-replay-environment.ts`
- Modify: `src/runtime/provenance.ts`
- Modify: `test/provenance.test.ts`
- Existing: `src/generated/nams-client.ts`
- Existing: `src/runtime/config.ts`
- Existing: `src/runtime/memory-service.ts`
- Existing: `src/runtime/workspace-configuration.ts`
- Existing: `test/support/nams-fetch-mock.ts`

**Interfaces:**
- Consumes: a complete outbox path, import root, generated `NamsClient`/`NamsWorkspaceClient`, `loadNamsConnectionConfig()`, `validWorkspaces()`, `serializeToolInput()`, and `serializeToolOutput()`.
- Produces: `sendCodexReplayOutbox(input: SendCodexReplayOutboxInput): Promise<CodexReplaySendSummary>`.

- [x] **Step 1: Write the failing sequential-delivery test**

Create `test/support/nams-replay-environment.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const keys = [
  "HOME",
  "CODEX_HOME",
  "NAMS_API_KEY",
  "NAMS_WORKSPACE_ID",
  "NAMS_BASE_URL",
] as const;

export async function withNamsReplayEnvironment<T>(
  callback: (fixture: string) => Promise<T>,
  overrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<T> {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-replay-env-"));
  const saved = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof keys)[number], string | undefined>;
  Object.assign(process.env, {
    HOME: fixture,
    CODEX_HOME: path.join(fixture, ".codex"),
    NAMS_API_KEY: "key",
    NAMS_WORKSPACE_ID: "workspace-1",
    NAMS_BASE_URL: "https://memory.example.test",
    ...overrides,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
  try {
    return await callback(fixture);
  } finally {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(fixture, { recursive: true, force: true });
  }
}
```

Create `test/codex/codex-replay-sender.test.ts`:

```ts
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { CodexReplayOutboxRecord } from "../../src/platforms/codex/replay-model.js";
import { sendCodexReplayOutbox } from "../../src/platforms/codex/replay-sender.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";
import { withNamsReplayEnvironment } from "../support/nams-replay-environment.js";

async function writeOutbox(
  fixture: string,
  records: CodexReplayOutboxRecord[],
): Promise<string> {
  const directory = path.join(fixture, "outbox-fixture");
  const outboxPath = path.join(directory, "outbox.jsonl");
  await mkdir(directory, { recursive: true });
  await writeFile(
    outboxPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return outboxPath;
}

function completeRecords(): CodexReplayOutboxRecord[] {
  return [
    {
      kind: "conversation.create",
      localConversationId: "conversation:session-1",
      sourceSessionId: "session-1",
      projectDirectory: "/project",
      sourceStartedAt: "2026-08-26T12:00:00.000Z",
    },
    {
      kind: "message.add",
      localConversationId: "conversation:session-1",
      role: "user",
      content: "Build it.",
    },
    {
      kind: "reasoningStep.create",
      localConversationId: "conversation:session-1",
      localStepId: "step:local-1",
      reasoning: "Visible operation",
      actionTaken: "Ran 2 tool calls: exec, wait_agent",
      result: "Tool statuses: success, timeout",
    },
    {
      kind: "toolCall.create",
      localStepId: "step:local-1",
      toolName: "exec",
      input: { command: "pwd", output: "strip this field" },
      output: "Script completed\nOutput:\nfirst second",
      status: "success",
    },
    {
      kind: "toolCall.create",
      localStepId: "step:local-1",
      toolName: "wait_agent",
      input: { namespace: "collaboration", input: { timeout_ms: 1000 } },
      output: "{\"timed_out\":true}",
      status: "timeout",
      durationMs: 25,
    },
  ];
}

test("sends a complete outbox sequentially with shared remote step ids", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock()
      .createConversation({ id: "conversation-1" })
      .message()
      .reasoningStep({ id: "step-1" })
      .toolCall();
    const outboxPath = await writeOutbox(fixture, completeRecords());

    const summary = await sendCodexReplayOutbox({
      outboxPath,
      importRoot: "/project",
      fetch: nams.fetch,
    });

    assert.deepEqual(summary, {
      conversations: 1,
      messages: 1,
      reasoningSteps: 1,
      toolCalls: 2,
    });
    assert.deepEqual(nams.calls().map((call) => new URL(call.url).pathname), [
      "/v1/conversations",
      "/v1/conversations/conversation-1/messages",
      "/v1/reasoning/steps",
      "/v1/reasoning/tool-calls",
      "/v1/reasoning/tool-calls",
    ]);
    assert.deepEqual(nams.requestBodies("createConversation")[0].metadata, {
      harness: "codex",
      projectDirectory: "/project",
      sourceSessionId: "session-1",
      importSource: "nams-hooks-replay",
      sourceStartedAt: "2026-08-26T12:00:00.000Z",
    });
    assert.deepEqual(nams.requestBodies("addReasoningStep"), [{
      conversationId: "conversation-1",
      reasoning: "Visible operation",
      actionTaken: "Ran 2 tool calls: exec, wait_agent",
      result: "Tool statuses: success, timeout",
    }]);
    assert.deepEqual(
      nams.requestBodies("addToolCall").map((body) => body.stepId),
      ["step-1", "step-1"],
    );
    assert.equal(nams.requestBodies("addToolCall")[0].input, "{\"command\":\"pwd\"}");
    assert.equal(
      nams.requestBodies("addToolCall")[0].output,
      "Script completed\nOutput:\nfirst second",
    );
  });
});

test("stops on the first failed write without retry or state files", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock()
      .createConversation({ id: "conversation-1" })
      .message({ error: "failed" }, 500)
      .reasoningStep({ id: "step-1" })
      .toolCall();
    const outboxPath = await writeOutbox(fixture, completeRecords());

    await assert.rejects(
      sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
      new Error("NAMS request failed during Codex replay"),
    );

    assert.equal(nams.calls().length, 2);
    assert.equal(nams.calls("addMessage").length, 1);
    assert.equal(nams.calls("addReasoningStep").length, 0);
    assert.equal(nams.calls("addToolCall").length, 0);
    await assert.rejects(access(path.join(fixture, ".nams", "state")), { code: "ENOENT" });
    await assert.rejects(access(path.join(fixture, ".nams", "logs")), { code: "ENOENT" });
  });
});

test("uses an explicit workspace without listing workspaces", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock().createConversation();
    const outboxPath = await writeOutbox(fixture, [completeRecords()[0]]);
    await sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch });
    assert.equal(nams.calls("listMyWorkspaces").length, 0);
    assert.equal(nams.calls("createConversation").length, 1);
  });
});

test("auto-selects exactly one available workspace", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock()
      .workspaces({ workspaces: [{ id: "workspace-auto", name: "Auto" }] })
      .createConversation();
    const outboxPath = await writeOutbox(fixture, [completeRecords()[0]]);
    await sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch });
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 1);
  }, { NAMS_WORKSPACE_ID: undefined });
});

test("rejects zero or multiple available workspaces", async (context) => {
  await context.test("zero", async () => {
    await withNamsReplayEnvironment(async (fixture) => {
      const nams = createNamsFetchMock().workspaces({ workspaces: [] });
      const outboxPath = await writeOutbox(fixture, [completeRecords()[0]]);
      await assert.rejects(
        sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
        new Error("No NAMS workspace is available for replay"),
      );
    }, { NAMS_WORKSPACE_ID: undefined });
  });
  await context.test("multiple", async () => {
    await withNamsReplayEnvironment(async (fixture) => {
      const nams = createNamsFetchMock().workspaces({
        workspaces: [{ id: "one" }, { id: "two" }],
      });
      const outboxPath = await writeOutbox(fixture, [completeRecords()[0]]);
      await assert.rejects(
        sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
        new Error("NAMS workspace selection is required before replay"),
      );
    }, { NAMS_WORKSPACE_ID: undefined });
  });
});

test("validates the complete outbox before any remote request", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock().all({ error: "must not be called" }, 500);
    const directory = path.join(fixture, "invalid-outbox");
    const outboxPath = path.join(directory, "outbox.jsonl");
    await mkdir(directory, { recursive: true });
    await writeFile(outboxPath, "{not json\n", "utf8");
    await assert.rejects(
      sendCodexReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
      new Error("Invalid Codex replay outbox record at line 1"),
    );
    assert.equal(nams.calls().length, 0);
  });
});
```

- [x] **Step 2: Run sender tests to verify RED**

Run: `node --import=tsx --test test/codex/codex-replay-sender.test.ts test/provenance.test.ts`

Expected: FAIL because the sender does not exist and replay provenance still accepts generic platforms.

- [x] **Step 3: Make replay provenance Codex-specific**

In `src/runtime/provenance.ts`, remove the `ReplayPlatform` import and replace the replay function with:

```ts
export function namsReplayProvenanceHeaders(): Record<string, string> {
  return {
    ...baseProvenanceHeaders("codex"),
    "X-NAMS-Hooks-Command": "replay",
  };
}
```

Update `test/provenance.test.ts` to call it without arguments and assert harness `codex`, command `replay`, and no hook-event header.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { namsReplayProvenanceHeaders } from "../src/runtime/provenance.js";

test("Codex replay provenance identifies the command without a hook event", () => {
  const headers = namsReplayProvenanceHeaders();
  assert.equal(headers["X-NAMS-Hooks-Harness"], "codex");
  assert.equal(headers["X-NAMS-Hooks-Command"], "replay");
  assert.equal(headers["X-NAMS-Hooks-Event"], undefined);
});
```

- [x] **Step 4: Implement the fail-fast sender**

Create `src/platforms/codex/replay-sender.ts` with the complete sender below. It validates the entire outbox before configuration can cause a workspace-list request, resolves the destination once, and converts transport/HTTP errors into a content-free failure:

```ts
import path from "node:path";
import {
  NamsClient,
  NamsWorkspaceClient,
  type NamsRequestEvent,
  type RecordToolCallRequest,
  type WorkspaceListResponse,
} from "../../generated/nams-client.js";
import {
  loadNamsConnectionConfig,
  type NamsConnectionConfigLoadResult,
} from "../../runtime/config.js";
import {
  serializeToolInput,
  serializeToolOutput,
} from "../../runtime/memory-service.js";
import { namsReplayProvenanceHeaders } from "../../runtime/provenance.js";
import { validWorkspaces } from "../../runtime/workspace-configuration.js";
import { readCodexReplayOutbox } from "./replay-outbox.js";

export interface SendCodexReplayOutboxInput {
  outboxPath: string;
  importRoot: string;
  fetch?: typeof fetch;
  onProgress?: (line: string) => void;
}

export interface CodexReplaySendSummary {
  conversations: number;
  messages: number;
  reasoningSteps: number;
  toolCalls: number;
}

interface ResolvedDestination {
  apiKey: string;
  workspaceId: string;
  baseUrl: string;
}

export async function sendCodexReplayOutbox(
  input: SendCodexReplayOutboxInput,
): Promise<CodexReplaySendSummary> {
  const records = await readCodexReplayOutbox(input.outboxPath);
  const onRequest = (event: NamsRequestEvent): void => {
    input.onProgress?.(`  - ${event.method} ${event.path}`);
  };
  const destination = await resolveDestination(input, onRequest);
  const client = new NamsClient({
    ...destination,
    defaultHeaders: namsReplayProvenanceHeaders(),
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    onRequest,
  });
  const conversationIds = new Map<string, string>();
  const stepIds = new Map<string, string>();
  const summary: CodexReplaySendSummary = {
    conversations: 0,
    messages: 0,
    reasoningSteps: 0,
    toolCalls: 0,
  };

  for (const record of records) {
    if (record.kind === "conversation.create") {
      const response = await namsRequest(() => client.createConversation({
        metadata: {
          harness: "codex",
          projectDirectory: record.projectDirectory,
          sourceSessionId: record.sourceSessionId,
          importSource: "nams-hooks-replay",
          ...(record.sourceStartedAt !== undefined
            ? { sourceStartedAt: record.sourceStartedAt }
            : {}),
        },
      }));
      const conversationId = requiredId(
        response.id,
        "NAMS conversation response did not include id",
      );
      conversationIds.set(record.localConversationId, conversationId);
      summary.conversations += 1;
      continue;
    }

    if (record.kind === "message.add") {
      const conversationId = conversationIds.get(record.localConversationId);
      if (conversationId === undefined) {
        throw new Error(
          `Codex replay outbox references an unknown conversation: ${record.localConversationId}`,
        );
      }
      await namsRequest(() => client.addMessage(conversationId, {
        role: record.role,
        content: record.content,
      }));
      summary.messages += 1;
      continue;
    }

    if (record.kind === "reasoningStep.create") {
      const conversationId = conversationIds.get(record.localConversationId);
      if (conversationId === undefined) {
        throw new Error(
          `Codex replay outbox references an unknown conversation: ${record.localConversationId}`,
        );
      }
      const response = await namsRequest(() => client.recordReasoningStep({
        conversationId,
        reasoning: record.reasoning,
        actionTaken: record.actionTaken,
        ...(record.result !== undefined ? { result: record.result } : {}),
      }));
      const stepId = requiredId(
        response.id,
        "NAMS reasoning response did not include id",
      );
      stepIds.set(record.localStepId, stepId);
      summary.reasoningSteps += 1;
      continue;
    }

    const stepId = stepIds.get(record.localStepId);
    if (stepId === undefined) {
      throw new Error(
        `Codex replay outbox references an unknown reasoning step: ${record.localStepId}`,
      );
    }
    const toolRequest: RecordToolCallRequest = {
      stepId,
      toolName: record.toolName,
      input: serializeToolInput(record.input),
      ...(record.output !== undefined
        ? { output: serializeToolOutput(record.output) }
        : {}),
      ...(record.status !== undefined ? { status: record.status } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    };
    await namsRequest(() => client.recordToolCall(toolRequest));
    summary.toolCalls += 1;
  }

  return summary;
}

async function resolveDestination(
  input: SendCodexReplayOutboxInput,
  onRequest: (event: NamsRequestEvent) => void,
): Promise<ResolvedDestination> {
  let connection: NamsConnectionConfigLoadResult;
  try {
    connection = await loadNamsConnectionConfig(path.resolve(input.importRoot));
  } catch {
    throw new Error("NAMS replay configuration unavailable");
  }
  if (!connection.ok) {
    throw new Error(`NAMS replay configuration unavailable: ${connection.reason}`);
  }
  if (connection.config.workspaceId !== undefined) {
    return {
      apiKey: connection.config.apiKey,
      workspaceId: connection.config.workspaceId,
      baseUrl: connection.config.baseUrl,
    };
  }

  const workspaceClient = new NamsWorkspaceClient({
    apiKey: connection.config.apiKey,
    baseUrl: connection.config.baseUrl,
    defaultHeaders: namsReplayProvenanceHeaders(),
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    onRequest,
  });
  let response: WorkspaceListResponse;
  try {
    response = await workspaceClient.listMyWorkspaces();
  } catch {
    throw new Error("NAMS workspace resolution failed for replay");
  }
  const workspaces = validWorkspaces(response.workspaces);
  if (workspaces.length === 0) {
    throw new Error("No NAMS workspace is available for replay");
  }
  if (workspaces.length !== 1) {
    throw new Error("NAMS workspace selection is required before replay");
  }
  return {
    apiKey: connection.config.apiKey,
    workspaceId: workspaces[0].id,
    baseUrl: connection.config.baseUrl,
  };
}

async function namsRequest<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error("NAMS request failed during Codex replay");
  }
}

function requiredId(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === "") throw new Error(message);
  return value;
}
```

- [x] **Step 5: Run sender tests to verify GREEN**

Run: `node --import=tsx --test test/codex/codex-replay-sender.test.ts test/provenance.test.ts`

Expected: PASS with sequential delivery, shared step IDs, fail-fast/no-retry, workspace resolution, provenance, and no-state tests.

- [x] **Step 6: Commit the sender**

```bash
git add src/platforms/codex/replay-sender.ts src/runtime/provenance.ts test/support/nams-replay-environment.ts test/codex/codex-replay-sender.test.ts test/provenance.test.ts
git commit -m "feat: send Codex replay outbox fail fast"
```

### Task 4: Codex Runner, CLI Cutover, And Claude Replay Removal

**Files:**
- Create: `src/platforms/codex/replay-runner.ts`
- Create: `test/codex/codex-replay-runner.test.ts`
- Modify: `src/platforms/codex/index.ts`
- Modify: `src/platforms/claude/index.ts`
- Modify: `src/platforms/index.ts`
- Modify: `src/interfaces.ts`
- Modify: `src/cli.ts`
- Modify: `test/cli-replay.test.ts`
- Modify: `test/architecture.test.ts`
- Delete: `src/platforms/claude/replay.ts`
- Delete: `src/platforms/codex/replay.ts`
- Delete: `src/runtime/replay.ts`
- Delete: `test/claude/claude-replay.test.ts`
- Delete: `test/codex/codex-replay.test.ts`
- Delete: `test/replay-runtime.test.ts`

**Interfaces:**
- Consumes: the collector, temporary outbox, and sender interfaces from Tasks 1-3.
- Produces: `runCodexReplay(input: RunCodexReplayInput): Promise<CodexReplayRunSummary>` and public CLI command `nams-hooks replay codex [--working-dir PATH]`.

- [x] **Step 1: Write failing runner lifecycle tests**

Create `test/codex/codex-replay-runner.test.ts` with real rollout files and no collector/outbox mocks:

```ts
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runCodexReplay } from "../../src/platforms/codex/replay-runner.js";
import {
  completedItem,
  jsonl,
  responseItem,
  sessionMeta,
  taskComplete,
} from "../support/codex-rollout-fixture.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";
import { withNamsReplayEnvironment } from "../support/nams-replay-environment.js";

async function writeRunnerRollouts(fixture: string): Promise<{
  project: string;
  temporaryRoot: string;
}> {
  const project = path.join(fixture, "project");
  const temporaryRoot = path.join(fixture, "outboxes");
  const sessionsRoot = path.join(process.env.CODEX_HOME as string, "sessions", "2026", "08");
  const rootPath = path.join(sessionsRoot, "root.jsonl");
  const childPath = path.join(sessionsRoot, "subagents", "child.jsonl");
  await mkdir(path.dirname(childPath), { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  await writeFile(rootPath, jsonl([
    sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
    completedItem(1, "thread-root", "turn-1", {
      type: "UserMessage",
      content: [{ type: "text", text: "Build it." }],
    }),
    responseItem(2, "turn-1", {
      type: "reasoning",
      id: "reasoning-1",
      summary: [],
      encrypted_content: "private",
    }),
    responseItem(3, "turn-1", {
      type: "custom_tool_call",
      call_id: "call-1",
      name: "exec",
      input: "pwd",
    }),
    responseItem(4, "turn-1", {
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: [
        { type: "input_text", text: "Script completed\nOutput:\n" },
        { type: "input_text", text: project },
      ],
    }),
    taskComplete(5, "thread-root", "turn-1"),
  ]), "utf8");
  await writeFile(childPath, jsonl([
    sessionMeta({
      sessionId: "session-1",
      threadId: "thread-child",
      cwd: project,
      threadSource: "subagent",
    }),
  ]), "utf8");
  return { project, temporaryRoot };
}

test("imports one grouped session and cleans the successful outbox", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const { project, temporaryRoot } = await writeRunnerRollouts(fixture);
    const nams = createNamsFetchMock()
      .createConversation()
      .message()
      .reasoningStep()
      .toolCall();

    const summary = await runCodexReplay({
      importRoot: project,
      temporaryRoot,
      fetch: nams.fetch,
    });

    assert.deepEqual(summary, {
      discoveredFiles: 2,
      matchedFiles: 2,
      skippedFiles: 0,
      sessions: 1,
      conversations: 1,
      messages: 1,
      reasoningSteps: 1,
      toolCalls: 1,
      malformedLines: 0,
      unsupportedRecords: 0,
    });
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("stops on NAMS failure and still cleans the handled-run outbox", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const { project, temporaryRoot } = await writeRunnerRollouts(fixture);
    const nams = createNamsFetchMock()
      .createConversation()
      .message({ error: "failed" }, 500)
      .reasoningStep()
      .toolCall();

    await assert.rejects(
      runCodexReplay({ importRoot: project, temporaryRoot, fetch: nams.fetch }),
      new Error("NAMS request failed during Codex replay"),
    );
    assert.equal(nams.calls().length, 2);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("a fresh restart recreates and resends the complete outbox", async () => {
  await withNamsReplayEnvironment(async (fixture) => {
    const { project, temporaryRoot } = await writeRunnerRollouts(fixture);
    const nams = createNamsFetchMock()
      .createConversation()
      .message()
      .reasoningStep()
      .toolCall();

    await runCodexReplay({ importRoot: project, temporaryRoot, fetch: nams.fetch });
    await runCodexReplay({ importRoot: project, temporaryRoot, fetch: nams.fetch });

    assert.equal(nams.calls("createConversation").length, 2);
    assert.equal(nams.calls("addMessage").length, 2);
    assert.equal(nams.calls("addReasoningStep").length, 2);
    assert.equal(nams.calls("addToolCall").length, 2);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});
```

- [x] **Step 2: Write failing Codex-only CLI tests**

Replace `test/cli-replay.test.ts` with this complete Codex-only test file:

```ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  completedItem,
  jsonl,
  responseItem,
  sessionMeta,
  taskComplete,
} from "./support/codex-rollout-fixture.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, ".build", "tsc", "cli.js");

interface CliResult { code: number | null; stdout: string; stderr: string }
interface CapturedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

async function withNamsServer<T>(
  handler: (baseUrl: string, requests: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void handleRequest(request, response, requests);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    return await handler(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    );
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: CapturedRequest[],
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  requests.push({
    path: pathname,
    headers: request.headers,
    body: text === "" ? undefined : JSON.parse(text),
  });
  if (request.method === "POST" && pathname === "/v1/conversations") {
    return json(response, 201, { id: "conversation-1" });
  }
  if (
    request.method === "POST"
    && pathname === "/v1/conversations/conversation-1/messages"
  ) {
    return json(response, 201, { id: "message-1" });
  }
  if (request.method === "POST" && pathname === "/v1/reasoning/steps") {
    return json(response, 201, { id: "step-1" });
  }
  if (request.method === "POST" && pathname === "/v1/reasoning/tool-calls") {
    return json(response, 201, { id: "tool-1" });
  }
  json(response, 404, { error: "unexpected endpoint" });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin = "",
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test("replay codex groups root and subagent files without reading stdin", async () => {
  await withNamsServer(async (baseUrl, requests) => {
    const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-replay-"));
    try {
      const project = path.join(fixture, "project");
      const home = path.join(fixture, "home");
      const codexHome = path.join(fixture, "codex");
      const rootPath = path.join(codexHome, "sessions", "root.jsonl");
      const childPath = path.join(codexHome, "sessions", "subagents", "child.jsonl");
      await mkdir(project, { recursive: true });
      await mkdir(path.dirname(childPath), { recursive: true });
      await writeFile(rootPath, jsonl([
        sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
        completedItem(1, "thread-root", "turn-1", {
          type: "UserMessage",
          content: [{ type: "text", text: "Remember replay." }],
        }),
        responseItem(2, "turn-1", {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          encrypted_content: "do-not-store",
        }),
        responseItem(3, "turn-1", {
          type: "custom_tool_call",
          call_id: "call-1",
          name: "exec",
          input: "pwd",
        }),
        responseItem(4, "turn-1", {
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: [
            { type: "input_text", text: "Script completed\nOutput:\n" },
            { type: "input_text", text: project },
          ],
        }),
        taskComplete(5, "thread-root", "turn-1"),
      ]), "utf8");
      await writeFile(childPath, jsonl([
        sessionMeta({
          sessionId: "session-1",
          threadId: "thread-child",
          cwd: project,
          threadSource: "subagent",
        }),
      ]), "utf8");

      const result = await runCli(
        ["replay", "codex", "--working-dir", project],
        project,
        {
          HOME: home,
          CODEX_HOME: codexHome,
          NAMS_API_KEY: "key",
          NAMS_WORKSPACE_ID: "workspace-1",
          NAMS_BASE_URL: baseUrl,
        },
        "{not-json",
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stdout,
        /Replay codex: discovered files 2, matched files 2, skipped files 0, sessions 1/,
      );
      assert.deepEqual(requests.map((request) => request.path), [
        "/v1/conversations",
        "/v1/conversations/conversation-1/messages",
        "/v1/reasoning/steps",
        "/v1/reasoning/tool-calls",
      ]);
      assert.equal(requests[0].headers["x-nams-hooks-harness"], "codex");
      assert.equal(requests[0].headers["x-nams-hooks-command"], "replay");
      assert.equal(requests[0].headers["x-nams-hooks-event"], undefined);
      assert.doesNotMatch(result.stderr, /outbox\.jsonl|nams-hooks-codex-replay-/);
      await assert.rejects(access(path.join(home, ".nams", "state")), { code: "ENOENT" });
      await assert.rejects(access(path.join(home, ".nams", "logs")), { code: "ENOENT" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

test("replay defaults the import root to the child cwd", async () => {
  await withNamsServer(async (baseUrl) => {
    const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-replay-")));
    try {
      const codexHome = path.join(fixture, "codex");
      const rolloutPath = path.join(codexHome, "sessions", "rollout.jsonl");
      await mkdir(path.dirname(rolloutPath), { recursive: true });
      await writeFile(rolloutPath, jsonl([
        sessionMeta({ sessionId: "session-1", cwd: fixture, threadSource: "user" }),
      ]), "utf8");
      const result = await runCli(["replay", "codex"], fixture, {
        HOME: path.join(fixture, "home"),
        CODEX_HOME: codexHome,
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: baseUrl,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /matched files 1, skipped files 0, sessions 1/);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

test("replay rejects Claude and malformed arguments", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-replay-"));
  try {
    for (const args of [
      ["replay", "claude"],
      ["replay", "gemini"],
      ["replay", "codex", "--working-dir"],
      ["replay", "codex", "--working-dir", ""],
      ["replay", "codex", `--working-dir=${fixture}`],
      ["replay", "codex", "--working-dir", fixture, "extra"],
    ]) {
      const result = await runCli(args, fixture, {});
      assert.equal(result.code, 1);
      assert.match(result.stderr, /nams-hooks replay codex \[--working-dir PATH\]/);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a missing Codex transcript root is a successful zero import", async () => {
  await withNamsServer(async (baseUrl, requests) => {
    const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-replay-"));
    try {
      const result = await runCli(["replay", "codex"], fixture, {
        HOME: path.join(fixture, "home"),
        CODEX_HOME: path.join(fixture, "missing-codex-home"),
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: baseUrl,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /discovered files 0, matched files 0, skipped files 0, sessions 0/);
      assert.deepEqual(requests, []);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 3: Replace the replay architecture assertion**

Replace the existing static Claude/Codex replay-registry test in `test/architecture.test.ts` with:

```ts
test("replay is Codex-only and does not use the live adapter registry", async () => {
  const platformIndex = await readFile("src/platforms/index.ts", "utf8");
  const claudeIndex = await readFile("src/platforms/claude/index.ts", "utf8");
  const codexIndex = await readFile("src/platforms/codex/index.ts", "utf8");
  const interfaces = await readFile("src/interfaces.ts", "utf8");

  assert.doesNotMatch(platformIndex, /ReplayPlatform|ReplayPlatformAdapter|replayAdapters|claudeReplayAdapter|codexReplayAdapter/);
  assert.doesNotMatch(claudeIndex, /claudeReplayAdapter|\.\/replay\.js/);
  assert.match(codexIndex, /export\s+\{\s*runCodexReplay\s*\}\s+from\s+["']\.\/replay-runner\.js["']/);
  assert.doesNotMatch(interfaces, /ReplayPlatform|ReplayPlatformAdapter|ReplayTranscript|ReplayRecord/);
});
```

- [x] **Step 4: Run runner, CLI, and architecture tests to verify RED**

Run: `npm run build && node --import=tsx --test test/codex/codex-replay-runner.test.ts test/cli-replay.test.ts test/architecture.test.ts`

Expected: FAIL because the runner is absent, Claude replay is still accepted, and the old registry/contracts remain.

- [x] **Step 5: Implement the end-to-end runner and summary**

Create `src/platforms/codex/replay-runner.ts` with:

```ts
import { collectCodexReplaySessions } from "./replay-collector.js";
import {
  createCodexReplayOutbox,
  removeCodexReplayOutbox,
} from "./replay-outbox.js";
import { sendCodexReplayOutbox } from "./replay-sender.js";

export interface RunCodexReplayInput {
  importRoot: string;
  env?: NodeJS.ProcessEnv;
  temporaryRoot?: string;
  fetch?: typeof fetch;
  onProgress?: (line: string) => void;
}

export interface CodexReplayRunSummary {
  discoveredFiles: number;
  matchedFiles: number;
  skippedFiles: number;
  sessions: number;
  conversations: number;
  messages: number;
  reasoningSteps: number;
  toolCalls: number;
  malformedLines: number;
  unsupportedRecords: number;
}

export async function runCodexReplay(
  input: RunCodexReplayInput,
): Promise<CodexReplayRunSummary> {
  const collection = await collectCodexReplaySessions({
    importRoot: input.importRoot,
    ...(input.env !== undefined ? { env: input.env } : {}),
  });
  const outbox = await createCodexReplayOutbox({
    sessions: collection.sessions,
    ...(input.temporaryRoot !== undefined ? { temporaryRoot: input.temporaryRoot } : {}),
  });
  try {
    const sent = collection.sessions.length === 0
      ? { conversations: 0, messages: 0, reasoningSteps: 0, toolCalls: 0 }
      : await sendCodexReplayOutbox({
          outboxPath: outbox.path,
          importRoot: input.importRoot,
          ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
          ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
        });
    return {
      discoveredFiles: collection.discoveredFiles,
      matchedFiles: collection.matchedFiles,
      skippedFiles: collection.skippedFiles,
      sessions: collection.sessions.length,
      ...sent,
      malformedLines: collection.malformedLines,
      unsupportedRecords: collection.unsupportedRecords,
    };
  } finally {
    await removeCodexReplayOutbox(outbox);
  }
}

export function formatCodexReplaySummary(summary: CodexReplayRunSummary): string {
  return [
    `Replay codex: discovered files ${summary.discoveredFiles}, matched files ${summary.matchedFiles}, skipped files ${summary.skippedFiles}, sessions ${summary.sessions};`,
    `conversations ${summary.conversations}, messages ${summary.messages}, steps ${summary.reasoningSteps}, tools ${summary.toolCalls}, malformed lines ${summary.malformedLines}, unsupported records ${summary.unsupportedRecords}.`,
  ].join(" ");
}
```

Do not catch sender failures or expose the outbox path.

- [x] **Step 6: Cut the CLI over to the Codex runner**

Apply this exact change to `src/platforms/codex/index.ts`:

```diff
-export { codexReplayAdapter } from "./replay.js";
+export { runCodexReplay } from "./replay-runner.js";
```

Apply this exact diff to `src/cli.ts`; the unchanged run/workspace branches and top-level `main(...).catch(...)` stay as they are:

```diff
 import {
   hookEvents,
   platforms,
-  replayPlatforms,
   workspaceHookEvents,
   type HookEvent,
   type HookInvocation,
   type HookResult,
   type MemoryPlatformAdapter,
   type Platform,
-  type ReplayPlatform,
   type WorkspaceHookEvent,
   type WorkspaceHookInvocation,
   type WorkspacePlatformAdapter,
 } from "./interfaces.js";
 import {
   getMemoryPlatformAdapter,
-  getReplayPlatformAdapter,
   getWorkspacePlatformAdapter,
 } from "./platforms/index.js";
-import { formatReplaySummary, runReplay } from "./runtime/replay.js";
+import {
+  formatCodexReplaySummary,
+  runCodexReplay,
+} from "./platforms/codex/replay-runner.js";
 import { readJsonPayload } from "./runtime/stdin.js";

 type CliArgs =
   | { command: "run"; platform: Platform; event: HookEvent }
   | { command: "workspaces"; platform: Platform; event: WorkspaceHookEvent }
-  | { command: "replay"; platform: ReplayPlatform; workingDirectory?: string }
+  | { command: "replay"; platform: "codex"; workingDirectory?: string }
   | {

   if (args.command === "replay") {
     const importRoot = path.resolve(args.workingDirectory ?? process.cwd());
-    const adapter = getReplayPlatformAdapter(args.platform);
-    const summary = await runReplay({
+    const summary = await runCodexReplay({
       importRoot,
-      adapter,
       onProgress: (line) => process.stderr.write(`${line}\n`),
     });
-    process.stdout.write(`${formatReplaySummary(adapter.platform, summary)}\n`);
-    return summary.failed === 0 ? 0 : 1;
+    process.stdout.write(`${formatCodexReplaySummary(summary)}\n`);
+    return 0;
   }

 function parseArgs(argv: string[]): CliArgs | null {
   const [command, platformArg, eventFlag, eventArg] = argv;
-  if (command === "replay" && isReplayPlatform(platformArg)) {
-    if (argv.length === 2) return { command: "replay", platform: platformArg };
+  if (command === "replay" && platformArg === "codex") {
+    if (argv.length === 2) return { command: "replay", platform: "codex" };
     if (argv.length === 4 && argv[2] === "--working-dir" && argv[3] !== undefined && argv[3].trim() !== "" && !argv[3].startsWith("--")) {
-      return { command: "replay", platform: platformArg, workingDirectory: argv[3] };
+      return { command: "replay", platform: "codex", workingDirectory: argv[3] };
     }
     return null;
   }

-function isReplayPlatform(value: string | undefined): value is ReplayPlatform {
-  return value !== undefined && replayPlatforms.includes(value as ReplayPlatform);
-}
-
 function isHookEvent(value: string | undefined): value is HookEvent {

 function usage(): string {
   return [
     "Usage: nams-hooks run <gemini|claude|codex|opencode> --event <SessionStart|BeforeAgent|AfterAgent|AfterTool>",
-    "       nams-hooks replay <claude|codex> [--working-dir PATH]",
+    "       nams-hooks replay codex [--working-dir PATH]",
```

- [x] **Step 7: Remove the generic replay and Claude replay implementation**

Apply this exact diff to `src/interfaces.ts`:

```diff
-import type {
-  AddMessageRequest,
-  RecordStepRequest,
-  RecordToolCallRequest,
-} from "./generated/nams-client.js";
-import type { NamsConfigDiscovery } from "./runtime/config.js";
-
 export const platforms = ["gemini", "claude", "codex", "opencode"] as const;

 export interface WorkspacePlatformAdapter {
   beforeAgent?(invocation: WorkspaceHookInvocation<"BeforeAgent">): Promise<HookResult>;
   installConfigure?(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<HookResult>;
   userPromptExpansion?(invocation: WorkspaceHookInvocation<"UserPromptExpansion">): Promise<HookResult>;
   commandExecuteBefore?(invocation: WorkspaceHookInvocation<"CommandExecuteBefore">): Promise<HookResult>;
   customCommand?(invocation: WorkspaceHookInvocation<"CustomCommand">): Promise<HookResult>;
 }
-
-export const replayPlatforms = ["claude", "codex"] as const;
-export type ReplayPlatform = (typeof replayPlatforms)[number];
-
-export interface ReplayToolRecord
-  extends Omit<RecordToolCallRequest, "input" | "output" | "stepId"> {
-  kind: "tool";
-  input: unknown;
-  output?: unknown;
-  reasoningStep: Omit<RecordStepRequest, "conversationId">;
-}
-
-export type ReplayRecord =
-  | (AddMessageRequest & {
-      kind: "message";
-      role: "user" | "assistant";
-    })
-  | ReplayToolRecord;
-
-export interface ReplayTranscript {
-  sourceSessionId: string;
-  projectDirectory?: string;
-  sourceStartedAt?: string;
-  records: ReplayRecord[];
-  malformedLineCount: number;
-  unsupportedRecordCount: number;
-}
-
-export interface ReplayPlatformAdapter {
-  platform: ReplayPlatform;
-  discoverConfig?: NamsConfigDiscovery;
-  discoverTranscripts(): Promise<string[]>;
-  readTranscript(transcriptPath: string): Promise<ReplayTranscript>;
-}
-
-export interface ReplaySummary {
-  discovered: number;
-  matched: number;
-  imported: number;
-  skipped: number;
-  failed: number;
-  messages: number;
-  toolCalls: number;
-  malformedLines: number;
-  unsupportedRecords: number;
-}
```

Apply this exact diff to `src/platforms/index.ts`:

```diff
 import type {
   MemoryPlatformAdapter,
   Platform,
-  ReplayPlatform,
-  ReplayPlatformAdapter,
   WorkspacePlatformAdapter,
 } from "../interfaces.js";
-import { claudeMemoryAdapter, claudeReplayAdapter } from "./claude/index.js";
+import { claudeMemoryAdapter } from "./claude/index.js";
 import { claudeWorkspaceAdapter } from "./claude/workspaces.js";
-import { codexMemoryAdapter, codexReplayAdapter } from "./codex/index.js";
+import { codexMemoryAdapter } from "./codex/index.js";

 export function getWorkspacePlatformAdapter(platform: Platform): WorkspacePlatformAdapter {
   return workspaceAdapters[platform];
 }
-
-const replayAdapters: Record<ReplayPlatform, ReplayPlatformAdapter> = {
-  claude: claudeReplayAdapter,
-  codex: codexReplayAdapter,
-};
-
-export function getReplayPlatformAdapter(platform: ReplayPlatform): ReplayPlatformAdapter {
-  return replayAdapters[platform];
-}
```

Remove only the replay export from `src/platforms/claude/index.ts`:

```diff
-export { claudeReplayAdapter } from "./replay.js";
```

Delete the superseded source and test files with exact paths:

```bash
git rm \
  src/platforms/claude/replay.ts \
  src/platforms/codex/replay.ts \
  src/runtime/replay.ts \
  test/claude/claude-replay.test.ts \
  test/codex/codex-replay.test.ts \
  test/replay-runtime.test.ts
```

Do not alter `claudeMemoryAdapter`, Claude config discovery, Claude workspace adapter, Claude templates, or Claude tests unrelated to replay.

- [x] **Step 8: Run the full focused replay suite**

Run:

```bash
npm run build
node --import=tsx --test \
  test/replay-files.test.ts \
  test/provenance.test.ts \
  test/codex/codex-replay-collector.test.ts \
  test/codex/codex-replay-outbox.test.ts \
  test/codex/codex-replay-sender.test.ts \
  test/codex/codex-replay-runner.test.ts \
  test/cli-replay.test.ts \
  test/architecture.test.ts
```

Expected: PASS with no Claude replay tests and no generic replay-runtime tests.

- [x] **Step 9: Prove obsolete replay symbols and commands are gone**

Run:

```bash
rg -n --glob '!test/architecture.test.ts' "claudeReplayAdapter|ReplayPlatformAdapter|ReplayTranscript|replay <claude\\|codex>|replay claude" src test
```

Expected: no matches outside the negative-assertion test.

- [x] **Step 10: Commit the cutover and removal**

```bash
git add src/cli.ts src/interfaces.ts src/platforms/index.ts src/platforms/codex/index.ts src/platforms/codex/replay-runner.ts src/platforms/claude/index.ts test/cli-replay.test.ts test/architecture.test.ts test/codex/codex-replay-runner.test.ts
git add -u src/platforms/claude/replay.ts src/platforms/codex/replay.ts src/runtime/replay.ts test/claude/claude-replay.test.ts test/codex/codex-replay.test.ts test/replay-runtime.test.ts
git commit -m "refactor: replace replay with Codex outbox import"
```

### Task 5: Record The Superseding Architecture And Verify The Repository

**Files:**
- Modify: `docs/adr/0001-project-replay-from-source-turns-and-semantic-operations.md`
- Create: `docs/adr/0002-codex-session-outbox-replay.md`
- Modify: `CONTEXT.md`
- Modify: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- Plan source: `docs/plans/0005-codex-session-outbox-replay.md`

**Interfaces:**
- Consumes: the completed Codex collector/outbox/sender/runner behavior from Tasks 1-4.
- Produces: one current replay decision and matching project terminology/design documentation; no runtime interface.

- [x] **Step 1: Mark the previous replay ADR superseded**

Change the front matter of `docs/adr/0001-project-replay-from-source-turns-and-semantic-operations.md` to:

```markdown
---
status: superseded
superseded-by: 0002-codex-session-outbox-replay.md
---
```

Insert immediately below its title:

```markdown
> Superseded by [ADR 0002](0002-codex-session-outbox-replay.md). Replay is now Codex-only, groups rollout files by `session_id`, records response-level call wrappers under explicit reasoning boundaries, and delivers through a temporary fail-fast outbox.
```

Keep the remainder as historical decision context.

- [x] **Step 2: Create the current replay ADR**

Create `docs/adr/0002-codex-session-outbox-replay.md` with:

```markdown
---
status: accepted
---

# Import Codex sessions through a temporary outbox

Session history import supports Codex only. It discovers active and archived rollout JSONL files beneath `CODEX_HOME`, filters them by their first absolute session cwd, and groups every matching root and subagent rollout with the same Codex `session_id` into one NAMS conversation per import run.

A persisted `reasoning` response item is an Agent Step boundary, not reasoning content. The importer keeps step assembly local to one thread and turn, discards boundaries with no tool calls, and attaches every subsequent response-level `custom_tool_call` or `function_call` to that step until the next boundary. Hidden and encrypted reasoning is never stored. Completed user and root-assistant event messages form the canonical conversation message stream; injected response-role user content and subagent assistant messages do not.

Calls pair with outputs by explicit `call_id`. Every output record and every textual output part is appended in source order before concatenation. The response-level call is canonical; nested command, file-change, and collaboration events may inform parsing diagnostics but are not emitted as duplicate tool calls.

The importer assembles the filtered corpus in memory, then writes every logical NAMS operation to a private JSONL outbox in a unique OS temporary directory. It does not read or update live hook session state and persists no checkpoint, cursor, deduplication key, conversation ID, or Agent Step ID. The sender holds remote IDs only in memory, sends sequentially, performs no retry, and stops at the first failure. A handled exit removes the temporary directory; an abrupt exit leaves it for OS cleanup.

Restarting rebuilds the outbox from source and begins again. Duplicate and partial NAMS data are acceptable. Delivery is best-effort with at-least-once behavior when an operator restarts after failure.

Claude replay is removed because the new outbox projection is defined only from observed Codex rollout identities and boundaries. Claude live hooks remain supported and are unaffected.
```

- [x] **Step 3: Update the domain language**

Replace the complete `### Session History Import` section in `CONTEXT.md` with:

```markdown
### Codex Session History Import

**Codex Session History Import**:
A one-off, offline ingestion of matching Codex rollout files into NAMS. It never runs or resumes an agent, model, or tool, recalls memory, or simulates a hook.
_Avoid_: Agent replay, Claude history import

**Imported Codex Conversation**:
One NAMS conversation representing every matching root and subagent rollout stream with the same Codex `session_id` during one import run.
_Avoid_: Per-file conversation, durable replay conversation

**Rollout Working Directory**:
The first usable absolute `session_meta.payload.cwd` in one rollout stream. It determines import-root eligibility and must agree across all streams grouped into one imported Codex conversation.
_Avoid_: Per-message working directory, later cwd override

**Import Root**:
The selected working directory that scopes a Codex session history import. Rollout streams rooted at this directory or beneath it belong to the import.
_Avoid_: Exact-session directory, filename scope

**Import Destination**:
The single NAMS workspace resolved once from the import root and used for every conversation produced by the run.
_Avoid_: Per-session destination, historical workspace

**Codex Rollout Corpus**:
The JSONL files still present beneath Codex active and archived session storage. Deleted, expired, ephemeral, and otherwise unpersisted activity is outside the available corpus.
_Avoid_: Active sessions only, Claude transcripts

**Rollout Stream**:
One root or subagent Codex JSONL file contributing records to a source `session_id`.
_Avoid_: Imported conversation, independent source session

**Source Turn**:
A Codex `turn_id` scoped to one rollout stream. It prevents simultaneous root and subagent activity from sharing Agent Step state.
_Avoid_: Global turn, NAMS conversation

**Source Agent Step**:
A tool-bearing interval opened by a persisted Codex `reasoning` response item and scoped by source session, thread, and turn. The reasoning item is a boundary only; its hidden or encrypted content is never memory.
_Avoid_: Chain-of-thought, empty reasoning interval

**Eligible Codex Replay Record**:
A completed human user message, completed root-assistant message, response-level custom or function call, or matching exposed output. Injected response-role user content, hidden reasoning, system/developer instructions, compaction, and nested duplicate tool representations are ineligible.
_Avoid_: Every JSONL entry, inferred tool activity

**Temporary Replay Outbox**:
A complete private JSONL projection of logical NAMS writes for one run, stored in a unique OS temporary directory and removed after a handled success or failure.
_Avoid_: Session state, checkpoint, durable queue

**Best-Effort Replay Delivery**:
Sequential fail-fast sending with no retry, checkpoint, persistent ID mapping, or deduplication. Restarting rebuilds the outbox and starts from the beginning, so duplicates and partial prior conversations are acceptable.
_Avoid_: Exactly-once delivery, resumable replay

**Source Session Provenance**:
The Codex harness, source `session_id`, rollout working directory, and optional source start time stored on an imported conversation. NAMS insertion timestamps are not treated as historical source timestamps.
_Avoid_: Import timestamp as session time, inferred source time
```

- [x] **Step 4: Update the main design source**

Insert this exact subsection after the complete harness-notes block and immediately before `## Duplicate Suppression` in `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`, so the existing OpenCode notes remain peers of the Codex notes:

```markdown
### Codex Session History Import

`nams-hooks replay codex [--working-dir PATH]` performs one offline best-effort import. Replay is Codex-only; Claude replay is not supported, while Claude live hooks and distribution remain unchanged.

The importer discovers regular JSONL files beneath `CODEX_HOME/sessions` and `CODEX_HOME/archived_sessions`, or the corresponding `~/.codex` directories. It filters each rollout stream by the first usable absolute `session_meta.payload.cwd` and includes the stream when that directory equals the import root or is below it. Every matching root and subagent stream with the same `session_meta.payload.session_id` contributes to one NAMS conversation during that run. `payload.id` is only the session fallback when `session_id` is absent and is otherwise available as a thread identity. Conflicting project directories in one grouped session stop collection.

Completed `event_msg` `UserMessage` items from the root stream are the human message source. Completed root `AgentMessage` items are the assistant message source. Response-role user records, system/developer input, subagent assistant messages, compaction, and hidden reasoning are excluded from the canonical conversation stream.

A `response_item.reasoning` record is an Agent Step boundary only. The importer isolates open steps by source session, thread, and turn; closes a step at the next reasoning boundary in that stream; discards boundaries with no tool calls; and creates a safe fallback step if a call precedes reasoning. It never stores reasoning summaries or `encrypted_content`.

Response-level `custom_tool_call` and `function_call` wrappers are the canonical tool records. Calls and outputs pair by explicit `call_id` within the same session, thread, and turn. Every matching output record and every exposed textual output part is appended in source order and concatenated once. Nested command, file-change, collaboration, and subagent event items are not emitted as duplicate calls. Status and duration are recorded only when the rollout exposes defensible evidence compatible with the NAMS contract.

The filtered corpus is assembled in memory. Before the first NAMS request, the importer writes the complete logical operation sequence to `outbox.jsonl` inside a unique directory created under the OS temporary directory. The directory uses mode `0700` and the file uses `0600`. Replay never reads or writes live `SessionState`, `.nams/state/`, or `.nams/logs/`, and it persists no cursor, checkpoint, sent marker, deduplication key, conversation mapping, or Agent Step mapping.

The sender validates the whole outbox, resolves NAMS configuration and one destination workspace, and sends records sequentially. It performs no retry and stops on the first configuration, validation, transport, HTTP, or response error. Remote conversation and step IDs exist only in process memory. A `finally` cleanup removes the temporary outbox after handled success or failure; an abrupt termination may leave it for OS cleanup.

Restarting rediscovers the corpus, recreates the outbox, creates new NAMS conversations, and starts from the beginning. Duplicate writes and partial or orphaned conversations from a prior failed run are acceptable. This is best-effort, at-least-once delivery when the operator restarts after failure, not exactly-once or resumable delivery.
```

Do not change the live hook lifecycle or generated distribution model elsewhere in the design.

- [x] **Step 5: Run focused and full verification**

Run:

```bash
npm run build
node --import=tsx --test \
  test/replay-files.test.ts \
  test/provenance.test.ts \
  test/codex/codex-replay-collector.test.ts \
  test/codex/codex-replay-outbox.test.ts \
  test/codex/codex-replay-sender.test.ts \
  test/codex/codex-replay-runner.test.ts \
  test/cli-replay.test.ts \
  test/architecture.test.ts
npm run check
```

Expected: all focused tests pass, then `npm run check` completes successfully.

- [x] **Step 6: Inspect the final scope and generated-artifact boundary**

Run:

```bash
git status --short
git diff --check
git diff --stat
rg -n --glob '!test/architecture.test.ts' "claudeReplayAdapter|ReplayPlatformAdapter|ReplayTranscript|replay <claude\\|codex>|replay claude" src test
git status --short -- dist dist-marketplace dist-local
```

Expected: the first three commands show only planned source/test/documentation changes plus unrelated pre-existing user files; the obsolete-symbol search prints no matches outside the negative-assertion test; generated distribution directories show no source changes.

- [x] **Step 7: Commit the architecture record**

```bash
git add docs/adr/0001-project-replay-from-source-turns-and-semantic-operations.md docs/adr/0002-codex-session-outbox-replay.md CONTEXT.md docs/superpowers/specs/2026-05-10-nams-hooks-design.md docs/plans/0005-codex-session-outbox-replay.md
git commit -m "docs: define Codex outbox replay architecture"
```

---

## Self-Review Results

- Spec coverage: every clarified requirement is assigned to a task: Codex-only grouping/extraction in Task 1, temporary outbox/no persistent state in Task 2, fail-fast/no-retry sender in Task 3, CLI cutover and Claude replay removal in Task 4, and superseding architecture records in Task 5.
- Scope: Claude live behavior remains explicitly out of scope; only replay-specific Claude files, exports, CLI paths, and tests are removed.
- Placeholder scan: no `TBD`, `TODO`, deferred implementation, comment-only test, undefined interface, or “similar to another task” instruction remains. Every code-changing step includes the exact source, test, diff, deletion command, or documentation content to apply.
- Type consistency: collector output feeds `CodexReplaySession[]`; the outbox consumes those sessions and emits `CodexReplayOutboxRecord`; the sender consumes the outbox path and returns `CodexReplaySendSummary`; the runner combines collection and send counts into `CodexReplayRunSummary`; the CLI consumes only the runner/formatter.
- Delivery semantics: there are no retries, checkpoints, persistent mappings, deduplication keys, state writes, or continue-on-error paths. Restarting deliberately recreates and resends the outbox.
