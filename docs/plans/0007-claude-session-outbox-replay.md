# Claude Session Outbox Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an offline Claude session importer that groups root and subagent transcripts by Claude `sessionId`, follows the active transcript branches, preserves authored root messages and root assistant output, assembles tool-bearing Agent Steps by assistant `message.id`, collects direct and asynchronous tool output, writes a complete private temporary outbox, and delivers it to NAMS with fail-fast best-effort semantics.

**Architecture:** Claude replay is a separate deep platform module beside the existing Codex replay implementation. Claude gets its own model, collector, outbox, sender, runner, fixture builders, environment helper, and test suite under `src/platforms/claude/` and `test/claude/`; no Codex replay module is changed or generalized, and no common replay abstraction or registry is introduced. The CLI selects the two concrete runners directly, while live Claude hooks and all Codex replay behavior remain unchanged.

**Tech Stack:** TypeScript 5.9, Node.js 20+ ESM and built-ins, generated NAMS REST client, Node `node:test`, `tsx`, and existing dev-only `fetch-mock` support.

## Global Constraints

- The Claude public command is exactly `nams-hooks replay claude [--working-dir PATH]`; the existing `nams-hooks replay codex [--working-dir PATH]` command and behavior remain supported.
- Keep Claude replay implementation files under `src/platforms/claude/`. Do not move, rename, edit, import, wrap, or generalize `src/platforms/codex/replay-model.ts`, `replay-collector.ts`, `replay-outbox.ts`, `replay-sender.ts`, or `replay-runner.ts`.
- Do not create generic replay models, collectors, outboxes, senders, runners, adapters, registries, or test-environment helpers. Intentional Claude/Codex duplication is required because their transcript identities, step boundaries, output forms, and validation rules differ.
- Shared runtime facilities that are already platform-neutral may still be consumed: regular-file discovery, path containment, private file permissions, configuration loading, workspace selection, generated NAMS clients, provenance base headers, and tool input/output sanitization.
- Replay is offline. It must never resume an agent, invoke a model or tool, recall memory, or simulate a hook event.
- Discover Claude transcript JSONL only beneath `CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`, using the existing regular-file traversal rules. Do not treat `.meta.json`, `tool-results/*.txt`, or `memory/` files as transcript streams.
- Read the selected Claude corpus into memory before constructing or sending operations. Memory usage is not a design constraint; do not add streaming state, caches, cursors, checkpoints, or memory-pressure machinery.
- Use transcript `sessionId` as the source conversation identity. Accept `session_id` only as a record-level compatibility fallback. Never use a subagent filename as the conversation identity.
- Model one root stream as `root` and each sidechain stream as `agent:<agentId>`. Scope assistant response and tool-call identities by source session and stream.
- Group all matching root and linked subagent streams with one `sessionId` into one NAMS conversation. Use adjacent subagent `.meta.json` only to relate `toolUseId` to a parent `Agent` call; never expose a new remote parent/child relation that NAMS does not support.
- Determine import-root eligibility from the first usable absolute `cwd` in the root stream. Later root and subagent cwd values may be equal or descendants and must not be required to equal the root cwd.
- Skip a session group with no root stream, no usable root cwd, a root cwd outside the import root, or no normalized messages/steps. Do not create an empty NAMS conversation.
- Build the UUID parent graph independently for every root or subagent stream. Starting from the last UUID-bearing record, follow `parentUuid` to select the active spine. Use the active spine for human messages and assistant response groups, but pair outputs by explicit call identity even when parallel results are sibling graph branches.
- Use only active root `type: "user"` records whose `origin.kind` is `human` for canonical user messages. Do not infer human authorship from `type: "user"` alone.
- Normalize an authored slash-command wrapper from `<command-name>` and `<command-args>` into `/command arguments`. Exclude `isMeta` command expansions, local-command caveats/stdout, task notifications, tool results, request-interruption notices, and root control commands without `origin.kind: "human"`.
- Use active root assistant `text` blocks, grouped by assistant `message.id`, for canonical assistant messages. Do not flatten sidechain assistant text into the root conversation.
- Use `(sessionId, streamId, message.id)` as the Agent Step boundary. Create an Agent Step only when that grouped assistant response contains at least one `tool_use`; one response may contain multiple calls.
- Never persist `thinking`, `redacted_thinking`, signatures, or inferred chain-of-thought. Prefer visible text from the same assistant response as the safe operational step summary; otherwise use `Claude exposed a tool-use step in the persisted transcript.`
- Treat assistant `tool_use` blocks as canonical calls. Pair direct `tool_result` blocks by `tool_use_id` within the same session and stream; `parentUuid` and `sourceToolAssistantUUID` are validation evidence, not adjacency rules.
- Append every direct result record and every visible content item in source order. Preserve text items verbatim and stable-serialize non-text items such as `tool_reference`; never keep only the first item and never overwrite earlier output.
- Treat a root `<task-notification>` with `origin.kind: "task-notification"` as late output for its `<tool-use-id>`, not as a user message. Append its `<result>` after the immediate result and let its final status supersede an asynchronous launch status.
- Preserve both the parent `Agent`/`SendMessage` call and linked subagent-internal calls. Do not also promote the subagent final assistant message into the root message stream or append it as a second copy of task-notification output.
- For `toolUseResult.persistedOutputPath`, resolve only the basename inside the selected session's local `tool-results/` directory. Require a non-symlink regular file and a matching `persistedOutputSize`; use the complete companion content instead of the preview. Never follow the recorded absolute path outside the selected corpus.
- If a persisted-output companion is absent or invalid, keep the exposed `tool_result.content`, increment the unsupported-record count, and continue collection. A malformed JSONL line is counted and skipped; an unreadable transcript aborts collection before outbox creation.
- Do not duplicate `message.content[].tool_result`, top-level `toolUseResult`, and companion-file representations. Top-level `toolUseResult` is used only for asynchronous status, stderr accompanying a full persisted stdout, and persisted-file metadata.
- Normalize only NAMS-compatible statuses: `pending`, `success`, `failure`, `error`, `timeout`, or `cancelled`. Explicit `is_error: true` means `error`; an asynchronous launch without completion is `pending`; a non-error completed direct result is `success`; a later task notification supplies the final status.
- Derive duration from the call timestamp to the last associated direct or asynchronous output timestamp. Omit it when timestamps are missing, invalid, or negative.
- Do not read, create, update, or reuse live `SessionState`. Do not write replay data beneath `.nams/state/` or `.nams/logs/`.
- Build the complete normalized Claude outbox before the first NAMS request. Store it beneath a unique `mkdtemp()` directory rooted at `node:os.tmpdir()` in production; tests may inject another temporary root.
- The Claude outbox directory uses mode `0700`, its `outbox.jsonl` uses mode `0600`, and its prefix is `nams-hooks-claude-replay-`. Reuse the existing private-permission functions without extracting a shared replay outbox.
- Remove the temporary Claude outbox in a `finally` block after success or handled failure. An abrupt termination may leave it for OS temporary cleanup.
- Validate the entire outbox and all local conversation/step references before configuration resolution or any NAMS request.
- Delivery is sequential, fail-fast, and has no retry. Remote conversation and step IDs remain in process memory only.
- Persist no replay checkpoint, cursor, sent marker, deduplication key, conversation mapping, or Agent Step mapping. Restarting recreates and resends the complete outbox; duplicates and partial/orphaned remote conversations are acceptable.
- Delivery is best-effort with at-least-once behavior when the operator restarts after a failure.
- Add a Claude-specific replay provenance function. Do not parameterize or rename the existing Codex `namsReplayProvenanceHeaders()` function.
- Emit `Claude replay file imported: <absolute path>`, `Claude replay file skipped: <absolute path>`, and `Claude replay outbox: <absolute path>` through runner progress. Do not print transcript contents, outbox contents, tool inputs/outputs, or credentials.
- Tests use OS temporary fixtures, make no external network calls, and leave no `.nams/`, transcript, outbox, or generated artifacts in the repository.
- Do not hand-edit `dist/`, `dist-marketplace/`, or `dist-local/`.
- Final verification is the focused Claude/Codex replay suite followed by `npm run check`.

---

## Transcript Findings Driving The Plan

- The uploaded corpus has 12 transcript JSONL files but only three `sessionId` values. One session spans a root file and nine sidechain files, so file-per-conversation replay is incorrect.
- The corpus has 821 assistant rows but 413 unique assistant `message.id` values. Claude persists response content blocks as multiple rows that repeat one message ID.
- There are 388 tool-bearing assistant responses and 404 `tool_use` calls. Sixteen responses contain two calls, so one-call/one-step projection loses the observed response boundary.
- There are 272 `thinking` blocks, all empty and signature-only. Additionally, 121 tool-bearing responses contain no thinking block, so thinking is neither safe content nor a complete step boundary.
- All 404 direct `tool_result` blocks match a `tool_use_id`, but only 377 are immediately adjacent to their call. ID matching is required.
- Nine `Agent` calls and one `SendMessage` call receive later task notifications containing their actual completion output. Using only the immediate `tool_result` loses these ten outputs.
- Two Bash outputs are externalized. Their visible tool results contain about 2 KB previews, top-level stdout contains only about 30 KB, and the complete companion files contain approximately 598 KB and 32 KB.
- Of 460 `type: "user"` rows, 404 are tool results and ten are task notifications. `origin.kind: "human"` is the reliable authored-input marker in this corpus.
- The root UUID graph contains abandoned human branches. Selecting every append-only row would import a cleared command and an incomplete replaced prompt.
- Root and subagent cwd values legitimately move into project descendants. Equality validation across files would reject a valid grouped session.
- Root assistant text is the clean canonical assistant stream. Sidechain prompts and final messages duplicate parent delegation input/output and must not be flattened into conversation messages.

---

## File Map

- `src/platforms/claude/replay-model.ts`: Claude-only normalized collection, message, Agent Step, tool-call, file-progress, outbox-record, and outbox-handle types.
- `src/platforms/claude/replay-collector.ts`: Claude discovery, complete-corpus grouping, active-branch selection, authored/root message extraction, response grouping, subagent linkage, direct/late result pairing, persisted-output loading, status/duration derivation, and deterministic assembly.
- `src/platforms/claude/replay-outbox.ts`: Claude-only logical operation projection, private temporary outbox creation, complete validation, reading, and cleanup.
- `src/platforms/claude/replay-sender.ts`: Claude-only destination resolution and sequential fail-fast delivery using in-memory remote ID maps.
- `src/platforms/claude/replay-runner.ts`: Claude collection, progress, outbox lifecycle, delivery, and aggregate summary.
- `src/platforms/claude/index.ts`: export the Claude runner/formatter alongside the unchanged live adapter.
- `src/runtime/provenance.ts`: add a separately named Claude replay header function; leave the Codex replay function unchanged.
- `src/cli.ts`: accept `replay claude` and dispatch directly to the Claude runner without a replay registry or common runner interface.
- `test/support/claude-rollout-fixture.ts`: compact builders for Claude root, assistant-fragment, direct-result, task-notification, and subagent metadata records.
- `test/support/claude-nams-replay-environment.ts`: Claude-specific environment isolation; do not modify or reuse the Codex replay environment helper.
- `test/claude/claude-replay-collector.test.ts`: session grouping, active branches, authored messages, response/step grouping, result accumulation, async completions, external outputs, cwd behavior, discovery, and malformed/orphan cases.
- `test/claude/claude-replay-outbox.test.ts`: Claude operation order, references, permissions, validation, and cleanup.
- `test/claude/claude-replay-sender.test.ts`: Claude provenance, exact NAMS request order, sanitization, preflight reference validation, workspace resolution, fail-fast behavior, and absence of state/log writes.
- `test/claude/claude-replay-runner.test.ts`: complete collection/outbox/send lifecycle, progress, cleanup, failure, and restart semantics.
- `test/cli-claude-replay.test.ts`: end-to-end Claude CLI import without stdin and with no live-state interference.
- `test/cli-replay.test.ts`: stop rejecting Claude and retain Codex coverage unchanged.
- `test/provenance.test.ts`: add Claude replay header coverage without changing the Codex assertion.
- `test/architecture.test.ts`: assert separate concrete Claude/Codex replay entrypoints and the absence of a generic replay registry/contracts.
- `docs/adr/0001-project-replay-from-source-turns-and-semantic-operations.md`: point the superseded multi-platform decision at both current platform-specific ADRs.
- `docs/adr/0002-codex-session-outbox-replay.md`: retain the Codex decision and note that later Claude support is a separate implementation.
- `docs/adr/0003-claude-session-outbox-replay.md`: record Claude transcript identities, branch/message/step/output rules, and isolated outbox delivery.
- `CONTEXT.md`: add Claude-specific replay domain language without replacing or generalizing the Codex terms.
- `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`: add the independent Claude history-import contract and revise only the stale Codex-only availability sentence.

### Task 1: Claude Corpus Collector And Agent Step Assembly

**Files:**
- Create: `src/platforms/claude/replay-model.ts`
- Create: `src/platforms/claude/replay-collector.ts`
- Create: `test/support/claude-rollout-fixture.ts`
- Create: `test/claude/claude-replay-collector.test.ts`
- Existing helpers: `src/runtime/replay-files.ts`, `src/runtime/paths.ts`, `src/runtime/util.ts`

**Interfaces:**
- Consumes: `discoverRegularJsonlFiles(roots)`, `normalizeAbsolutePath(value)`, `isDirectoryWithinImportRoot(importRoot, candidate)`, `homeDirectory(env)`, `firstString(...)`, and `isPlainObject(...)`.
- Produces: `discoverClaudeTranscriptPaths(env?)`, `collectClaudeReplaySessions(input)`, and the exact Claude replay model types defined in Step 5.

- [x] **Step 1: Create realistic Claude transcript builders**

Create `test/support/claude-rollout-fixture.ts`:

```ts
export interface ClaudeFixtureRecord {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId: string;
  cwd: string;
  timestamp: string;
  isSidechain: boolean;
  agentId?: string;
  origin?: { kind: string };
  isMeta?: boolean;
  message?: Record<string, unknown>;
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: string;
}

export function claudeRecord(input: Omit<ClaudeFixtureRecord, "timestamp"> & {
  timestamp?: string;
}): ClaudeFixtureRecord {
  return {
    ...input,
    timestamp: input.timestamp ?? "2026-08-26T12:00:00.000Z",
  };
}

export function assistantBlock(input: {
  sessionId: string;
  cwd: string;
  uuid: string;
  parentUuid: string;
  messageId: string;
  block: Record<string, unknown>;
  isSidechain?: boolean;
  agentId?: string;
  timestamp?: string;
}): ClaudeFixtureRecord {
  return claudeRecord({
    type: "assistant",
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    isSidechain: input.isSidechain ?? false,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    message: {
      id: input.messageId,
      role: "assistant",
      content: [input.block],
    },
  });
}

export function humanMessage(input: {
  sessionId: string;
  cwd: string;
  uuid: string;
  parentUuid: string;
  content: string;
  timestamp?: string;
}): ClaudeFixtureRecord {
  return claudeRecord({
    type: "user",
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    isSidechain: false,
    origin: { kind: "human" },
    message: { role: "user", content: input.content },
  });
}

export function toolResult(input: {
  sessionId: string;
  cwd: string;
  uuid: string;
  parentUuid: string;
  toolUseId: string;
  content: unknown;
  isSidechain?: boolean;
  agentId?: string;
  isError?: boolean;
  toolUseResult?: unknown;
  timestamp?: string;
}): ClaudeFixtureRecord {
  return claudeRecord({
    type: "user",
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sourceToolAssistantUUID: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    isSidechain: input.isSidechain ?? false,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: input.toolUseId,
        content: input.content,
        ...(input.isError !== undefined ? { is_error: input.isError } : {}),
      }],
    },
    ...(input.toolUseResult !== undefined ? { toolUseResult: input.toolUseResult } : {}),
  });
}

export function taskNotification(input: {
  sessionId: string;
  cwd: string;
  uuid: string;
  parentUuid: string;
  toolUseId: string;
  status: string;
  result: string;
  timestamp?: string;
}): ClaudeFixtureRecord {
  return claudeRecord({
    type: "user",
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    isSidechain: false,
    origin: { kind: "task-notification" },
    message: {
      role: "user",
      content: [
        "<task-notification>",
        `<tool-use-id>${input.toolUseId}</tool-use-id>`,
        `<status>${input.status}</status>`,
        `<result>${input.result}</result>`,
        "</task-notification>",
      ].join("\n"),
    },
  });
}

export function jsonl(records: ClaudeFixtureRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
```

- [x] **Step 2: Write the failing grouped-session and active-branch test**

Create `test/claude/claude-replay-collector.test.ts` with the following imports and first test. This fixture deliberately makes the first tool result a sibling branch, places two calls in one assistant response, retains one abandoned human branch, and places a linked subagent under the same session:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  collectClaudeReplaySessions,
  discoverClaudeTranscriptPaths,
} from "../../src/platforms/claude/replay-collector.js";
import {
  assistantBlock,
  claudeRecord,
  humanMessage,
  jsonl,
  taskNotification,
  toolResult,
} from "../support/claude-rollout-fixture.js";

test("groups a root and linked subagent while preserving the active root conversation", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-collector-"));
  try {
    const project = path.join(fixture, "project");
    const projectDir = path.join(fixture, "claude", "projects", "encoded-project");
    const sessionId = "session-1";
    const rootPath = path.join(projectDir, `${sessionId}.jsonl`);
    const agentId = "agent-1";
    const childPath = path.join(projectDir, sessionId, "subagents", `${agentId}.jsonl`);
    await mkdir(path.dirname(childPath), { recursive: true });
    await mkdir(project, { recursive: true });

    await writeFile(rootPath, jsonl([
      claudeRecord({
        type: "system", uuid: "root", parentUuid: null, sessionId, cwd: project,
        isSidechain: false, message: { role: "system", content: "ignore" },
      }),
      humanMessage({
        sessionId, cwd: project, uuid: "user-1", parentUuid: "root",
        content: "<command-message>run</command-message><command-name>/run</command-name><command-args>the plan</command-args>",
        timestamp: "2026-08-26T12:00:01.000Z",
      }),
      assistantBlock({
        sessionId, cwd: project, uuid: "assistant-1", parentUuid: "user-1",
        messageId: "message-1", block: { type: "thinking", thinking: "", signature: "do-not-store" },
        timestamp: "2026-08-26T12:00:02.000Z",
      }),
      assistantBlock({
        sessionId, cwd: project, uuid: "assistant-2", parentUuid: "assistant-1",
        messageId: "message-1", block: { type: "text", text: "I will delegate and inspect." },
        timestamp: "2026-08-26T12:00:02.100Z",
      }),
      assistantBlock({
        sessionId, cwd: project, uuid: "assistant-3", parentUuid: "assistant-2",
        messageId: "message-1", block: {
          type: "tool_use", id: "call-agent", name: "Agent", input: { prompt: "inspect" },
        },
        timestamp: "2026-08-26T12:00:02.200Z",
      }),
      assistantBlock({
        sessionId, cwd: path.join(project, "src"), uuid: "assistant-4", parentUuid: "assistant-3",
        messageId: "message-1", block: {
          type: "tool_use", id: "call-read", name: "Read", input: { file_path: "src/a.ts" },
        },
        timestamp: "2026-08-26T12:00:02.300Z",
      }),
      toolResult({
        sessionId, cwd: project, uuid: "result-agent", parentUuid: "assistant-3",
        toolUseId: "call-agent", content: [{ type: "text", text: "Agent launched." }],
        toolUseResult: { isAsync: true, status: "async_launched", agentId },
        timestamp: "2026-08-26T12:00:03.000Z",
      }),
      toolResult({
        sessionId, cwd: project, uuid: "result-read", parentUuid: "assistant-4",
        toolUseId: "call-read", content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
        timestamp: "2026-08-26T12:00:03.100Z",
      }),
      humanMessage({
        sessionId, cwd: project, uuid: "abandoned", parentUuid: "result-read",
        content: "incomplete replacement", timestamp: "2026-08-26T12:00:04.000Z",
      }),
      humanMessage({
        sessionId, cwd: project, uuid: "user-2", parentUuid: "result-read",
        content: "Continue with the complete request.", timestamp: "2026-08-26T12:00:05.000Z",
      }),
      assistantBlock({
        sessionId, cwd: project, uuid: "assistant-final", parentUuid: "user-2",
        messageId: "message-final", block: { type: "text", text: "Completed." },
        timestamp: "2026-08-26T12:00:06.000Z",
      }),
      taskNotification({
        sessionId, cwd: project, uuid: "notification", parentUuid: "assistant-final",
        toolUseId: "call-agent", status: "completed", result: "Agent completed.",
        timestamp: "2026-08-26T12:00:07.000Z",
      }),
    ]), "utf8");

    await writeFile(childPath, jsonl([
      claudeRecord({
        type: "user", uuid: "child-root", parentUuid: null, sessionId, cwd: path.join(project, "src"),
        isSidechain: true, agentId, message: { role: "user", content: "internal assignment" },
      }),
      assistantBlock({
        sessionId, cwd: path.join(project, "src"), uuid: "child-assistant-1", parentUuid: "child-root",
        messageId: "child-message", isSidechain: true, agentId,
        block: { type: "tool_use", id: "child-call", name: "Bash", input: { command: "pwd" } },
        timestamp: "2026-08-26T12:00:04.100Z",
      }),
      toolResult({
        sessionId, cwd: path.join(project, "src"), uuid: "child-result", parentUuid: "child-assistant-1",
        toolUseId: "child-call", content: "child output", isSidechain: true, agentId, isError: true,
        timestamp: "2026-08-26T12:00:04.200Z",
      }),
      assistantBlock({
        sessionId, cwd: project, uuid: "child-final", parentUuid: "child-result",
        messageId: "child-final-message", isSidechain: true, agentId,
        block: { type: "text", text: "Do not flatten this child response." },
        timestamp: "2026-08-26T12:00:04.300Z",
      }),
    ]), "utf8");
    await writeFile(path.join(path.dirname(childPath), `${agentId}.meta.json`), JSON.stringify({
      agentType: "general-purpose",
      description: "inspect",
      toolUseId: "call-agent",
      spawnDepth: 1,
      model: "claude",
    }), "utf8");

    const collection = await collectClaudeReplaySessions({
      importRoot: project,
      transcriptPaths: [childPath, rootPath],
    });

    assert.equal(collection.discoveredFiles, 2);
    assert.equal(collection.matchedFiles, 2);
    assert.equal(collection.skippedFiles, 0);
    assert.equal(collection.sessions.length, 1);
    const [session] = collection.sessions;
    assert.deepEqual(
      session.messages.map(({ timestamp: _timestamp, ordinal: _ordinal, streamId: _streamId, ...message }) => message),
      [
        { role: "user", content: "/run the plan" },
        { role: "assistant", content: "I will delegate and inspect." },
        { role: "user", content: "Continue with the complete request." },
        { role: "assistant", content: "Completed." },
      ],
    );
    assert.equal(session.messages.some((message) => message.content.includes("incomplete")), false);
    assert.equal(session.messages.some((message) => message.content.includes("child response")), false);
    assert.equal(session.steps.length, 2);
    const rootStep = session.steps.find((step) => step.streamId === "root");
    const childStep = session.steps.find((step) => step.streamId === `agent:${agentId}`);
    assert.ok(rootStep);
    assert.ok(childStep);
    assert.equal(rootStep.sourceAssistantMessageId, "message-1");
    assert.equal(rootStep.reasoning, "I will delegate and inspect.");
    assert.deepEqual(rootStep.toolCalls.map((call) => ({
      name: call.toolName,
      output: call.output,
      status: call.status,
      durationMs: call.durationMs,
    })), [
      { name: "Agent", output: "Agent launched.\n\nAgent completed.", status: "success", durationMs: 4800 },
      { name: "Read", output: "first\n\nsecond", status: "success", durationMs: 800 },
    ]);
    assert.equal(childStep.toolCalls[0].output, "child output");
    assert.equal(childStep.toolCalls[0].status, "error");
    assert.equal(JSON.stringify(session).includes("do-not-store"), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
```

- [x] **Step 3: Add failing discovery, external-output, empty-session, and malformed-record tests**

Append these tests to `test/claude/claude-replay-collector.test.ts`:

```ts
test("discovers root and subagent JSONL only beneath the Claude projects directory", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-discovery-"));
  try {
    const projects = path.join(fixture, "projects", "encoded");
    const rootPath = path.join(projects, "session-1.jsonl");
    const childPath = path.join(projects, "session-1", "subagents", "agent-1.jsonl");
    await mkdir(path.dirname(childPath), { recursive: true });
    await writeFile(rootPath, "{}\n", "utf8");
    await writeFile(childPath, "{}\n", "utf8");
    await writeFile(path.join(projects, "session-1", "subagents", "agent-1.meta.json"), "{}\n", "utf8");
    await mkdir(path.join(projects, "session-1", "tool-results"), { recursive: true });
    await writeFile(path.join(projects, "session-1", "tool-results", "large.txt"), "not-jsonl", "utf8");

    assert.deepEqual(await discoverClaudeTranscriptPaths({ CLAUDE_CONFIG_DIR: fixture }), [
      rootPath,
      childPath,
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("uses a validated session-local companion for persisted Bash output", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-persisted-"));
  try {
    const project = path.join(fixture, "project");
    const projectDir = path.join(fixture, "projects", "encoded");
    const sessionId = "session-1";
    const rootPath = path.join(projectDir, `${sessionId}.jsonl`);
    const outputPath = path.join(projectDir, sessionId, "tool-results", "large.txt");
    const completeOutput = "complete output from companion";
    await mkdir(path.dirname(outputPath), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(outputPath, completeOutput, "utf8");
    await writeFile(rootPath, jsonl([
      humanMessage({ sessionId, cwd: project, uuid: "user", parentUuid: "root", content: "Run it." }),
      assistantBlock({
        sessionId, cwd: project, uuid: "call-row", parentUuid: "user", messageId: "message-1",
        block: { type: "tool_use", id: "call-1", name: "Bash", input: { command: "run" } },
      }),
      toolResult({
        sessionId, cwd: project, uuid: "result", parentUuid: "call-row", toolUseId: "call-1",
        content: "<persisted-output>preview only</persisted-output>",
        toolUseResult: {
          stdout: "truncated",
          stderr: "",
          persistedOutputPath: "/untrusted/original/large.txt",
          persistedOutputSize: Buffer.byteLength(completeOutput),
        },
      }),
    ]), "utf8");

    const collection = await collectClaudeReplaySessions({
      importRoot: project,
      transcriptPaths: [rootPath],
    });
    assert.equal(collection.sessions[0].steps[0].toolCalls[0].output, completeOutput);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("skips a cleared active branch and counts malformed and orphan output", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-empty-"));
  try {
    const project = path.join(fixture, "project");
    const rootPath = path.join(fixture, "projects", "session-1.jsonl");
    await mkdir(path.dirname(rootPath), { recursive: true });
    await mkdir(project, { recursive: true });
    const records = [
      claudeRecord({
        type: "system", uuid: "root", parentUuid: null, sessionId: "session-1", cwd: project,
        isSidechain: false, message: { role: "system", content: "start" },
      }),
      humanMessage({
        sessionId: "session-1", cwd: project, uuid: "abandoned", parentUuid: "root",
        content: "abandoned command",
      }),
      claudeRecord({
        type: "user", uuid: "control", parentUuid: "root", sessionId: "session-1", cwd: project,
        isSidechain: false, isMeta: true, message: { role: "user", content: "<local-command-caveat>clear</local-command-caveat>" },
      }),
      toolResult({
        sessionId: "session-1", cwd: project, uuid: "orphan", parentUuid: "control",
        toolUseId: "missing", content: "orphan",
      }),
    ];
    await writeFile(rootPath, [
      JSON.stringify(records[0]),
      "{malformed",
      ...records.slice(1).map((record) => JSON.stringify(record)),
      "",
    ].join("\n"), "utf8");

    const progress: Array<{ path: string; status: "imported" | "skipped" }> = [];
    const collection = await collectClaudeReplaySessions({
      importRoot: project,
      transcriptPaths: [rootPath],
      onFileProcessed: (event) => progress.push(event),
    });
    assert.equal(collection.malformedLines, 1);
    assert.equal(collection.unsupportedRecords, 1);
    assert.equal(collection.sessions.length, 0);
    assert.deepEqual(progress, [{ path: rootPath, status: "skipped" }]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
```

- [x] **Step 4: Run the collector tests to verify RED**

Run:

```bash
node --import=tsx --test test/claude/claude-replay-collector.test.ts
```

Expected: FAIL because the Claude replay model and collector do not exist.

- [x] **Step 5: Define the exact Claude replay model**

Create `src/platforms/claude/replay-model.ts`:

```ts
export type ClaudeReplayStatus =
  | "pending"
  | "success"
  | "failure"
  | "error"
  | "timeout"
  | "cancelled";

export interface ClaudeReplayMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  ordinal: number;
  streamId: string;
}

export interface ClaudeReplayToolCall {
  sourceCallId: string;
  toolName: string;
  input: unknown;
  output?: string;
  status?: ClaudeReplayStatus;
  durationMs?: number;
  timestamp: string;
  ordinal: number;
}

export interface ClaudeReplayStep {
  localStepId: string;
  sourceAssistantMessageId: string;
  streamId: string;
  timestamp: string;
  ordinal: number;
  reasoning: string;
  actionTaken: string;
  result?: string;
  toolCalls: ClaudeReplayToolCall[];
}

export interface ClaudeReplaySession {
  sourceSessionId: string;
  projectDirectory: string;
  sourceStartedAt?: string;
  messages: ClaudeReplayMessage[];
  steps: ClaudeReplayStep[];
}

export interface ClaudeReplayCollection {
  sessions: ClaudeReplaySession[];
  discoveredFiles: number;
  matchedFiles: number;
  skippedFiles: number;
  malformedLines: number;
  unsupportedRecords: number;
}

export interface ClaudeReplayFileProgress {
  path: string;
  status: "imported" | "skipped";
}

export interface CollectClaudeReplayInput {
  importRoot: string;
  transcriptPaths?: string[];
  env?: NodeJS.ProcessEnv;
  onFileProcessed?: (event: ClaudeReplayFileProgress) => void;
}
```

- [x] **Step 6: Implement complete-corpus Claude collection**

Create `src/platforms/claude/replay-collector.ts`. Use the following exact top-level structure and functions; keep every helper in this Claude file rather than extracting it beside the Codex collector:

```ts
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  discoverRegularJsonlFiles,
  isDirectoryWithinImportRoot,
  normalizeAbsolutePath,
} from "../../runtime/replay-files.js";
import { homeDirectory } from "../../runtime/paths.js";
import { firstString, isPlainObject } from "../../runtime/util.js";
import type {
  ClaudeReplayCollection,
  ClaudeReplayMessage,
  ClaudeReplaySession,
  ClaudeReplayStatus,
  ClaudeReplayStep,
  ClaudeReplayToolCall,
  CollectClaudeReplayInput,
} from "./replay-model.js";

interface SourceRecord {
  value: Record<string, unknown>;
  ordinal: number;
}

interface ParsedTranscript {
  path: string;
  records: SourceRecord[];
  malformedLines: number;
  unsupportedRecords: number;
  sessionId?: string;
  streamId?: string;
  isRoot: boolean;
  projectDirectory?: string;
  sourceStartedAt?: string;
  parentCallId?: string;
}

interface AssistantGroup {
  sourceAssistantMessageId: string;
  streamId: string;
  transcriptPath: string;
  records: SourceRecord[];
  text: string[];
  tools: Array<{ block: Record<string, unknown>; record: SourceRecord; blockIndex: number }>;
}

interface OutputPart {
  value: string;
  timestamp: string;
  ordinal: number;
  transcriptPath: string;
}

interface CallBuilder extends ClaudeReplayToolCall {
  streamId: string;
  sourceAssistantUuid?: string;
  outputParts: OutputPart[];
  callTimestampMs?: number;
  lastOutputTimestampMs?: number;
  finalStatus?: ClaudeReplayStatus;
}

interface StepBuilder extends Omit<ClaudeReplayStep, "toolCalls"> {
  transcriptPath: string;
  toolCalls: CallBuilder[];
}

interface NormalizedSession {
  session?: ClaudeReplaySession;
  importedPaths: Set<string>;
  unsupportedRecords: number;
}

export async function discoverClaudeTranscriptPaths(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const configured = firstString(env.CLAUDE_CONFIG_DIR);
  const home = homeDirectory(env);
  if (configured === undefined && home === undefined) return [];
  const claudeRoot = path.resolve(configured ?? path.join(home as string, ".claude"));
  return discoverRegularJsonlFiles([path.join(claudeRoot, "projects")]);
}

export async function collectClaudeReplaySessions(
  input: CollectClaudeReplayInput,
): Promise<ClaudeReplayCollection> {
  const importRoot = path.resolve(input.importRoot);
  let transcriptPaths: string[];
  try {
    transcriptPaths = [...(
      input.transcriptPaths ?? await discoverClaudeTranscriptPaths(input.env)
    )].map((candidate) => path.resolve(candidate)).sort();
  } catch {
    throw new Error("Unable to discover Claude transcripts");
  }

  const parsed: ParsedTranscript[] = [];
  let malformedLines = 0;
  let unsupportedRecords = 0;
  for (const transcriptPath of transcriptPaths) {
    const transcript = await parseTranscript(transcriptPath);
    parsed.push(transcript);
    malformedLines += transcript.malformedLines;
    unsupportedRecords += transcript.unsupportedRecords;
  }

  const groups = new Map<string, ParsedTranscript[]>();
  for (const file of parsed) {
    if (file.sessionId === undefined) continue;
    const files = groups.get(file.sessionId) ?? [];
    files.push(file);
    groups.set(file.sessionId, files);
  }

  const sessions: ClaudeReplaySession[] = [];
  const importedPaths = new Set<string>();
  for (const [sessionId, files] of groups) {
    const normalized = await normalizeSession(sessionId, files, importRoot);
    unsupportedRecords += normalized.unsupportedRecords;
    if (normalized.session !== undefined) sessions.push(normalized.session);
    for (const importedPath of normalized.importedPaths) importedPaths.add(importedPath);
  }

  for (const transcriptPath of transcriptPaths) {
    const status = importedPaths.has(transcriptPath) ? "imported" : "skipped";
    input.onFileProcessed?.({ path: transcriptPath, status });
  }

  sessions.sort((left, right) =>
    (left.sourceStartedAt ?? "").localeCompare(right.sourceStartedAt ?? "")
    || left.sourceSessionId.localeCompare(right.sourceSessionId)
  );
  return {
    sessions,
    discoveredFiles: transcriptPaths.length,
    matchedFiles: importedPaths.size,
    skippedFiles: transcriptPaths.length - importedPaths.size,
    malformedLines,
    unsupportedRecords,
  };
}

async function parseTranscript(transcriptPath: string): Promise<ParsedTranscript> {
  let contents: string;
  try {
    contents = await readFile(transcriptPath, "utf8");
  } catch {
    throw new Error("Unable to read Claude transcript");
  }
  const records: SourceRecord[] = [];
  let malformedLines = 0;
  let unsupportedRecords = 0;
  for (const [ordinal, line] of contents.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isPlainObject(value)) records.push({ value, ordinal });
      else unsupportedRecords += 1;
    } catch {
      malformedLines += 1;
    }
  }

  const sessionId = records
    .map((record) => firstString(record.value.sessionId, record.value.session_id))
    .find((value) => value !== undefined);
  const sidechain = records
    .map((record) => typeof record.value.isSidechain === "boolean" ? record.value.isSidechain : undefined)
    .find((value) => value !== undefined);
  const agentId = records
    .map((record) => firstString(record.value.agentId))
    .find((value) => value !== undefined);
  const isRoot = sidechain !== true;
  const streamId = isRoot ? "root" : agentId === undefined ? undefined : `agent:${agentId}`;
  const projectDirectory = isRoot ? firstAbsoluteCwd(records) : undefined;
  const sourceStartedAt = records
    .map((record) => firstString(record.value.timestamp, record.value.createdAt))
    .find((value) => value !== undefined);
  const parentCallId = isRoot ? undefined : await readParentCallId(transcriptPath);
  if (!isRoot && streamId === undefined) unsupportedRecords += 1;

  return {
    path: transcriptPath,
    records,
    malformedLines,
    unsupportedRecords,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(streamId !== undefined ? { streamId } : {}),
    isRoot,
    ...(projectDirectory !== undefined ? { projectDirectory } : {}),
    ...(sourceStartedAt !== undefined ? { sourceStartedAt } : {}),
    ...(parentCallId !== undefined ? { parentCallId } : {}),
  };
}

async function readParentCallId(transcriptPath: string): Promise<string | undefined> {
  const metaPath = transcriptPath.replace(/\.jsonl$/, ".meta.json");
  try {
    const value: unknown = JSON.parse(await readFile(metaPath, "utf8"));
    return isPlainObject(value) ? firstString(value.toolUseId) : undefined;
  } catch {
    return undefined;
  }
}

function firstAbsoluteCwd(records: SourceRecord[]): string | undefined {
  for (const record of records) {
    const cwd = normalizeAbsolutePath(record.value.cwd);
    if (cwd !== undefined) return cwd;
  }
  return undefined;
}

async function normalizeSession(
  sessionId: string,
  files: ParsedTranscript[],
  importRoot: string,
): Promise<NormalizedSession> {
  const root = files.find((file) => file.isRoot && file.streamId === "root");
  if (
    root?.projectDirectory === undefined
    || !isDirectoryWithinImportRoot(importRoot, root.projectDirectory)
  ) {
    return { importedPaths: new Set(), unsupportedRecords: 0 };
  }

  const eligibleFiles = files.filter((file) => file.streamId !== undefined);
  const activeByPath = new Map(
    eligibleFiles.map((file) => [file.path, activeUuids(file.records)]),
  );
  const groups = assistantGroups(eligibleFiles, activeByPath);
  const steps: StepBuilder[] = [];
  const callsByScopedId = new Map<string, CallBuilder>();
  const callsBySourceId = new Map<string, CallBuilder[]>();
  let unsupportedRecords = 0;

  for (const group of groups) {
    if (group.tools.length === 0) continue;
    const first = group.records[0];
    const timestamp = firstString(first.value.timestamp) ?? "";
    const step: StepBuilder = {
      localStepId: `${sessionId}:${group.streamId}:${group.sourceAssistantMessageId}`,
      sourceAssistantMessageId: group.sourceAssistantMessageId,
      streamId: group.streamId,
      transcriptPath: group.transcriptPath,
      timestamp,
      ordinal: first.ordinal * 1000,
      reasoning: group.text.join("\n").trim()
        || "Claude exposed a tool-use step in the persisted transcript.",
      actionTaken: "",
      toolCalls: [],
    };
    for (const tool of group.tools) {
      const sourceCallId = firstString(tool.block.id);
      const toolName = firstString(tool.block.name);
      if (sourceCallId === undefined || toolName === undefined) {
        unsupportedRecords += 1;
        continue;
      }
      const call: CallBuilder = {
        sourceCallId,
        toolName,
        input: tool.block.input ?? {},
        timestamp: firstString(tool.record.value.timestamp) ?? timestamp,
        ordinal: tool.record.ordinal * 1000 + tool.blockIndex,
        streamId: group.streamId,
        sourceAssistantUuid: firstString(tool.record.value.uuid),
        outputParts: [],
        callTimestampMs: timestampMs(firstString(tool.record.value.timestamp)),
      };
      step.toolCalls.push(call);
      const scoped = callKey(group.streamId, sourceCallId);
      if (callsByScopedId.has(scoped)) unsupportedRecords += 1;
      else callsByScopedId.set(scoped, call);
      const sameId = callsBySourceId.get(sourceCallId) ?? [];
      sameId.push(call);
      callsBySourceId.set(sourceCallId, sameId);
    }
    if (step.toolCalls.length > 0) steps.push(step);
  }

  for (const file of eligibleFiles) {
    for (const record of file.records) {
      const content = messageContent(record.value);
      if (Array.isArray(content)) {
        for (const block of content.filter(isPlainObject)) {
          if (block.type !== "tool_result") continue;
          const sourceCallId = firstString(block.tool_use_id);
          const call = sourceCallId === undefined || file.streamId === undefined
            ? undefined
            : callsByScopedId.get(callKey(file.streamId, sourceCallId));
          if (call === undefined) {
            unsupportedRecords += 1;
            continue;
          }
          const sourceAssistantUuid = firstString(
            record.value.sourceToolAssistantUUID,
            record.value.parentUuid,
          );
          if (
            sourceAssistantUuid !== undefined
            && call.sourceAssistantUuid !== undefined
            && sourceAssistantUuid !== call.sourceAssistantUuid
          ) {
            unsupportedRecords += 1;
            continue;
          }
          const normalized = await directResultParts(record, block, file, sessionId);
          unsupportedRecords += normalized.unsupportedRecords;
          call.outputParts.push(...normalized.parts);
          call.lastOutputTimestampMs = timestampMs(firstString(record.value.timestamp))
            ?? call.lastOutputTimestampMs;
          if (block.is_error === true) call.status = "error";
          else if (isAsyncResult(record.value.toolUseResult)) call.status = "pending";
          else call.status = "success";
        }
      }

      const notification = taskNotificationResult(record.value);
      if (notification === undefined) continue;
      const matching = callsBySourceId.get(notification.sourceCallId) ?? [];
      if (matching.length !== 1) {
        unsupportedRecords += 1;
        continue;
      }
      const [call] = matching;
      if (notification.result !== "") {
        call.outputParts.push({
          value: notification.result,
          timestamp: firstString(record.value.timestamp) ?? "",
          ordinal: record.ordinal * 1000,
          transcriptPath: file.path,
        });
      }
      call.lastOutputTimestampMs = timestampMs(firstString(record.value.timestamp))
        ?? call.lastOutputTimestampMs;
      call.finalStatus = notification.status;
    }
  }

  const includedPaths = linkedTranscriptClosure(eligibleFiles, root.path, steps);
  const includedSteps = steps.filter((step) => includedPaths.has(step.transcriptPath));
  for (const step of includedSteps) {
    step.toolCalls.sort(compareTimeline);
    for (const call of step.toolCalls) {
      call.outputParts.sort(compareOutputPart);
      const values = call.outputParts.map((part) => part.value).filter((value) => value !== "");
      if (values.length > 0) call.output = values.join("\n\n");
      call.status = call.finalStatus ?? call.status;
      call.durationMs = elapsedMs(call.callTimestampMs, call.lastOutputTimestampMs);
    }
    step.actionTaken = `Ran ${step.toolCalls.length} tool ${step.toolCalls.length === 1 ? "call" : "calls"}: ${
      step.toolCalls.map((call) => call.toolName).join(", ")
    }`;
    if (step.toolCalls.some((call) => call.status !== undefined)) {
      step.result = `Tool statuses: ${step.toolCalls.map((call) => call.status ?? "unknown").join(", ")}`;
    }
  }

  const messages = rootMessages(root, activeByPath.get(root.path) ?? new Set());
  if (messages.length === 0 && includedSteps.length === 0) {
    return { importedPaths: new Set(), unsupportedRecords };
  }
  messages.sort(compareTimeline);
  includedSteps.sort(compareTimeline);
  const session: ClaudeReplaySession = {
    sourceSessionId: sessionId,
    projectDirectory: root.projectDirectory,
    ...(root.sourceStartedAt !== undefined ? { sourceStartedAt: root.sourceStartedAt } : {}),
    messages,
    steps: includedSteps.map((step) => ({
      localStepId: step.localStepId,
      sourceAssistantMessageId: step.sourceAssistantMessageId,
      streamId: step.streamId,
      timestamp: step.timestamp,
      ordinal: step.ordinal,
      reasoning: step.reasoning,
      actionTaken: step.actionTaken,
      ...(step.result !== undefined ? { result: step.result } : {}),
      toolCalls: step.toolCalls.map((call) => ({
        sourceCallId: call.sourceCallId,
        toolName: call.toolName,
        input: call.input,
        ...(call.output !== undefined ? { output: call.output } : {}),
        ...(call.status !== undefined ? { status: call.status } : {}),
        ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
        timestamp: call.timestamp,
        ordinal: call.ordinal,
      })),
    })),
  };
  return { session, importedPaths: includedPaths, unsupportedRecords };
}
```

Continue the same file with these exact extraction, linkage, output, and ordering helpers:

```ts
function activeUuids(records: SourceRecord[]): Set<string> {
  const byUuid = new Map<string, SourceRecord>();
  for (const record of records) {
    const uuid = firstString(record.value.uuid);
    if (uuid !== undefined) byUuid.set(uuid, record);
  }
  const active = new Set<string>();
  let current = [...records].reverse().find((record) => firstString(record.value.uuid) !== undefined);
  while (current !== undefined) {
    const uuid = firstString(current.value.uuid);
    if (uuid === undefined || active.has(uuid)) break;
    active.add(uuid);
    const parentUuid = firstString(current.value.parentUuid);
    current = parentUuid === undefined ? undefined : byUuid.get(parentUuid);
  }
  return active;
}

function assistantGroups(
  files: ParsedTranscript[],
  activeByPath: Map<string, Set<string>>,
): AssistantGroup[] {
  const result: AssistantGroup[] = [];
  for (const file of files) {
    if (file.streamId === undefined) continue;
    const active = activeByPath.get(file.path) ?? new Set<string>();
    const groups = new Map<string, AssistantGroup>();
    for (const record of file.records) {
      if (record.value.type !== "assistant" || !isPlainObject(record.value.message)) continue;
      const messageId = firstString(record.value.message.id);
      const uuid = firstString(record.value.uuid);
      if (messageId === undefined || (active.size > 0 && (uuid === undefined || !active.has(uuid)))) continue;
      let group = groups.get(messageId);
      if (group === undefined) {
        group = {
          sourceAssistantMessageId: messageId,
          streamId: file.streamId,
          transcriptPath: file.path,
          records: [],
          text: [],
          tools: [],
        };
        groups.set(messageId, group);
      }
      group.records.push(record);
      const content = messageContent(record.value);
      if (!Array.isArray(content)) continue;
      for (const [blockIndex, block] of content.entries()) {
        if (!isPlainObject(block)) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
          group.text.push(block.text);
        } else if (block.type === "tool_use") {
          group.tools.push({ block, record, blockIndex });
        }
      }
    }
    result.push(...groups.values());
  }
  return result;
}

function rootMessages(root: ParsedTranscript, active: Set<string>): ClaudeReplayMessage[] {
  const messages: ClaudeReplayMessage[] = [];
  const groups = assistantGroups([root], new Map([[root.path, active]]));
  for (const record of root.records) {
    const uuid = firstString(record.value.uuid);
    if (active.size > 0 && (uuid === undefined || !active.has(uuid))) continue;
    if (record.value.type !== "user" || record.value.isSidechain === true) continue;
    if (!isPlainObject(record.value.origin) || record.value.origin.kind !== "human") continue;
    const content = authoredUserContent(messageContent(record.value));
    if (content === undefined) continue;
    messages.push({
      role: "user",
      content,
      timestamp: firstString(record.value.timestamp) ?? "",
      ordinal: record.ordinal * 1000,
      streamId: "root",
    });
  }
  for (const group of groups) {
    const content = group.text.join("\n").trim();
    if (content === "") continue;
    messages.push({
      role: "assistant",
      content,
      timestamp: firstString(group.records[0].value.timestamp) ?? "",
      ordinal: group.records[0].ordinal * 1000,
      streamId: "root",
    });
  }
  return messages;
}

function authoredUserContent(value: unknown): string | undefined {
  const raw = typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.filter(isPlainObject)
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n")
      : "";
  const commandName = extractTag(raw, "command-name")?.trim();
  if (commandName !== undefined && commandName !== "") {
    const args = extractTag(raw, "command-args")?.trim() ?? "";
    return args === "" ? commandName : `${commandName} ${args}`;
  }
  const content = raw.trim();
  return content === "" ? undefined : content;
}

function linkedTranscriptClosure(
  files: ParsedTranscript[],
  rootPath: string,
  steps: StepBuilder[],
): Set<string> {
  const included = new Set([rootPath]);
  let changed = true;
  while (changed) {
    changed = false;
    const includedCalls = new Set(
      steps.filter((step) => included.has(step.transcriptPath))
        .flatMap((step) => step.toolCalls.map((call) => call.sourceCallId)),
    );
    for (const file of files) {
      if (included.has(file.path) || file.isRoot) continue;
      if (file.parentCallId === undefined || includedCalls.has(file.parentCallId)) {
        included.add(file.path);
        changed = true;
      }
    }
  }
  return included;
}

async function directResultParts(
  record: SourceRecord,
  block: Record<string, unknown>,
  file: ParsedTranscript,
  sessionId: string,
): Promise<{ parts: OutputPart[]; unsupportedRecords: number }> {
  const timestamp = firstString(record.value.timestamp) ?? "";
  const toolUseResult = isPlainObject(record.value.toolUseResult)
    ? record.value.toolUseResult
    : undefined;
  const persisted = toolUseResult === undefined
    ? undefined
    : firstString(toolUseResult.persistedOutputPath);
  if (persisted !== undefined && toolUseResult !== undefined) {
    const complete = await readPersistedOutput(file.path, sessionId, persisted, toolUseResult);
    if (complete !== undefined) {
      return {
        parts: [{ value: complete, timestamp, ordinal: record.ordinal * 1000, transcriptPath: file.path }],
        unsupportedRecords: 0,
      };
    }
  }
  return {
    parts: outputValues(block.content).map((value, index) => ({
      value,
      timestamp,
      ordinal: record.ordinal * 1000 + index,
      transcriptPath: file.path,
    })),
    unsupportedRecords: persisted === undefined ? 0 : 1,
  };
}

async function readPersistedOutput(
  transcriptPath: string,
  sessionId: string,
  recordedPath: string,
  toolUseResult: Record<string, unknown>,
): Promise<string | undefined> {
  const basename = path.basename(recordedPath);
  if (basename === "" || basename === "." || basename === "..") return undefined;
  const sessionDirectory = findSessionDirectory(transcriptPath, sessionId)
    ?? path.join(path.dirname(transcriptPath), sessionId);
  const candidate = path.join(sessionDirectory, "tool-results", basename);
  try {
    const metadata = await lstat(candidate);
    const expectedSize = finiteNumber(toolUseResult.persistedOutputSize);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || expectedSize === undefined
      || metadata.size !== expectedSize
    ) {
      return undefined;
    }
    const resolvedSession = await realpath(sessionDirectory);
    const resolvedCandidate = await realpath(candidate);
    if (!isDirectoryWithinImportRoot(resolvedSession, path.dirname(resolvedCandidate))) {
      return undefined;
    }
    const stdout = (await readFile(resolvedCandidate)).toString("utf8");
    const stderr = firstString(toolUseResult.stderr);
    return stderr === undefined || stderr === "" ? stdout : `${stdout}\n${stderr}`;
  } catch {
    return undefined;
  }
}

function findSessionDirectory(transcriptPath: string, sessionId: string): string | undefined {
  let current = path.dirname(transcriptPath);
  while (path.dirname(current) !== current) {
    if (path.basename(current) === sessionId) return current;
    current = path.dirname(current);
  }
  return undefined;
}

function outputValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return value === undefined ? [] : [stableSerialize(value)];
  return value.map((part) => {
    if (isPlainObject(part) && part.type === "text" && typeof part.text === "string") {
      return part.text;
    }
    return stableSerialize(part);
  });
}

function taskNotificationResult(value: Record<string, unknown>): {
  sourceCallId: string;
  result: string;
  status?: ClaudeReplayStatus;
} | undefined {
  if (value.type !== "user" || !isPlainObject(value.origin) || value.origin.kind !== "task-notification") {
    return undefined;
  }
  const content = messageContent(value);
  if (typeof content !== "string" || !content.trimStart().startsWith("<task-notification>")) {
    return undefined;
  }
  const sourceCallId = extractTag(content, "tool-use-id")?.trim();
  if (sourceCallId === undefined || sourceCallId === "") return undefined;
  const status = normalizeNotificationStatus(extractTag(content, "status"));
  return {
    sourceCallId,
    result: extractTag(content, "result") ?? "",
    ...(status !== undefined ? { status } : {}),
  };
}

function extractTag(value: string, tag: string): string | undefined {
  const opening = `<${tag}>`;
  const closing = `</${tag}>`;
  const start = value.indexOf(opening);
  const end = value.lastIndexOf(closing);
  if (start < 0 || end < start + opening.length) return undefined;
  return value.slice(start + opening.length, end);
}

function normalizeNotificationStatus(value: string | undefined): ClaudeReplayStatus | undefined {
  switch (value?.trim().toLowerCase()) {
    case "completed": return "success";
    case "failed": return "failure";
    case "error": return "error";
    case "timed_out":
    case "timeout": return "timeout";
    case "cancelled":
    case "canceled": return "cancelled";
    case "pending":
    case "running": return "pending";
    default: return undefined;
  }
}

function isAsyncResult(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const status = firstString(value.status)?.toLowerCase();
  return value.isAsync === true || status === "async_launched" || status === "running";
}

function messageContent(value: Record<string, unknown>): unknown {
  return isPlainObject(value.message) ? value.message.content : undefined;
}

function callKey(streamId: string, sourceCallId: string): string {
  return `${streamId}\n${sourceCallId}`;
}

function stableSerialize(value: unknown): string {
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

function elapsedMs(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

function timestampMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteNumber(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

function compareTimeline(
  left: { timestamp: string; streamId?: string; ordinal: number },
  right: { timestamp: string; streamId?: string; ordinal: number },
): number {
  return left.timestamp.localeCompare(right.timestamp)
    || (left.streamId ?? "").localeCompare(right.streamId ?? "")
    || left.ordinal - right.ordinal;
}

function compareOutputPart(left: OutputPart, right: OutputPart): number {
  return left.timestamp.localeCompare(right.timestamp)
    || left.transcriptPath.localeCompare(right.transcriptPath)
    || left.ordinal - right.ordinal;
}
```

Do not add a Claude import to any Codex replay source file. Files without a usable `sessionId` remain ungrouped and receive a skipped-file progress event.

- [x] **Step 7: Run collector tests to verify GREEN**

Run:

```bash
node --import=tsx --test \
  test/claude/claude-replay-collector.test.ts \
  test/replay-files.test.ts
```

Expected: PASS with session grouping, active-branch filtering, root-only messages, multi-call response grouping, direct and late output accumulation, linked subagent steps, full persisted output, discovery, and malformed/orphan counts.

- [x] **Step 8: Commit the Claude collector**

```bash
git add \
  src/platforms/claude/replay-model.ts \
  src/platforms/claude/replay-collector.ts \
  test/support/claude-rollout-fixture.ts \
  test/claude/claude-replay-collector.test.ts
git commit -m "feat: assemble Claude replay sessions"
```

### Task 2: Private Claude Replay Outbox

**Files:**
- Modify: `src/platforms/claude/replay-model.ts`
- Create: `src/platforms/claude/replay-outbox.ts`
- Create: `test/claude/claude-replay-outbox.test.ts`
- Existing helper: `src/runtime/permissions.ts`

**Interfaces:**
- Consumes: `ClaudeReplaySession[]`, `ensurePrivateDirectory()`, and `writePrivateFile()`.
- Produces: `ClaudeReplayOutboxRecord`, `ClaudeReplayOutbox`, `createClaudeReplayOutbox(input)`, `readClaudeReplayOutbox(path)`, `validateClaudeReplayOutboxReferences(records)`, and `removeClaudeReplayOutbox(outbox)`.

- [x] **Step 1: Write failing Claude outbox tests**

Create `test/claude/claude-replay-outbox.test.ts`:

```ts
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ClaudeReplaySession } from "../../src/platforms/claude/replay-model.js";
import {
  createClaudeReplayOutbox,
  readClaudeReplayOutbox,
  removeClaudeReplayOutbox,
  validateClaudeReplayOutboxReferences,
} from "../../src/platforms/claude/replay-outbox.js";

function sessions(): ClaudeReplaySession[] {
  return [{
    sourceSessionId: "session-1",
    projectDirectory: "/project",
    sourceStartedAt: "2026-08-26T12:00:00.000Z",
    messages: [{
      role: "user",
      content: "Build it.",
      timestamp: "2026-08-26T12:00:01.000Z",
      ordinal: 1,
      streamId: "root",
    }],
    steps: [{
      localStepId: "session-1:root:message-1",
      sourceAssistantMessageId: "message-1",
      streamId: "root",
      timestamp: "2026-08-26T12:00:02.000Z",
      ordinal: 2,
      reasoning: "Visible operation",
      actionTaken: "Ran 2 tool calls: Agent, Read",
      result: "Tool statuses: success, success",
      toolCalls: [{
        sourceCallId: "call-1",
        toolName: "Agent",
        input: { prompt: "inspect" },
        output: "Agent launched.\n\nAgent completed.",
        status: "success",
        durationMs: 5000,
        timestamp: "2026-08-26T12:00:02.100Z",
        ordinal: 3,
      }, {
        sourceCallId: "call-2",
        toolName: "Read",
        input: { file_path: "src/a.ts" },
        output: "contents",
        status: "success",
        timestamp: "2026-08-26T12:00:02.200Z",
        ordinal: 4,
      }],
    }],
  }];
}

test("writes validates and removes a private deterministic Claude outbox", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-outbox-"));
  const temporaryRoot = path.join(fixture, "temporary-root");
  await mkdir(temporaryRoot);
  const outbox = await createClaudeReplayOutbox({ sessions: sessions(), temporaryRoot });
  try {
    const records = await readClaudeReplayOutbox(outbox.path);
    validateClaudeReplayOutboxReferences(records);
    assert.deepEqual(records.map((record) => record.kind), [
      "conversation.create",
      "message.add",
      "reasoningStep.create",
      "toolCall.create",
      "toolCall.create",
    ]);
    assert.equal((await stat(outbox.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(outbox.path)).mode & 0o777, 0o600);
    assert.equal(path.basename(outbox.directory).startsWith("nams-hooks-claude-replay-"), true);
    assert.equal(outbox.recordCount, 5);
  } finally {
    await removeClaudeReplayOutbox(outbox);
    await rm(fixture, { recursive: true, force: true });
  }
  await assert.rejects(access(outbox.directory), { code: "ENOENT" });
});

test("rejects invalid shapes and forward references before delivery", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-outbox-invalid-"));
  try {
    const invalidShapePath = path.join(fixture, "invalid-shape.jsonl");
    await writeFile(invalidShapePath, [
      JSON.stringify({
        kind: "conversation.create",
        localConversationId: "conversation:session-1",
        sourceSessionId: "session-1",
        projectDirectory: "/project",
      }),
      JSON.stringify({ kind: "unknown" }),
      "",
    ].join("\n"), "utf8");
    await assert.rejects(
      readClaudeReplayOutbox(invalidShapePath),
      new Error("Invalid Claude replay outbox record at line 2"),
    );

    assert.throws(
      () => validateClaudeReplayOutboxReferences([{
        kind: "message.add",
        localConversationId: "conversation:missing",
        role: "assistant",
        content: "not deliverable",
      }]),
      new Error("Invalid Claude replay outbox conversation reference at line 1"),
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run the outbox tests to verify RED**

Run:

```bash
node --import=tsx --test test/claude/claude-replay-outbox.test.ts
```

Expected: FAIL because the Claude outbox types and module do not exist.

- [x] **Step 3: Add Claude-only outbox types**

Append to `src/platforms/claude/replay-model.ts`:

```ts
export type ClaudeReplayOutboxRecord =
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
      status?: ClaudeReplayStatus;
      durationMs?: number;
    };

export interface ClaudeReplayOutbox {
  directory: string;
  path: string;
  recordCount: number;
}

export interface CreateClaudeReplayOutboxInput {
  sessions: ClaudeReplaySession[];
  temporaryRoot?: string;
}
```

- [x] **Step 4: Implement the Claude-specific outbox**

Create `src/platforms/claude/replay-outbox.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensurePrivateDirectory,
  writePrivateFile,
} from "../../runtime/permissions.js";
import type {
  ClaudeReplayOutbox,
  ClaudeReplayOutboxRecord,
  ClaudeReplaySession,
  ClaudeReplayStatus,
  CreateClaudeReplayOutboxInput,
} from "./replay-model.js";

export function claudeReplayOutboxRecords(
  sessions: ClaudeReplaySession[],
): ClaudeReplayOutboxRecord[] {
  const records: ClaudeReplayOutboxRecord[] = [];
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
      ...session.messages.map((value) => ({ kind: "message" as const, value })),
      ...session.steps.map((value) => ({ kind: "step" as const, value })),
    ].sort((left, right) =>
      left.value.timestamp.localeCompare(right.value.timestamp)
      || left.value.streamId.localeCompare(right.value.streamId)
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

export async function createClaudeReplayOutbox(
  input: CreateClaudeReplayOutboxInput,
): Promise<ClaudeReplayOutbox> {
  const records = claudeReplayOutboxRecords(input.sessions);
  const contents = records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(
      input.temporaryRoot ?? tmpdir(),
      "nams-hooks-claude-replay-",
    ));
    await ensurePrivateDirectory(directory);
    const outboxPath = path.join(directory, "outbox.jsonl");
    await writePrivateFile(outboxPath, contents);
    return { directory, path: outboxPath, recordCount: records.length };
  } catch {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new Error("Unable to create Claude replay outbox");
  }
}

export async function readClaudeReplayOutbox(
  outboxPath: string,
): Promise<ClaudeReplayOutboxRecord[]> {
  let contents: string;
  try {
    contents = await readFile(outboxPath, "utf8");
  } catch {
    throw new Error("Unable to read Claude replay outbox");
  }
  const records: ClaudeReplayOutboxRecord[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isClaudeReplayOutboxRecord(parsed)) throw new Error("invalid");
      records.push(parsed);
    } catch {
      throw new Error(`Invalid Claude replay outbox record at line ${index + 1}`);
    }
  }
  return records;
}

export function validateClaudeReplayOutboxReferences(
  records: ClaudeReplayOutboxRecord[],
): void {
  const conversations = new Set<string>();
  const steps = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (record.kind === "conversation.create") {
      conversations.add(record.localConversationId);
    } else if (record.kind === "message.add") {
      if (!conversations.has(record.localConversationId)) {
        throw new Error(`Invalid Claude replay outbox conversation reference at line ${index + 1}`);
      }
    } else if (record.kind === "reasoningStep.create") {
      if (!conversations.has(record.localConversationId)) {
        throw new Error(`Invalid Claude replay outbox conversation reference at line ${index + 1}`);
      }
      steps.add(record.localStepId);
    } else if (!steps.has(record.localStepId)) {
      throw new Error(`Invalid Claude replay outbox reasoning step reference at line ${index + 1}`);
    }
  }
}

export async function removeClaudeReplayOutbox(
  outbox: ClaudeReplayOutbox,
): Promise<void> {
  if (
    path.dirname(outbox.path) !== outbox.directory
    || path.basename(outbox.path) !== "outbox.jsonl"
    || !path.basename(outbox.directory).startsWith("nams-hooks-claude-replay-")
  ) {
    throw new Error("Invalid Claude replay outbox cleanup handle");
  }
  try {
    await rm(outbox.directory, { recursive: true, force: true });
  } catch {
    throw new Error("Unable to remove Claude replay outbox");
  }
}

const statuses = new Set<ClaudeReplayStatus>([
  "pending", "success", "failure", "error", "timeout", "cancelled",
]);

function isClaudeReplayOutboxRecord(value: unknown): value is ClaudeReplayOutboxRecord {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "conversation.create") {
    return hasStrings(value, ["localConversationId", "sourceSessionId", "projectDirectory"])
      && optionalString(value.sourceStartedAt);
  }
  if (value.kind === "message.add") {
    return hasStrings(value, ["localConversationId", "content"])
      && (value.role === "user" || value.role === "assistant");
  }
  if (value.kind === "reasoningStep.create") {
    return hasStrings(value, ["localConversationId", "localStepId", "reasoning", "actionTaken"])
      && optionalString(value.result);
  }
  if (value.kind === "toolCall.create") {
    return hasStrings(value, ["localStepId", "toolName"])
      && Object.hasOwn(value, "input")
      && optionalString(value.output)
      && (value.status === undefined
        || (typeof value.status === "string" && statuses.has(value.status as ClaudeReplayStatus)))
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

- [x] **Step 5: Run the outbox tests to verify GREEN**

Run:

```bash
node --import=tsx --test test/claude/claude-replay-outbox.test.ts
```

Expected: PASS with deterministic projection, complete reference validation, private modes, Claude-specific prefix, and safe cleanup.

- [x] **Step 6: Commit the Claude outbox**

```bash
git add \
  src/platforms/claude/replay-model.ts \
  src/platforms/claude/replay-outbox.ts \
  test/claude/claude-replay-outbox.test.ts
git commit -m "feat: materialize private Claude replay outbox"
```

### Task 3: Claude-Specific Fail-Fast NAMS Sender

**Files:**
- Create: `src/platforms/claude/replay-sender.ts`
- Create: `test/support/claude-nams-replay-environment.ts`
- Create: `test/claude/claude-replay-sender.test.ts`
- Modify: `src/runtime/provenance.ts`
- Modify: `test/provenance.test.ts`
- Existing: `src/platforms/claude/config.ts`
- Existing: `src/generated/nams-client.ts`
- Existing: `src/runtime/config.ts`
- Existing: `src/runtime/memory-service.ts`
- Existing: `src/runtime/workspace-configuration.ts`
- Existing: `test/support/nams-fetch-mock.ts`

**Interfaces:**
- Consumes: a complete Claude outbox path, import root, `discoverClaudeNamsConfig`, generated NAMS clients, configuration/workspace resolution, and existing tool sanitizers.
- Produces: `namsClaudeReplayProvenanceHeaders()` and `sendClaudeReplayOutbox(input): Promise<ClaudeReplaySendSummary>`.

- [x] **Step 1: Create an isolated Claude replay environment helper**

Create `test/support/claude-nams-replay-environment.ts`. Do not edit `test/support/nams-replay-environment.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const keys = [
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PLUGIN_OPTION_NAMS_API_KEY",
  "CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID",
  "CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL",
  "NAMS_API_KEY",
  "NAMS_WORKSPACE_ID",
  "NAMS_BASE_URL",
] as const;

export async function withClaudeNamsReplayEnvironment<T>(
  callback: (fixture: string) => Promise<T>,
  overrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<T> {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-replay-env-"));
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<
    (typeof keys)[number],
    string | undefined
  >;
  Object.assign(process.env, {
    HOME: fixture,
    CLAUDE_CONFIG_DIR: path.join(fixture, ".claude"),
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

- [x] **Step 2: Write failing provenance and sender tests**

Extend `test/provenance.test.ts` without changing the existing Codex test:

```ts
import {
  namsClaudeReplayProvenanceHeaders,
  namsReplayProvenanceHeaders,
} from "../src/runtime/provenance.js";

test("Claude replay provenance is separate from Codex replay provenance", () => {
  const headers = namsClaudeReplayProvenanceHeaders();
  assert.equal(headers["X-NAMS-Hooks-Harness"], "claude");
  assert.equal(headers["X-NAMS-Hooks-Command"], "replay");
  assert.equal(headers["X-NAMS-Hooks-Event"], undefined);
  assert.equal(namsReplayProvenanceHeaders()["X-NAMS-Hooks-Harness"], "codex");
});
```

Create `test/claude/claude-replay-sender.test.ts`:

```ts
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { ClaudeReplayOutboxRecord } from "../../src/platforms/claude/replay-model.js";
import { sendClaudeReplayOutbox } from "../../src/platforms/claude/replay-sender.js";
import { withClaudeNamsReplayEnvironment } from "../support/claude-nams-replay-environment.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";

async function writeOutbox(
  fixture: string,
  records: ClaudeReplayOutboxRecord[],
): Promise<string> {
  const directory = path.join(fixture, "claude-outbox-fixture");
  const outboxPath = path.join(directory, "outbox.jsonl");
  await mkdir(directory, { recursive: true });
  await writeFile(
    outboxPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return outboxPath;
}

function completeRecords(): ClaudeReplayOutboxRecord[] {
  return [{
    kind: "conversation.create",
    localConversationId: "conversation:session-1",
    sourceSessionId: "session-1",
    projectDirectory: "/project",
    sourceStartedAt: "2026-08-26T12:00:00.000Z",
  }, {
    kind: "message.add",
    localConversationId: "conversation:session-1",
    role: "user",
    content: "Build it.",
  }, {
    kind: "reasoningStep.create",
    localConversationId: "conversation:session-1",
    localStepId: "session-1:root:message-1",
    reasoning: "Visible operation",
    actionTaken: "Ran 1 tool call: Read",
    result: "Tool statuses: success",
  }, {
    kind: "toolCall.create",
    localStepId: "session-1:root:message-1",
    toolName: "Read",
    input: { file_path: "src/a.ts", output: "strip this field" },
    output: "first\n\nsecond",
    status: "success",
    durationMs: 25,
  }];
}

test("sends a complete Claude outbox sequentially with shared remote ids", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock()
      .createConversation({ id: "conversation-1" })
      .message()
      .reasoningStep({ id: "step-1" })
      .toolCall();
    const outboxPath = await writeOutbox(fixture, completeRecords());

    const summary = await sendClaudeReplayOutbox({
      outboxPath,
      importRoot: "/project",
      fetch: nams.fetch,
    });

    assert.deepEqual(summary, {
      conversations: 1,
      messages: 1,
      reasoningSteps: 1,
      toolCalls: 1,
    });
    assert.deepEqual(nams.calls().map((call) => new URL(call.url).pathname), [
      "/v1/conversations",
      "/v1/conversations/conversation-1/messages",
      "/v1/reasoning/steps",
      "/v1/reasoning/tool-calls",
    ]);
    assert.deepEqual(nams.requestBodies("createConversation")[0].metadata, {
      harness: "claude",
      projectDirectory: "/project",
      sourceSessionId: "session-1",
      importSource: "nams-hooks-replay",
      sourceStartedAt: "2026-08-26T12:00:00.000Z",
    });
    assert.equal(nams.requestBodies("addToolCall")[0].stepId, "step-1");
    assert.equal(nams.requestBodies("addToolCall")[0].input, "{\"file_path\":\"src/a.ts\"}");
    assert.equal(nams.requestBodies("addToolCall")[0].output, "first\n\nsecond");
  });
});

test("validates all Claude outbox references before configuration or network access", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock().all({ error: "must not be called" }, 500);
    const outboxPath = await writeOutbox(fixture, [{
      kind: "message.add",
      localConversationId: "conversation:missing",
      role: "assistant",
      content: "not deliverable",
    }]);
    await assert.rejects(
      sendClaudeReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
      new Error("Invalid Claude replay outbox conversation reference at line 1"),
    );
    assert.equal(nams.calls().length, 0);
  });
});

test("stops after the first failed Claude write without retry or live state", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock()
      .createConversation({ id: "conversation-1" })
      .message({ error: "failed" }, 500)
      .reasoningStep({ id: "step-1" })
      .toolCall();
    const outboxPath = await writeOutbox(fixture, completeRecords());
    await assert.rejects(
      sendClaudeReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch }),
      new Error("NAMS request failed during Claude replay"),
    );
    assert.equal(nams.calls().length, 2);
    assert.equal(nams.calls("addMessage").length, 1);
    assert.equal(nams.calls("addReasoningStep").length, 0);
    await assert.rejects(access(path.join(fixture, ".nams", "state")), { code: "ENOENT" });
    await assert.rejects(access(path.join(fixture, ".nams", "logs")), { code: "ENOENT" });
  });
});

test("uses Claude plugin configuration and auto-selects one workspace", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const nams = createNamsFetchMock()
      .workspaces({ workspaces: [{ id: "workspace-auto", name: "Auto" }] })
      .createConversation();
    const outboxPath = await writeOutbox(fixture, [completeRecords()[0]]);
    await sendClaudeReplayOutbox({ outboxPath, importRoot: "/project", fetch: nams.fetch });
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 1);
  }, {
    NAMS_API_KEY: undefined,
    NAMS_WORKSPACE_ID: undefined,
    NAMS_BASE_URL: undefined,
    CLAUDE_PLUGIN_OPTION_NAMS_API_KEY: "plugin-key",
    CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID: undefined,
    CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL: "https://memory.example.test",
  });
});
```

- [x] **Step 3: Run provenance and sender tests to verify RED**

Run:

```bash
node --import=tsx --test \
  test/provenance.test.ts \
  test/claude/claude-replay-sender.test.ts
```

Expected: FAIL because the Claude replay provenance function and sender do not exist.

- [x] **Step 4: Add separately named Claude replay provenance**

Add this function after the unchanged `namsReplayProvenanceHeaders()` in `src/runtime/provenance.ts`:

```ts
export function namsClaudeReplayProvenanceHeaders(): Record<string, string> {
  return {
    ...baseProvenanceHeaders("claude"),
    "X-NAMS-Hooks-Command": "replay",
  };
}
```

Do not add a platform parameter to `namsReplayProvenanceHeaders()` and do not update the Codex sender import or call site.

- [x] **Step 5: Implement the complete Claude sender**

Create `src/platforms/claude/replay-sender.ts`:

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
import { namsClaudeReplayProvenanceHeaders } from "../../runtime/provenance.js";
import { validWorkspaces } from "../../runtime/workspace-configuration.js";
import { discoverClaudeNamsConfig } from "./config.js";
import {
  readClaudeReplayOutbox,
  validateClaudeReplayOutboxReferences,
} from "./replay-outbox.js";

export interface SendClaudeReplayOutboxInput {
  outboxPath: string;
  importRoot: string;
  fetch?: typeof fetch;
  onProgress?: (line: string) => void;
}

export interface ClaudeReplaySendSummary {
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

export async function sendClaudeReplayOutbox(
  input: SendClaudeReplayOutboxInput,
): Promise<ClaudeReplaySendSummary> {
  const records = await readClaudeReplayOutbox(input.outboxPath);
  validateClaudeReplayOutboxReferences(records);
  const onRequest = (event: NamsRequestEvent): void => {
    input.onProgress?.(`  - ${event.method} ${event.path}`);
  };
  const destination = await resolveDestination(input, onRequest);
  const client = new NamsClient({
    ...destination,
    defaultHeaders: namsClaudeReplayProvenanceHeaders(),
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    onRequest,
  });
  const conversationIds = new Map<string, string>();
  const stepIds = new Map<string, string>();
  const summary: ClaudeReplaySendSummary = {
    conversations: 0,
    messages: 0,
    reasoningSteps: 0,
    toolCalls: 0,
  };

  for (const record of records) {
    if (record.kind === "conversation.create") {
      const response = await namsRequest(() => client.createConversation({
        metadata: {
          harness: "claude",
          projectDirectory: record.projectDirectory,
          sourceSessionId: record.sourceSessionId,
          importSource: "nams-hooks-replay",
          ...(record.sourceStartedAt !== undefined
            ? { sourceStartedAt: record.sourceStartedAt }
            : {}),
        },
      }));
      conversationIds.set(
        record.localConversationId,
        requiredId(response.id, "NAMS conversation response did not include id"),
      );
      summary.conversations += 1;
      continue;
    }
    if (record.kind === "message.add") {
      const conversationId = conversationIds.get(record.localConversationId);
      if (conversationId === undefined) {
        throw new Error("Claude replay outbox conversation reference became unavailable during delivery");
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
        throw new Error("Claude replay outbox conversation reference became unavailable during delivery");
      }
      const response = await namsRequest(() => client.recordReasoningStep({
        conversationId,
        reasoning: record.reasoning,
        actionTaken: record.actionTaken,
        ...(record.result !== undefined ? { result: record.result } : {}),
      }));
      stepIds.set(
        record.localStepId,
        requiredId(response.id, "NAMS reasoning response did not include id"),
      );
      summary.reasoningSteps += 1;
      continue;
    }
    const stepId = stepIds.get(record.localStepId);
    if (stepId === undefined) {
      throw new Error("Claude replay outbox reasoning step reference became unavailable during delivery");
    }
    const request: RecordToolCallRequest = {
      stepId,
      toolName: record.toolName,
      input: serializeToolInput(record.input),
      ...(record.output !== undefined
        ? { output: serializeToolOutput(record.output) }
        : {}),
      ...(record.status !== undefined ? { status: record.status } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    };
    await namsRequest(() => client.recordToolCall(request));
    summary.toolCalls += 1;
  }
  return summary;
}

async function resolveDestination(
  input: SendClaudeReplayOutboxInput,
  onRequest: (event: NamsRequestEvent) => void,
): Promise<ResolvedDestination> {
  let connection: NamsConnectionConfigLoadResult;
  try {
    connection = await loadNamsConnectionConfig(
      path.resolve(input.importRoot),
      discoverClaudeNamsConfig,
    );
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
    defaultHeaders: namsClaudeReplayProvenanceHeaders(),
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
    throw new Error("NAMS request failed during Claude replay");
  }
}

function requiredId(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === "") throw new Error(message);
  return value;
}
```

- [x] **Step 6: Run sender tests to verify GREEN**

Run:

```bash
node --import=tsx --test \
  test/provenance.test.ts \
  test/claude/claude-replay-sender.test.ts
```

Expected: PASS with separate Claude/Codex provenance, preflight validation, sequential delivery, sanitization, plugin configuration, workspace resolution, fail-fast/no-retry behavior, and no live state/log writes.

- [x] **Step 7: Commit the Claude sender**

```bash
git add \
  src/platforms/claude/replay-sender.ts \
  src/runtime/provenance.ts \
  test/support/claude-nams-replay-environment.ts \
  test/claude/claude-replay-sender.test.ts \
  test/provenance.test.ts
git commit -m "feat: send Claude replay outbox fail fast"
```

### Task 4: Claude Runner And Direct CLI Routing

**Files:**
- Create: `src/platforms/claude/replay-runner.ts`
- Create: `test/claude/claude-replay-runner.test.ts`
- Create: `test/cli-claude-replay.test.ts`
- Modify: `src/platforms/claude/index.ts`
- Modify: `src/cli.ts`
- Modify: `test/cli-replay.test.ts`
- Modify: `test/architecture.test.ts`

**Interfaces:**
- Consumes: the Claude collector, outbox, and sender from Tasks 1-3.
- Produces: `runClaudeReplay(input): Promise<ClaudeReplayRunSummary>`, `formatClaudeReplaySummary(summary)`, and public CLI routing for `nams-hooks replay claude [--working-dir PATH]`.

- [x] **Step 1: Write failing Claude runner lifecycle tests**

Create `test/claude/claude-replay-runner.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runClaudeReplay } from "../../src/platforms/claude/replay-runner.js";
import {
  assistantBlock,
  humanMessage,
  jsonl,
  toolResult,
} from "../support/claude-rollout-fixture.js";
import { withClaudeNamsReplayEnvironment } from "../support/claude-nams-replay-environment.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";

async function writeRunnerTranscripts(fixture: string): Promise<{
  project: string;
  temporaryRoot: string;
  rootPath: string;
  skippedPath: string;
}> {
  const project = path.join(fixture, "project");
  const temporaryRoot = path.join(fixture, "outboxes");
  const projectsRoot = path.join(process.env.CLAUDE_CONFIG_DIR as string, "projects", "encoded");
  const rootPath = path.join(projectsRoot, "a-session.jsonl");
  const skippedPath = path.join(projectsRoot, "z-outside.jsonl");
  await mkdir(projectsRoot, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  await writeFile(rootPath, jsonl([
    humanMessage({
      sessionId: "session-1", cwd: project, uuid: "user", parentUuid: "root",
      content: "Build it.", timestamp: "2026-08-26T12:00:01.000Z",
    }),
    assistantBlock({
      sessionId: "session-1", cwd: project, uuid: "call-row", parentUuid: "user",
      messageId: "message-1", block: {
        type: "tool_use", id: "call-1", name: "Read", input: { file_path: "src/a.ts" },
      }, timestamp: "2026-08-26T12:00:02.000Z",
    }),
    toolResult({
      sessionId: "session-1", cwd: project, uuid: "result", parentUuid: "call-row",
      toolUseId: "call-1", content: "contents", timestamp: "2026-08-26T12:00:03.000Z",
    }),
  ]), "utf8");
  await writeFile(skippedPath, jsonl([
    humanMessage({
      sessionId: "outside", cwd: path.join(fixture, "outside"), uuid: "outside-user",
      parentUuid: "outside-root", content: "outside",
    }),
  ]), "utf8");
  return { project, temporaryRoot, rootPath, skippedPath };
}

test("imports Claude sessions and cleans the successful outbox", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const { project, temporaryRoot, rootPath, skippedPath } = await writeRunnerTranscripts(fixture);
    const nams = createNamsFetchMock()
      .createConversation()
      .message()
      .reasoningStep()
      .toolCall();
    const progress: string[] = [];
    const summary = await runClaudeReplay({
      importRoot: project,
      temporaryRoot: path.relative(process.cwd(), temporaryRoot),
      fetch: nams.fetch,
      onProgress: (line) => progress.push(line),
    });

    assert.deepEqual(summary, {
      discoveredFiles: 2,
      matchedFiles: 1,
      skippedFiles: 1,
      sessions: 1,
      conversations: 1,
      messages: 1,
      reasoningSteps: 1,
      toolCalls: 1,
      malformedLines: 0,
      unsupportedRecords: 0,
    });
    assert.deepEqual(progress.slice(0, 2), [
      `Claude replay file imported: ${rootPath}`,
      `Claude replay file skipped: ${skippedPath}`,
    ]);
    assert.equal(
      progress[2].startsWith(
        `Claude replay outbox: ${temporaryRoot}${path.sep}nams-hooks-claude-replay-`,
      ),
      true,
    );
    assert.equal(progress[2].endsWith(`${path.sep}outbox.jsonl`), true);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("cleans a Claude outbox after fail-fast delivery", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const { project, temporaryRoot } = await writeRunnerTranscripts(fixture);
    const nams = createNamsFetchMock()
      .createConversation()
      .message({ error: "failed" }, 500)
      .reasoningStep()
      .toolCall();
    await assert.rejects(
      runClaudeReplay({ importRoot: project, temporaryRoot, fetch: nams.fetch }),
      new Error("NAMS request failed during Claude replay"),
    );
    assert.equal(nams.calls().length, 2);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("a fresh Claude restart recreates and resends the complete outbox", async () => {
  await withClaudeNamsReplayEnvironment(async (fixture) => {
    const { project, temporaryRoot } = await writeRunnerTranscripts(fixture);
    const nams = createNamsFetchMock()
      .createConversation()
      .message()
      .reasoningStep()
      .toolCall();
    await runClaudeReplay({ importRoot: project, temporaryRoot, fetch: nams.fetch });
    await runClaudeReplay({ importRoot: project, temporaryRoot, fetch: nams.fetch });
    assert.equal(nams.calls("createConversation").length, 2);
    assert.equal(nams.calls("addMessage").length, 2);
    assert.equal(nams.calls("addReasoningStep").length, 2);
    assert.equal(nams.calls("addToolCall").length, 2);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});
```

- [x] **Step 2: Write the failing Claude CLI integration test**

Create `test/cli-claude-replay.test.ts`. Keep its server and process harness in this Claude test file rather than moving the Codex CLI test helpers into shared support:

```ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assistantBlock,
  humanMessage,
  jsonl,
  toolResult,
} from "./support/claude-rollout-fixture.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, ".build", "tsc", "cli.js");

interface CapturedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

async function withClaudeNamsServer<T>(
  callback: (baseUrl: string, requests: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void respond(request, response, requests);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    return await callback(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    );
  }
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  requests: CapturedRequest[],
): Promise<void> {
  for await (const _chunk of request) {
    // Drain request bodies so the local HTTP connection can be reused.
  }
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  requests.push({ path: pathname, headers: request.headers });
  if (request.method === "POST" && pathname === "/v1/conversations") {
    return json(response, 201, { id: "conversation-1" });
  }
  if (request.method === "POST" && pathname === "/v1/conversations/conversation-1/messages") {
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
): Promise<{ code: number | null; stdout: string; stderr: string }> {
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

test("replay claude imports a session without stdin or live session state", async () => {
  await withClaudeNamsServer(async (baseUrl, requests) => {
    const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-claude-replay-"));
    try {
      const project = path.join(fixture, "project");
      const home = path.join(fixture, "home");
      const claudeRoot = path.join(fixture, "claude");
      const rootPath = path.join(claudeRoot, "projects", "encoded", "session-1.jsonl");
      await mkdir(path.dirname(rootPath), { recursive: true });
      await mkdir(project, { recursive: true });
      await writeFile(rootPath, jsonl([
        humanMessage({
          sessionId: "session-1", cwd: project, uuid: "user", parentUuid: "root",
          content: "Remember Claude replay.", timestamp: "2026-08-26T12:00:01.000Z",
        }),
        assistantBlock({
          sessionId: "session-1", cwd: project, uuid: "text", parentUuid: "user",
          messageId: "message-1", block: { type: "text", text: "I will inspect." },
          timestamp: "2026-08-26T12:00:02.000Z",
        }),
        assistantBlock({
          sessionId: "session-1", cwd: project, uuid: "call", parentUuid: "text",
          messageId: "message-1", block: {
            type: "tool_use", id: "call-1", name: "Read", input: { file_path: "src/a.ts" },
          }, timestamp: "2026-08-26T12:00:02.100Z",
        }),
        toolResult({
          sessionId: "session-1", cwd: project, uuid: "result", parentUuid: "call",
          toolUseId: "call-1", content: "contents", timestamp: "2026-08-26T12:00:03.000Z",
        }),
      ]), "utf8");

      const result = await runCli(
        ["replay", "claude", "--working-dir", project],
        project,
        {
          HOME: home,
          CLAUDE_CONFIG_DIR: claudeRoot,
          NAMS_API_KEY: "key",
          NAMS_WORKSPACE_ID: "workspace-1",
          NAMS_BASE_URL: baseUrl,
        },
        "{not-json",
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stdout,
        /Replay claude: discovered files 1, matched files 1, skipped files 0, sessions 1/,
      );
      assert.deepEqual(requests.map((request) => request.path), [
        "/v1/conversations",
        "/v1/conversations/conversation-1/messages",
        "/v1/conversations/conversation-1/messages",
        "/v1/reasoning/steps",
        "/v1/reasoning/tool-calls",
      ]);
      assert.equal(requests[0].headers["x-nams-hooks-harness"], "claude");
      assert.equal(requests[0].headers["x-nams-hooks-command"], "replay");
      assert.equal(result.stderr.includes(`Claude replay file imported: ${rootPath}\n`), true);
      const prefix = "Claude replay outbox: ";
      const outboxLine = result.stderr.split("\n").find((line) => line.startsWith(prefix));
      assert.ok(outboxLine);
      await assert.rejects(access(outboxLine.slice(prefix.length)), { code: "ENOENT" });
      await assert.rejects(access(path.join(home, ".nams", "state")), { code: "ENOENT" });
      await assert.rejects(access(path.join(home, ".nams", "logs")), { code: "ENOENT" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 3: Update failing CLI and architecture assertions**

In `test/cli-replay.test.ts`, rename `replay rejects Claude and malformed arguments` to `replay rejects unsupported platforms and malformed Codex arguments`, remove `["replay", "claude"]` from its argument table, and change its usage assertion to:

```ts
assert.match(result.stderr, /nams-hooks replay <claude\|codex> \[--working-dir PATH\]/);
```

Replace the replay architecture test in `test/architecture.test.ts` with:

```ts
test("Claude and Codex replay use separate platform entrypoints without a replay registry", async () => {
  const platformIndex = await readFile("src/platforms/index.ts", "utf8");
  const claudeIndex = await readFile("src/platforms/claude/index.ts", "utf8");
  const codexIndex = await readFile("src/platforms/codex/index.ts", "utf8");
  const claudeCollector = await readFile("src/platforms/claude/replay-collector.ts", "utf8");
  const codexCollector = await readFile("src/platforms/codex/replay-collector.ts", "utf8");
  const cli = await readFile("src/cli.ts", "utf8");
  const interfaces = await readFile("src/interfaces.ts", "utf8");

  assert.doesNotMatch(platformIndex, /ReplayPlatform|ReplayPlatformAdapter|replayAdapters/);
  assert.match(claudeIndex, /export\s+\{\s*formatClaudeReplaySummary\s*,\s*runClaudeReplay\s*,?\s*\}\s+from\s+["']\.\/replay-runner\.js["']/);
  assert.match(codexIndex, /export\s+\{\s*formatCodexReplaySummary\s*,\s*runCodexReplay\s*,?\s*\}\s+from\s+["']\.\/replay-runner\.js["']/);
  assert.match(cli, /from\s+["']\.\/platforms\/claude\/index\.js["']/);
  assert.match(cli, /from\s+["']\.\/platforms\/codex\/index\.js["']/);
  assert.doesNotMatch(cli, /getReplayPlatformAdapter|runReplay\(/);
  assert.doesNotMatch(interfaces, /ReplayPlatform|ReplayPlatformAdapter|ReplayTranscript|ReplayRecord/);
  assert.doesNotMatch(claudeCollector, /platforms\/codex|codex\/replay|CodexReplay/);
  assert.doesNotMatch(codexCollector, /platforms\/claude|claude\/replay|ClaudeReplay/);
});
```

- [x] **Step 4: Run runner, CLI, and architecture tests to verify RED**

Run:

```bash
npm run build
node --import=tsx --test \
  test/claude/claude-replay-runner.test.ts \
  test/cli-claude-replay.test.ts \
  test/cli-replay.test.ts \
  test/architecture.test.ts
```

Expected: FAIL because the Claude runner/export and CLI route do not exist, while the old tests still reject Claude and assert Codex-only replay.

- [x] **Step 5: Implement the Claude runner and summary**

Create `src/platforms/claude/replay-runner.ts`:

```ts
import path from "node:path";
import { collectClaudeReplaySessions } from "./replay-collector.js";
import type { ClaudeReplayFileProgress } from "./replay-model.js";
import {
  createClaudeReplayOutbox,
  removeClaudeReplayOutbox,
} from "./replay-outbox.js";
import { sendClaudeReplayOutbox } from "./replay-sender.js";

export interface RunClaudeReplayInput {
  importRoot: string;
  env?: NodeJS.ProcessEnv;
  temporaryRoot?: string;
  fetch?: typeof fetch;
  onProgress?: (line: string) => void;
}

export interface ClaudeReplayRunSummary {
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

export async function runClaudeReplay(
  input: RunClaudeReplayInput,
): Promise<ClaudeReplayRunSummary> {
  const collection = await collectClaudeReplaySessions({
    importRoot: input.importRoot,
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.onProgress !== undefined
      ? {
          onFileProcessed: (event: ClaudeReplayFileProgress) => {
            input.onProgress?.(`Claude replay file ${event.status}: ${event.path}`);
          },
        }
      : {}),
  });
  const outbox = await createClaudeReplayOutbox({
    sessions: collection.sessions,
    ...(input.temporaryRoot !== undefined
      ? { temporaryRoot: path.resolve(input.temporaryRoot) }
      : {}),
  });
  try {
    input.onProgress?.(`Claude replay outbox: ${outbox.path}`);
    const sent = collection.sessions.length === 0
      ? { conversations: 0, messages: 0, reasoningSteps: 0, toolCalls: 0 }
      : await sendClaudeReplayOutbox({
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
    await removeClaudeReplayOutbox(outbox);
  }
}

export function formatClaudeReplaySummary(summary: ClaudeReplayRunSummary): string {
  return [
    `Replay claude: discovered files ${summary.discoveredFiles}, matched files ${summary.matchedFiles}, skipped files ${summary.skippedFiles}, sessions ${summary.sessions};`,
    `conversations ${summary.conversations}, messages ${summary.messages}, steps ${summary.reasoningSteps}, tools ${summary.toolCalls}, malformed lines ${summary.malformedLines}, unsupported records ${summary.unsupportedRecords}.`,
  ].join(" ");
}
```

- [x] **Step 6: Export the Claude runner without changing live hooks**

Add this export immediately after the imports in `src/platforms/claude/index.ts`:

```ts
export {
  formatClaudeReplaySummary,
  runClaudeReplay,
} from "./replay-runner.js";
```

Do not alter `claudeMemoryAdapter`, payload parsing, workspace behavior, configuration discovery, or live-hook state handling.

- [x] **Step 7: Route both concrete runners directly from the CLI**

Add the Claude import next to the existing Codex import in `src/cli.ts`:

```ts
import {
  formatClaudeReplaySummary,
  runClaudeReplay,
} from "./platforms/claude/index.js";
```

Change the replay member of `CliArgs` to:

```ts
| { command: "replay"; platform: "claude" | "codex"; workingDirectory?: string }
```

Replace the replay branch in `main()` with the two explicit branches:

```ts
if (args.command === "replay") {
  const importRoot = path.resolve(args.workingDirectory ?? process.cwd());
  if (args.platform === "codex") {
    const summary = await runCodexReplay({
      importRoot,
      onProgress: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(`${formatCodexReplaySummary(summary)}\n`);
    return 0;
  }
  const summary = await runClaudeReplay({
    importRoot,
    onProgress: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${formatClaudeReplaySummary(summary)}\n`);
  return 0;
}
```

Replace the replay argument parser branch with:

```ts
if (command === "replay" && (platformArg === "claude" || platformArg === "codex")) {
  if (argv.length === 2) return { command: "replay", platform: platformArg };
  if (
    argv.length === 4
    && argv[2] === "--working-dir"
    && argv[3] !== undefined
    && argv[3].trim() !== ""
    && !argv[3].startsWith("--")
  ) {
    return { command: "replay", platform: platformArg, workingDirectory: argv[3] };
  }
  return null;
}
```

Replace only the replay usage line with:

```ts
"       nams-hooks replay <claude|codex> [--working-dir PATH]",
```

Do not introduce `ReplayPlatform`, a runner map, an adapter registry, or a shared formatter.

- [x] **Step 8: Run the complete focused replay suite**

Run:

```bash
npm run build
node --import=tsx --test \
  test/replay-files.test.ts \
  test/provenance.test.ts \
  test/claude/claude-replay-collector.test.ts \
  test/claude/claude-replay-outbox.test.ts \
  test/claude/claude-replay-sender.test.ts \
  test/claude/claude-replay-runner.test.ts \
  test/cli-claude-replay.test.ts \
  test/codex/codex-replay-collector.test.ts \
  test/codex/codex-replay-outbox.test.ts \
  test/codex/codex-replay-sender.test.ts \
  test/codex/codex-replay-runner.test.ts \
  test/cli-replay.test.ts \
  test/architecture.test.ts
```

Expected: PASS for the new isolated Claude pipeline and the unchanged Codex pipeline.

- [x] **Step 9: Prove no cross-platform replay extraction was introduced**

Run:

```bash
rg -n "CodexReplay|platforms/codex|codex/replay" src/platforms/claude test/claude test/support/claude-*
rg -n "ClaudeReplay|platforms/claude|claude/replay" src/platforms/codex test/codex test/support/codex-*
rg -n --glob '!test/architecture.test.ts' "ReplayPlatform|ReplayPlatformAdapter|replayAdapters|getReplayPlatformAdapter" src test
```

Expected: all three commands print no matches. The shared CLI and provenance files are outside these searches and contain only explicit concrete Claude/Codex imports/functions.

- [x] **Step 10: Commit the runner and CLI route**

```bash
git add \
  src/platforms/claude/replay-runner.ts \
  src/platforms/claude/index.ts \
  src/cli.ts \
  test/claude/claude-replay-runner.test.ts \
  test/cli-claude-replay.test.ts \
  test/cli-replay.test.ts \
  test/architecture.test.ts
git commit -m "feat: add isolated Claude replay command"
```

### Task 5: Record The Claude Replay Decision And Verify The Repository

**Files:**
- Modify: `docs/adr/0001-project-replay-from-source-turns-and-semantic-operations.md`
- Modify: `docs/adr/0002-codex-session-outbox-replay.md`
- Create: `docs/adr/0003-claude-session-outbox-replay.md`
- Modify: `CONTEXT.md`
- Modify: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- Plan source: `docs/plans/0007-claude-session-outbox-replay.md`

**Interfaces:**
- Consumes: the implemented Claude collector/outbox/sender/runner behavior from Tasks 1-4.
- Produces: a current Claude replay ADR and separate Claude terminology/design contract; no runtime interface.

- [x] **Step 1: Point the historical replay ADR at both current decisions**

Replace the supersession notice below the title in `docs/adr/0001-project-replay-from-source-turns-and-semantic-operations.md` with:

```markdown
> Superseded by [ADR 0002](0002-codex-session-outbox-replay.md) for Codex and [ADR 0003](0003-claude-session-outbox-replay.md) for Claude. Each harness now owns a separate temporary-outbox replay pipeline derived from its observed transcript identities and boundaries.
```

Keep the historical body and existing front matter unchanged.

- [x] **Step 2: Preserve the Codex decision while removing its stale availability claim**

Replace this paragraph in `docs/adr/0002-codex-session-outbox-replay.md`:

```markdown
Claude replay is removed because the new outbox projection is defined only from observed Codex rollout identities and boundaries. Claude live hooks remain supported and are unaffected.
```

with:

```markdown
This ADR and its implementation remain Codex-specific. [ADR 0003](0003-claude-session-outbox-replay.md) later adds Claude replay through separate Claude model, collector, outbox, sender, and runner modules; it does not generalize or change the Codex pipeline. Claude and Codex live hooks remain unaffected.
```

- [x] **Step 3: Create the Claude replay ADR**

Create `docs/adr/0003-claude-session-outbox-replay.md`:

```markdown
---
status: accepted
---

# Import Claude sessions through an isolated temporary outbox

Claude session history import is implemented independently from Codex replay. It discovers transcript JSONL beneath `CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`, filters sessions by the first usable absolute cwd in the root stream, and groups the root plus linked sidechain streams with one transcript `sessionId` into one NAMS conversation per import run.

Each transcript file is a stream, not a conversation. The root stream is identified by `isSidechain:false`; a sidechain stream uses `agent:<agentId>`. Adjacent subagent metadata relates `toolUseId` to the parent `Agent` call. The importer retains the parent delegation call and the child stream's internal tools but does not flatten child prompts or assistant responses into the root message stream.

Claude transcript files are append-only graphs. For each stream, the importer starts at the final UUID-bearing record and follows `parentUuid` to select the active spine. Authored messages and assistant response groups come from that spine. Direct tool results still pair by explicit call ID even when parallel results appear as sibling graph branches.

Only active root user records with `origin.kind:"human"` become user messages. Human slash-command wrappers are normalized from `command-name` and `command-args`; command expansions, local controls, interruption notices, tool results, and task notifications are excluded. Active root assistant `text` blocks grouped by `message.id` become assistant messages. Sidechain messages never enter the canonical conversation stream.

An assistant `message.id`, scoped by source session and stream, is the Agent Step boundary. A grouped response creates a step only when it contains one or more `tool_use` blocks. Visible text in the same response is a safe operational summary. Empty thinking, redacted thinking, signatures, and inferred chain-of-thought are never stored.

Every `tool_use` is attached to its response step. Direct output pairs through `tool_result.tool_use_id` and appends every visible content item in source order. Root task notifications pair through their embedded `tool-use-id` and add late asynchronous completion output and status. The importer does not duplicate top-level `toolUseResult`; it uses that representation only for async state and persisted-output metadata.

When Claude externalizes a large result, the importer resolves only the recorded basename inside the selected session's local `tool-results` directory, rejects symlinks and size mismatches, and replaces the preview with the complete companion content. It never follows the original machine's arbitrary absolute path. Missing or invalid companions fall back to model-visible output and count as unsupported.

Claude collection happens completely in memory before delivery. The importer writes logical operations to a private `outbox.jsonl` in a unique `nams-hooks-claude-replay-*` OS temporary directory, with directory mode `0700` and file mode `0600`. It never reads or updates live hook state and persists no checkpoint, cursor, deduplication key, sent marker, remote conversation ID, or remote Agent Step ID.

The sender validates the entire outbox and its local references before configuration or network access, resolves one NAMS destination, sends sequentially, performs no retry, and stops at the first error. Remote IDs exist only in memory. Handled success or failure removes the temporary directory; an abrupt termination may leave it for OS cleanup. Restarting rebuilds and resends the complete outbox, so duplicate and partial remote data are acceptable under best-effort at-least-once delivery.

Claude replay progress writes full imported/skipped transcript paths and the temporary outbox path to stderr. The aggregate summary is written to stdout. Progress never contains transcript content, outbox content, tool input/output, or credentials.

No replay abstraction is shared with Codex. Claude owns separate model, collector, outbox, sender, runner, fixture, environment, and test modules. Existing platform-neutral runtime services remain reusable, and live Claude/Codex hook behavior is unchanged.
```

- [x] **Step 4: Add Claude-specific domain language**

Append this complete section after the existing `### Codex Session History Import` section in `CONTEXT.md`:

```markdown

### Claude Session History Import

**Claude Session History Import**:
A one-off, offline ingestion of matching Claude transcript files into NAMS through the Claude-specific collector and temporary outbox.
_Avoid_: Codex replay adapter, shared replay pipeline

**Imported Claude Conversation**:
One NAMS conversation representing an active Claude root transcript and its linked sidechain streams with the same `sessionId` during one import run.
_Avoid_: Per-file conversation, flattened subagent dialogue

**Claude Transcript Stream**:
One root or `agent:<agentId>` JSONL stream. It contributes active assistant response groups and tools but only the root contributes canonical user/assistant messages.
_Avoid_: Independent conversation, source turn

**Active Claude Spine**:
The UUID ancestry obtained by starting at a stream's last UUID-bearing record and following `parentUuid`. It selects the retained conversation branch without discarding explicitly paired parallel tool results.
_Avoid_: Every append-only row, output adjacency

**Claude Authored Message**:
An active root user record with `origin.kind:"human"`, or active root assistant text grouped by `message.id`. Slash-command input is normalized from its command name and arguments.
_Avoid_: Every `type:"user"` record, sidechain message

**Claude Source Agent Step**:
One active assistant `message.id`, scoped by source session and stream, that contains at least one `tool_use`. Visible text may summarize it; thinking and signatures are never memory.
_Avoid_: Thinking block, one-call step

**Claude Direct Tool Output**:
Every visible item from `tool_result.content`, paired to `tool_use.id` by `tool_use_id` within one stream and concatenated in source order.
_Avoid_: Adjacent user message, first output item only

**Claude Asynchronous Tool Output**:
The later task-notification result and final status associated with an `Agent` or `SendMessage` call through embedded `tool-use-id`.
_Avoid_: Human message, duplicated subagent final response

**Claude Persisted Tool Output**:
A complete large-output companion validated beneath the selected session's `tool-results/` directory and used instead of the transcript preview.
_Avoid_: Logged absolute path, preview plus full-output duplication

**Claude Temporary Replay Outbox**:
A complete private Claude JSONL operation projection in a unique OS temporary directory, separate from the Codex outbox and removed after handled completion.
_Avoid_: Shared replay queue, live session state

**Claude Best-Effort Replay Delivery**:
Sequential fail-fast Claude delivery with no retry, checkpoint, persistent mapping, or deduplication. Restarting rebuilds and resends the whole Claude outbox.
_Avoid_: Exactly-once delivery, resumable import
```

- [x] **Step 5: Add the independent Claude import contract to the main design**

Replace the first paragraph under `### Codex Session History Import` in `docs/superpowers/specs/2026-05-10-nams-hooks-design.md` with:

```markdown
`nams-hooks replay codex [--working-dir PATH]` performs one offline best-effort Codex import. This subsection and its implementation are Codex-specific. Claude replay is defined separately below and does not change or generalize the Codex collector, outbox, sender, or runner. Live hooks and distribution for both harnesses remain unchanged.
```

Insert this subsection after the complete Codex history-import subsection and before `## Duplicate Suppression`:

```markdown
### Claude Session History Import

`nams-hooks replay claude [--working-dir PATH]` performs one offline best-effort Claude import through platform-local modules under `src/platforms/claude/`. It does not use or generalize the Codex replay model, collector, outbox, sender, runner, fixtures, or test environment. The CLI dispatches directly to the concrete Claude runner.

The importer discovers regular transcript JSONL beneath `CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`. It excludes subagent metadata, tool-result companions, and memory files from transcript discovery. It reads the selected corpus into memory, groups files by transcript `sessionId`, identifies the root and `agent:<agentId>` streams, and uses adjacent subagent metadata `toolUseId` only to link a sidechain to its parent `Agent` call. A session is eligible when the root stream's first usable absolute cwd equals the import root or is below it; later cwd values may move into descendants and need not equal the root cwd.

For each stream, the importer follows `parentUuid` from the final UUID-bearing record to select the active spine. Only active root `user` records with `origin.kind:"human"` become user messages. Authored slash commands are normalized from their command name and arguments. Command expansion, local controls, task notifications, tool results, interruption notices, and sidechain prompts are excluded. Active root assistant text grouped by assistant `message.id` becomes the assistant message stream; sidechain assistant text is not flattened.

An active assistant `message.id`, scoped by source session and stream, creates one Agent Step when the grouped response contains at least one `tool_use`. All calls in the response attach to that step. Visible text from the same response is the safe step summary; otherwise the importer uses a fixed operational fallback. Thinking, redacted thinking, signatures, and inferred chain-of-thought are never stored.

Calls and direct results pair by `tool_use.id` and `tool_result.tool_use_id` within a session and stream, regardless of adjacency or graph branching. Every output record and every visible content item is appended in source order, including stable serialization of non-text items. Root task notifications attach their result and final status to the uniquely matching call through embedded `tool-use-id`; they never become user messages. Parent delegation calls and child-internal calls are both retained, while sidechain final responses are not duplicated as conversation or tool output.

For a result with `toolUseResult.persistedOutputPath`, the importer resolves only its basename inside the selected session's local `tool-results/` directory, requires a non-symlink regular file and matching persisted size, and uses its complete contents instead of the preview. It never follows the original absolute path outside the selected corpus. Missing or invalid companions fall back to exposed result content and increment the unsupported count.

Before the first NAMS request, Claude replay writes all logical operations to `outbox.jsonl` inside a unique `nams-hooks-claude-replay-*` directory under the OS temporary directory. The directory uses mode `0700` and the file uses `0600`. Claude replay never reads or writes live `SessionState`, `.nams/state/`, or `.nams/logs/`, and it persists no checkpoint, cursor, sent marker, deduplication key, conversation mapping, or Agent Step mapping.

The Claude sender validates the entire outbox and all local references before configuration or network access, loads normal configuration plus Claude plugin configuration discovery, resolves one workspace, sends records sequentially, performs no retry, and stops on the first failure. Remote conversation and Agent Step IDs remain in process memory. A `finally` cleanup removes the temporary outbox after handled success or failure; abrupt termination may leave it for OS cleanup.

Restarting rediscovers the Claude corpus, recreates the outbox, creates new NAMS conversations, and starts from the beginning. Duplicate writes and partial prior conversations are acceptable. Delivery is best-effort with at-least-once behavior when the operator restarts after failure.

Claude progress on stderr emits `Claude replay file imported: <absolute path>`, `Claude replay file skipped: <absolute path>`, and `Claude replay outbox: <absolute path>`. The success summary remains on stdout. No transcript contents, outbox contents, tool inputs/outputs, or credentials are printed.
```

Do not merge the Claude and Codex design subsections, and do not change the live-hook lifecycle or generated distribution model.

- [x] **Step 6: Run focused and full verification**

Run:

```bash
npm run build
node --import=tsx --test \
  test/replay-files.test.ts \
  test/provenance.test.ts \
  test/claude/claude-replay-collector.test.ts \
  test/claude/claude-replay-outbox.test.ts \
  test/claude/claude-replay-sender.test.ts \
  test/claude/claude-replay-runner.test.ts \
  test/cli-claude-replay.test.ts \
  test/codex/codex-replay-collector.test.ts \
  test/codex/codex-replay-outbox.test.ts \
  test/codex/codex-replay-sender.test.ts \
  test/codex/codex-replay-runner.test.ts \
  test/cli-replay.test.ts \
  test/architecture.test.ts
npm run check
```

Expected: all focused tests pass, the existing Codex replay suite remains green, and `npm run check` completes successfully.

- [x] **Step 7: Inspect isolation, scope, and generated-artifact boundaries**

Run:

```bash
git diff --check
git status --short
git diff --stat
rg -n "CodexReplay|platforms/codex|codex/replay" src/platforms/claude test/claude test/support/claude-*
rg -n "ClaudeReplay|platforms/claude|claude/replay" src/platforms/codex test/codex test/support/codex-*
rg -n --glob '!test/architecture.test.ts' "ReplayPlatform|ReplayPlatformAdapter|replayAdapters|getReplayPlatformAdapter" src test
git status --short -- dist dist-marketplace dist-local
```

Expected: whitespace output is empty; changes are limited to the planned Claude replay, explicit CLI/provenance routing, tests, and architecture documents plus unrelated pre-existing user files; all three forbidden-symbol searches print no matches; generated distribution directories show no source changes.

- [x] **Step 8: Commit the architecture record**

```bash
git add \
  docs/adr/0001-project-replay-from-source-turns-and-semantic-operations.md \
  docs/adr/0002-codex-session-outbox-replay.md \
  docs/adr/0003-claude-session-outbox-replay.md \
  CONTEXT.md \
  docs/superpowers/specs/2026-05-10-nams-hooks-design.md \
  docs/plans/0007-claude-session-outbox-replay.md
git commit -m "docs: define isolated Claude outbox replay"
```

---

## Self-Review Results

- Spec coverage: Task 1 covers complete-corpus grouping, root/sidechain identity, cwd filtering, active branches, authored/root messages, assistant response steps, direct and asynchronous outputs, subagent linkage, externalized output, statuses, durations, and progress classification. Task 2 covers a private Claude-only outbox and complete local-reference validation. Task 3 covers Claude configuration/provenance, sanitization, sequential fail-fast sending, workspace resolution, and no live state. Task 4 covers lifecycle cleanup, restart semantics, direct CLI dispatch, Codex regression coverage, and static isolation. Task 5 records the separate architecture and verifies the repository.
- Isolation: no Codex replay source or test helper is modified or imported by Claude. Shared changes are limited to an additional separately named provenance function, two explicit CLI imports/branches, architecture assertions, and documentation. No replay registry, common model, generic sender, generic outbox, or parameterized harness implementation is introduced.
- Placeholder scan: no deferred implementation marker, generic error-handling instruction, comment-only test, undefined neighboring interface, or cross-task shorthand remains. Every code-changing step provides exact source, test, diff, documentation, or command content.
- Type consistency: `collectClaudeReplaySessions()` returns `ClaudeReplaySession[]`; `createClaudeReplayOutbox()` consumes those sessions and writes `ClaudeReplayOutboxRecord`; `sendClaudeReplayOutbox()` validates and consumes that outbox; `runClaudeReplay()` combines collection and delivery counts into `ClaudeReplayRunSummary`; the CLI imports only the concrete Claude runner and formatter from the Claude platform entrypoint.
- Privacy: human messages require `origin.kind:"human"`; sidechain messages and task notifications do not enter the conversation stream; thinking/signatures are ignored; logged absolute paths never include contents; persisted output paths cannot escape the selected session directory; tool values pass through the existing sanitizers before NAMS delivery.
- Delivery semantics: the complete outbox exists before the first request; all references validate before configuration/network access; no retry, checkpoint, persistent mapping, deduplication, or live-state access exists; restart deliberately recreates and resends the complete Claude outbox.
