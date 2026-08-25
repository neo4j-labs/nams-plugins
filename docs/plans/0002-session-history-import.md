# Session History Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `nams-hooks replay <claude|codex> [--working-dir PATH]` to import every matching persisted transcript into NAMS as one conversation per JSONL file.

**Architecture:** Keep `src/cli.ts` as a command gateway and add replay-specific platform adapters through the existing static registry. Claude and Codex readers discover and normalize their own persisted JSONL formats; a new replay runtime resolves one NAMS destination, filters by the first transcript cwd, and writes the normalized timeline sequentially with the generated NAMS client. Reuse generated request types and the existing tool sanitizers at the NAMS boundary; do not add replay wrappers to the live memory service or change configuration loading. Live hook adapters, live transcript readers, session state, hook logging, and recall behavior remain unchanged.

**Tech Stack:** TypeScript 5.9, Node.js 20+ ESM and built-ins, generated NAMS REST client, Node `node:test`, `tsx`, and `fetch-mock` as existing dev-only test tooling.

## Global Constraints

- The public command is exactly `nams-hooks replay <claude|codex> [--working-dir PATH]`; it does not read stdin.
- Replay is offline history ingestion: never resume an agent, invoke a model or tool, recall memory, or simulate hook events.
- Resolve NAMS configuration and the destination workspace exactly once from the absolute import root, defaulting to `process.cwd()`.
- Resolve that destination before corpus discovery; once configuration succeeds, missing or empty transcript roots return a successful zero-import summary.
- Use the existing configuration precedence, Claude config discovery, generated request types/client, message/tool sanitization, and static adapter boundaries.
- Discover only Claude's `CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`, and Codex's `CODEX_HOME/{sessions,archived_sessions}` or `~/.codex/{sessions,archived_sessions}`.
- Import every regular persisted Claude/Codex JSONL session whose first recognized cwd is the import root or a descendant, including subagent, sidechain, forked, active, and archived sessions.
- Allow a configured corpus root itself to be a symlink, but never follow nested symlink entries or import non-regular/non-JSONL files.
- Never infer ownership from storage paths, Git, later cwd values, or raw string-prefix matching; an absent, relative, or otherwise unusable first cwd skips the transcript.
- Create one NAMS conversation per matching transcript only when it contains at least one eligible normalized record.
- Import visible user/assistant text and explicit tool activity only; exclude hidden or summarized reasoning, system/developer instructions, compaction, and ambiguous records.
- Preserve source order, use `addMessagesBulk` for contiguous message batches of at most 100, and write operational reasoning plus tool calls through the generated client's existing endpoints.
- Sort transcript paths lexically and complete one transcript read/import before starting the next; read active files once without locking, stabilization, or a second pass.
- Pair tool results only by explicit call id, keep unmatched invocations without output, and ignore orphan outputs without adjacency guesses.
- Skip malformed lines and count malformed/unsupported records; an unreadable or failed transcript does not prevent later transcripts from running.
- Retry recoverable NAMS requests up to twice, waiting 500 ms before each retry: one initial attempt plus at most two retries, for at most three total attempts. Recoverable failures are transport failures, HTTP 408, HTTP 429, and HTTP 5xx; do not retry other 4xx failures.
- A failed session retains successful partial writes, creates no rollback work, and makes the final exit status nonzero while replay continues with later sessions.
- Do not deduplicate, checkpoint, roll back partial writes, write replay state/log files, set conversation titles, prompt for confirmation, or add a dry-run mode.
- Conversation metadata is limited to existing `harness` and `projectDirectory`, required `sourceSessionId` and `importSource: "nams-hooks-replay"`, and optional explicit `sourceStartedAt`; use the first embedded session id or the `.jsonl` basename fallback, and never prefix content with source timestamps.
- Send replay progress to stderr and one human aggregate summary to stdout. The startup line includes only `configSources` labels. Eligible sessions emit `processing...` followed by one indented HTTP method/route-template line for every generated-client request attempt. Failed NAMS writes include the HTTP operation, method, route template, request body, attempt statuses, and final response body; scrub configured API-key values, Bearer values, and credential-bearing fields. Successful and skipped progress remains free of transcript paths and message/tool bodies.
- Runtime code and generated artifacts use Node built-ins only; add no runtime dependency and do not hand-edit `dist/`.
- Tests use temporary directories, make no external network calls, leave no `.nams/` artifacts in the repository, and do not assert documentation content.
- Preserve unrelated worktree changes and do not broaden Gemini, OpenCode, installers, release packaging, or live-hook behavior.
- Final verification is the feature-focused test set followed by `npm run check`; package/distribution hardening is outside this plan.

---

## File Map

- `src/interfaces.ts`: the minimal shared replay platform, generated-type-derived record, transcript, adapter, and summary contracts.
- `src/runtime/replay-files.ts`: regular-JSONL recursive traversal, absolute-path normalization, and directory-aware cwd containment.
- `src/platforms/claude/replay.ts`: Claude transcript-root discovery and replay-only normalization.
- `src/platforms/codex/replay.ts`: Codex active/archive discovery and replay-only normalization.
- `src/platforms/claude/index.ts`, `src/platforms/codex/index.ts`: expose replay adapters through the established platform entrypoints.
- `src/platforms/index.ts`: static Claude/Codex replay registry.
- `src/runtime/provenance.ts`: non-secret replay command provenance headers.
- `src/runtime/replay.ts`: direct generated-client writes, one-time config/workspace resolution, retry policy, sequential import, progress, and summary.
- `src/cli.ts`: replay argument parsing, dispatch, output streams, and usage.
- `test/replay-files.test.ts`, `test/claude/claude-replay.test.ts`, `test/codex/codex-replay.test.ts`, `test/provenance.test.ts`, `test/replay-runtime.test.ts`, `test/cli-replay.test.ts`: feature coverage.
- `test/architecture.test.ts`, `test/support/nams-fetch-mock.ts`: registry and replay HTTP coverage.
- `CONTEXT.md`: update the domain language so every matching persisted transcript, including a subagent transcript, is an imported conversation.

### Task 1: Shared Replay Contracts And Safe Transcript Discovery

**Files:**
- Modify: `src/interfaces.ts`
- Create: `src/runtime/replay-files.ts`
- Create: `test/replay-files.test.ts`

**Interfaces:**
- Consumes: the existing `Platform` declarations, generated `AddMessageRequest`, `RecordStepRequest`, and `RecordToolCallRequest`, the existing `NamsConfigDiscovery` callback type, and Node path/filesystem built-ins.
- Produces: `ReplayPlatform`, `ReplayRecord`, `ReplayToolRecord`, `ReplayTranscript`, `ReplayPlatformAdapter`, `ReplaySummary`, `discoverRegularJsonlFiles(roots)`, `normalizeAbsolutePath(value)`, and `isDirectoryWithinImportRoot(importRoot, candidate)`.

- [x] **Step 1: Write failing filesystem and containment tests**

Create `test/replay-files.test.ts` with temporary roots that prove the root itself may resolve through a symlink, nested symlink entries are ignored, only regular `.jsonl` files are returned, missing roots are empty, results are lexically sorted, descendants match, and prefix siblings do not:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  discoverRegularJsonlFiles,
  isDirectoryWithinImportRoot,
  normalizeAbsolutePath,
} from "../src/runtime/replay-files.js";

test("discovers sorted regular JSONL files without following nested symlinks", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-replay-files-"));
  try {
    const corpus = path.join(fixture, "corpus");
    const linkedRoot = path.join(fixture, "linked-root");
    const outside = path.join(fixture, "outside");
    await mkdir(path.join(corpus, "nested"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(corpus, "z.jsonl"), "{}\n", "utf8");
    await writeFile(path.join(corpus, "nested", "a.jsonl"), "{}\n", "utf8");
    await writeFile(path.join(corpus, "ignore.txt"), "{}\n", "utf8");
    await writeFile(path.join(outside, "linked-file.jsonl"), "{}\n", "utf8");
    await symlink(corpus, linkedRoot, "dir");
    await symlink(path.join(outside, "linked-file.jsonl"), path.join(corpus, "linked.jsonl"), "file");
    await symlink(outside, path.join(corpus, "linked-dir"), "dir");

    assert.deepEqual(await discoverRegularJsonlFiles([linkedRoot]), [
      path.join(linkedRoot, "nested", "a.jsonl"),
      path.join(linkedRoot, "z.jsonl"),
    ]);
    assert.deepEqual(await discoverRegularJsonlFiles([path.join(fixture, "missing")]), []);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("matches the import root and descendants but not string-prefix siblings", () => {
  const root = path.resolve("/workspaces/nams-hooks");
  assert.equal(isDirectoryWithinImportRoot(root, root), true);
  assert.equal(isDirectoryWithinImportRoot(root, path.join(root, "worktrees", "feature")), true);
  assert.equal(isDirectoryWithinImportRoot(root, `${root}-old`), false);
  assert.equal(isDirectoryWithinImportRoot(root, "relative/project"), false);
});

test("normalizes only usable absolute paths", () => {
  assert.equal(normalizeAbsolutePath(" /workspaces/nams-hooks/../nams-hooks "), path.normalize("/workspaces/nams-hooks"));
  assert.equal(normalizeAbsolutePath("relative/project"), undefined);
  assert.equal(normalizeAbsolutePath(""), undefined);
  assert.equal(normalizeAbsolutePath(42), undefined);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --import=tsx --test test/replay-files.test.ts`

Expected: FAIL because `src/runtime/replay-files.ts` and the replay contracts do not exist.

- [x] **Step 3: Add the shared replay contracts**

Add type-only imports at the top of `src/interfaces.ts`, then append these contracts. Keep `ReplayPlatform` separate from the broader live-hook `Platform` union. The normalized boundary deliberately reuses generated NAMS request fields: a message is an `AddMessageRequest` with a narrowed role, and the reasoning step is a `RecordStepRequest` without the conversation id that replay supplies later. The only replay-specific record interface is the tool record because transcript input/output are still raw values awaiting the existing sanitizer:

```ts
import type {
  AddMessageRequest,
  RecordStepRequest,
  RecordToolCallRequest,
} from "./generated/nams-client.js";
import type { NamsConfigDiscovery } from "./runtime/config.js";

export const replayPlatforms = ["claude", "codex"] as const;
export type ReplayPlatform = (typeof replayPlatforms)[number];

export interface ReplayToolRecord
  extends Omit<RecordToolCallRequest, "input" | "output" | "stepId"> {
  kind: "tool";
  input: unknown;
  output?: unknown;
  reasoningStep: Omit<RecordStepRequest, "conversationId">;
}

export type ReplayRecord =
  | (AddMessageRequest & {
      kind: "message";
      role: "user" | "assistant";
    })
  | ReplayToolRecord;

export interface ReplayTranscript {
  sourceSessionId: string;
  projectDirectory?: string;
  sourceStartedAt?: string;
  records: ReplayRecord[];
  malformedLineCount: number;
  unsupportedRecordCount: number;
}

export interface ReplayPlatformAdapter {
  platform: ReplayPlatform;
  discoverConfig?: NamsConfigDiscovery;
  discoverTranscripts(): Promise<string[]>;
  readTranscript(transcriptPath: string): Promise<ReplayTranscript>;
}

export interface ReplaySummary {
  discovered: number;
  matched: number;
  imported: number;
  skipped: number;
  failed: number;
  messages: number;
  toolCalls: number;
  malformedLines: number;
  unsupportedRecords: number;
}
```

Do not add `ReplayMessageRecord`, `ReplayOperationalTrace`, or `ReplayRunResult`. A parser-local source call id is pairing state, not part of the normalized replay record. `runReplay()` will return `ReplaySummary` directly and the CLI will derive its exit code from `summary.failed`.

- [x] **Step 4: Implement regular-file discovery and cwd containment**

Create `src/runtime/replay-files.ts`:

```ts
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export async function discoverRegularJsonlFiles(roots: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    if (!(await isExistingDirectory(root))) continue;
    await walk(root, files);
  }
  return files.sort();
}

export function normalizeAbsolutePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "" || !path.isAbsolute(value.trim())) {
    return undefined;
  }
  return path.normalize(value.trim());
}

export function isDirectoryWithinImportRoot(importRoot: string, candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const relative = path.relative(path.resolve(importRoot), path.normalize(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function isExistingDirectory(root: string): Promise<boolean> {
  try {
    return (await stat(root)).isDirectory();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function walk(directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(entryPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
```

- [x] **Step 5: Run the focused test**

Run: `node --import=tsx --test test/replay-files.test.ts`

Expected: PASS with 3 tests.

- [x] **Step 6: Commit the shared contracts and filesystem seam**

```bash
git add src/interfaces.ts src/runtime/replay-files.ts test/replay-files.test.ts
git commit -m "feat: add replay transcript contracts"
```

### Task 2: Claude Corpus Discovery And Transcript Normalization

**Files:**
- Create: `src/platforms/claude/replay.ts`
- Create: `test/claude/claude-replay.test.ts`

**Interfaces:**
- Consumes: `ReplayPlatformAdapter`, `ReplayToolRecord`, and `discoverRegularJsonlFiles()` from Task 1; `homeDirectory()` from `src/runtime/paths.ts`.
- Consumes: existing `discoverClaudeNamsConfig`, `firstString()`, and `isPlainObject()` rather than adding equivalent helpers.
- Produces: `claudeReplayAdapter`, `discoverClaudeReplayTranscripts(env)`, and `readClaudeReplayTranscript(transcriptPath)`.

- [x] **Step 1: Write failing Claude discovery and normalization tests**

Create `test/claude/claude-replay.test.ts`. Use `CLAUDE_CONFIG_DIR` in a passed environment object, not the process environment. The main fixture must include an initial cwd, user text, assistant text, thinking, a `tool_use`, a matching `tool_result`, a malformed line, an orphan result, and a later cwd:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  claudeReplayAdapter,
  discoverClaudeReplayTranscripts,
  readClaudeReplayTranscript,
} from "../../src/platforms/claude/replay.js";

test("discovers Claude project and subagent JSONL files from CLAUDE_CONFIG_DIR", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-replay-"));
  try {
    const project = path.join(fixture, "projects", "encoded-project");
    const defaultTranscript = path.join(fixture, "home", ".claude", "projects", "default", "session-default.jsonl");
    await mkdir(path.join(project, "session-1", "subagents"), { recursive: true });
    await mkdir(path.dirname(defaultTranscript), { recursive: true });
    await writeFile(path.join(project, "session-1.jsonl"), "{}\n", "utf8");
    await writeFile(path.join(project, "session-1", "subagents", "agent-a.jsonl"), "{}\n", "utf8");
    await writeFile(defaultTranscript, "{}\n", "utf8");
    assert.deepEqual(await discoverClaudeReplayTranscripts({ CLAUDE_CONFIG_DIR: fixture }), [
      path.join(project, "session-1.jsonl"),
      path.join(project, "session-1", "subagents", "agent-a.jsonl"),
    ]);
    assert.deepEqual(await discoverClaudeReplayTranscripts({ HOME: path.join(fixture, "home") }), [defaultTranscript]);
    assert.equal(claudeReplayAdapter.platform, "claude");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("normalizes Claude visible messages and explicitly paired tool activity", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-replay-"));
  try {
    const transcriptPath = path.join(fixture, "fallback-session.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({
        type: "user",
        sessionId: "claude-session-1",
        cwd: "/workspaces/nams-hooks",
        isSidechain: true,
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { role: "user", content: [
          { type: "text", text: "Build replay." },
          { type: "image", text: "do not import", source: { type: "base64", data: "skip" } },
        ] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "I will inspect it." },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/cli.ts", result: "strip" } },
          { type: "text", text: "Inspection queued." },
        ] },
      }),
      "{malformed",
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "file contents", is_error: false },
          { type: "tool_result", tool_use_id: "orphan", content: "ignore me", is_error: true },
          { type: "text", text: "Continue." },
        ] },
      }),
      JSON.stringify({ type: "system", cwd: "/different/project", message: { role: "system", content: "ignore" } }),
    ].join("\n"), "utf8");

    assert.deepEqual(await readClaudeReplayTranscript(transcriptPath), {
      sourceSessionId: "claude-session-1",
      projectDirectory: path.normalize("/workspaces/nams-hooks"),
      sourceStartedAt: "2026-08-01T10:00:00.000Z",
      malformedLineCount: 1,
      unsupportedRecordCount: 2,
      records: [
        { kind: "message", role: "user", content: "Build replay." },
        { kind: "message", role: "assistant", content: "I will inspect it." },
        {
          kind: "tool",
          toolName: "Read",
          input: { file_path: "src/cli.ts", result: "strip" },
          output: "file contents",
          status: "success",
          reasoningStep: {
            reasoning: "Claude Code ran Read with the provided tool input.",
            actionTaken: "Ran Read",
          },
        },
        { kind: "message", role: "assistant", content: "Inspection queued." },
        { kind: "message", role: "user", content: "Continue." },
      ],
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("the first Claude cwd occurrence is authoritative even when unusable", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-replay-"));
  try {
    const transcriptPath = path.join(fixture, "session.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({ type: "user", cwd: "relative/path", message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "assistant", cwd: "/later/absolute", message: { role: "assistant", content: "second" } }),
    ].join("\n"), "utf8");
    const transcript = await readClaudeReplayTranscript(transcriptPath);
    assert.equal(transcript.projectDirectory, undefined);
    assert.equal(transcript.sourceSessionId, "session");
    assert.equal(transcript.records.length, 2);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run the Claude tests to verify they fail**

Run: `node --import=tsx --test test/claude/claude-replay.test.ts`

Expected: FAIL because `src/platforms/claude/replay.ts` does not exist.

- [x] **Step 3: Implement Claude replay discovery and normalization**

Create `src/platforms/claude/replay.ts` with these exact rules:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ReplayPlatformAdapter,
  ReplayRecord,
  ReplayToolRecord,
  ReplayTranscript,
} from "../../interfaces.js";
import { discoverClaudeNamsConfig } from "./config.js";
import {
  discoverRegularJsonlFiles,
  normalizeAbsolutePath,
} from "../../runtime/replay-files.js";
import { homeDirectory } from "../../runtime/paths.js";
import { firstString, isPlainObject } from "../../runtime/util.js";

export const claudeReplayAdapter: ReplayPlatformAdapter = {
  platform: "claude",
  discoverConfig: discoverClaudeNamsConfig,
  discoverTranscripts: () => discoverClaudeReplayTranscripts(),
  readTranscript: readClaudeReplayTranscript,
};

export async function readClaudeReplayTranscript(transcriptPath: string): Promise<ReplayTranscript> {
  const lines = (await readFile(transcriptPath, "utf8")).split(/\r?\n/);
  const records: ReplayRecord[] = [];
  const calls = new Map<string, ReplayToolRecord>();
  let sourceSessionId: string | undefined;
  let sourceStartedAt: string | undefined;
  let projectDirectory: string | undefined;
  let sawCwd = false;
  let malformedLineCount = 0;
  let unsupportedRecordCount = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      malformedLineCount += 1;
      continue;
    }
    if (!isPlainObject(raw)) {
      unsupportedRecordCount += 1;
      continue;
    }

    if (!sawCwd && Object.hasOwn(raw, "cwd")) {
      sawCwd = true;
      projectDirectory = normalizeAbsolutePath(raw.cwd);
      sourceStartedAt = firstString(raw.timestamp, raw.createdAt);
    }
    sourceSessionId ??= firstString(raw.sessionId, raw.session_id);

    const message = isPlainObject(raw.message) ? raw.message : undefined;
    const blocks = contentBlocks(message?.content);
    let handled = false;
    if ((raw.type === "user" || raw.type === "assistant") && message?.role === raw.type) {
      let pendingText: string[] = [];
      const flushText = (): void => {
        const content = pendingText.join("\n").trim();
        pendingText = [];
        if (content === "") return;
        records.push({ kind: "message", role: raw.type as "user" | "assistant", content });
        handled = true;
      };

      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          pendingText.push(block.text);
          continue;
        }
        flushText();

        if (raw.type === "assistant" && block.type === "tool_use") {
          const toolName = firstString(block.name);
          if (toolName === undefined) continue;
          const sourceCallId = firstString(block.id);
          const tool: ReplayToolRecord = {
            kind: "tool",
            toolName,
            input: block.input ?? {},
            reasoningStep: {
              reasoning: `Claude Code ran ${toolName} with the provided tool input.`,
              actionTaken: `Ran ${toolName}`,
            },
          };
          records.push(tool);
          if (sourceCallId !== undefined) calls.set(sourceCallId, tool);
          handled = true;
          continue;
        }

        if (raw.type === "user" && block.type === "tool_result") {
          const call = calls.get(firstString(block.tool_use_id) ?? "");
          if (call === undefined) {
            unsupportedRecordCount += 1;
            handled = true;
            continue;
          }
          if (Object.hasOwn(block, "content")) call.output = block.content;
          if (typeof block.is_error === "boolean") call.status = block.is_error ? "error" : "success";
          const durationMs = finiteNumber(block.duration_ms, block.durationMs);
          if (durationMs !== undefined) call.durationMs = durationMs;
          handled = true;
        }
      }
      flushText();
    }
    if (!handled) unsupportedRecordCount += 1;
  }

  return {
    sourceSessionId: sourceSessionId ?? path.basename(transcriptPath, ".jsonl"),
    ...(projectDirectory !== undefined ? { projectDirectory } : {}),
    ...(sourceStartedAt !== undefined ? { sourceStartedAt } : {}),
    records,
    malformedLineCount,
    unsupportedRecordCount,
  };
}

export async function discoverClaudeReplayTranscripts(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const configured = firstString(env.CLAUDE_CONFIG_DIR);
  const home = homeDirectory(env);
  if (configured === undefined && home === undefined) return [];
  const claudeRoot = path.resolve(configured ?? path.join(home as string, ".claude"));
  return discoverRegularJsonlFiles([path.join(claudeRoot, "projects")]);
}

function contentBlocks(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function finiteNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

```

While implementing, keep top-level `toolUseResult` and all thinking/system/summary shapes out of normalization; only canonical `message.content` blocks participate. An unmatched invocation remains in `records` without output, while an orphan result is counted and ignored.

- [x] **Step 4: Run the Claude tests**

Run: `node --import=tsx --test test/claude/claude-replay.test.ts`

Expected: PASS with 3 tests.

- [x] **Step 5: Commit the Claude replay reader**

```bash
git add src/platforms/claude/replay.ts test/claude/claude-replay.test.ts
git commit -m "feat: normalize Claude session history"
```

### Task 3: Codex Active/Archive Discovery And Rollout Normalization

**Files:**
- Create: `src/platforms/codex/replay.ts`
- Create: `test/codex/codex-replay.test.ts`

**Interfaces:**
- Consumes: the Task 1 replay contracts and file discovery helper.
- Consumes: existing `firstString()` and `isPlainObject()` rather than adding parser-local equivalents.
- Produces: `codexReplayAdapter`, `discoverCodexReplayTranscripts(env)`, and `readCodexReplayTranscript(transcriptPath)` without changing `src/platforms/codex/transcript.ts` or its live behavior.

- [x] **Step 1: Write failing Codex discovery and normalization tests**

Create `test/codex/codex-replay.test.ts`. Cover `CODEX_HOME/sessions`, `CODEX_HOME/archived_sessions`, nested subagent rollouts, canonical response items, explicit call-id output pairing, hosted tool calls, mirror `event_msg` exclusion, reasoning/compaction exclusion, malformed lines, and a relative first cwd:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  codexReplayAdapter,
  discoverCodexReplayTranscripts,
  readCodexReplayTranscript,
} from "../../src/platforms/codex/replay.js";

test("discovers active archived and subagent Codex rollouts", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-replay-"));
  try {
    const active = path.join(fixture, "sessions", "2026", "08", "rollout-b.jsonl");
    const child = path.join(fixture, "sessions", "2026", "08", "subagents", "rollout-a.jsonl");
    const archived = path.join(fixture, "archived_sessions", "rollout-c.jsonl");
    const defaultTranscript = path.join(fixture, "home", ".codex", "sessions", "rollout-default.jsonl");
    await mkdir(path.dirname(active), { recursive: true });
    await mkdir(path.dirname(child), { recursive: true });
    await mkdir(path.dirname(archived), { recursive: true });
    await mkdir(path.dirname(defaultTranscript), { recursive: true });
    await Promise.all([active, child, archived, defaultTranscript].map((file) => writeFile(file, "{}\n", "utf8")));
    assert.deepEqual(await discoverCodexReplayTranscripts({ CODEX_HOME: fixture }), [archived, child, active].sort());
    assert.deepEqual(await discoverCodexReplayTranscripts({ HOME: path.join(fixture, "home") }), [defaultTranscript]);
    assert.equal(codexReplayAdapter.platform, "codex");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("normalizes Codex messages and canonical tool variants without reasoning", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-replay-"));
  try {
    const transcriptPath = path.join(fixture, "rollout-fallback.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: "2026-08-02T09:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-session-1", cwd: "/workspaces/nams-hooks/worktrees/replay", timestamp: "2026-08-02T09:00:00.000Z", source: { subagent: "review" } },
      }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Import this." }, { type: "input_image", text: "do not import", image_url: "data:image/png;base64,skip" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Running shell." }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "shell", arguments: "{\"command\":\"pwd\",\"output\":\"strip\"}" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "exec_command_end", call_id: "call-1", output: "mirror" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: { content: "/workspaces/nams-hooks", success: true } } }),
      JSON.stringify({ type: "response_item", payload: { type: "web_search_call", id: "web-1", status: "completed", action: { type: "search", query: "NAMS" } } }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ text: "private" }], encrypted_content: "ciphertext" } }),
      JSON.stringify({ type: "compacted", payload: { message: "private summary" } }),
      "{malformed",
    ].join("\n"), "utf8");

    const transcript = await readCodexReplayTranscript(transcriptPath);
    assert.equal(transcript.sourceSessionId, "codex-session-1");
    assert.equal(transcript.projectDirectory, path.normalize("/workspaces/nams-hooks/worktrees/replay"));
    assert.equal(transcript.sourceStartedAt, "2026-08-02T09:00:00.000Z");
    assert.equal(transcript.malformedLineCount, 1);
    assert.deepEqual(transcript.records, [
      { kind: "message", role: "user", content: "Import this." },
      { kind: "message", role: "assistant", content: "Running shell." },
      {
        kind: "tool",
        toolName: "shell",
        input: { command: "pwd", output: "strip" },
        output: { content: "/workspaces/nams-hooks", success: true },
        status: "success",
        reasoningStep: {
          reasoning: "Codex exposed shell from the session transcript.",
          actionTaken: "Ran shell",
          result: "Codex transcript recorded status: success.",
        },
      },
      {
        kind: "tool",
        toolName: "web_search",
        input: { type: "search", query: "NAMS" },
        status: "completed",
        reasoningStep: {
          reasoning: "Codex exposed web_search from the session transcript.",
          actionTaken: "Ran web_search",
          result: "Codex transcript recorded status: completed.",
        },
      },
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("does not replace an unusable first Codex cwd with a later cwd", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-replay-"));
  try {
    const transcriptPath = path.join(fixture, "rollout.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "relative", id: "session-1" } }),
      JSON.stringify({ type: "turn_context", payload: { cwd: "/later/absolute" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "keep parsed content" } }),
    ].join("\n"), "utf8");
    const transcript = await readCodexReplayTranscript(transcriptPath);
    assert.equal(transcript.projectDirectory, undefined);
    assert.equal(transcript.records.length, 1);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
```

Add this fourth test in the same file for the remaining canonical tool shapes:

| Input item | NAMS tool name | Input | Output/status |
|---|---|---|---|
| `custom_tool_call` + `custom_tool_call_output` | explicit `name` | raw `input` string, plus `namespace` when present | explicit output; explicit status or output `success` |
| `local_shell_call` | `local_shell` | explicit `action` | no inferred output; explicit status |
| `tool_search_call` + `tool_search_output` | `tool_search` | `{ execution, arguments }` | explicit `tools`; explicit status |
| `image_generation_call` | `image_generation` | `{ revisedPrompt }` when present | full explicit `result`; explicit status |

```ts
test("normalizes remaining canonical Codex tool shapes and ignores orphan outputs", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-replay-"));
  try {
    const transcriptPath = path.join(fixture, "rollout-tools.jsonl");
    const responseItem = (payload: Record<string, unknown>) => JSON.stringify({ type: "response_item", payload });
    await writeFile(transcriptPath, [
      JSON.stringify({ type: "session_meta", payload: { id: "tools", cwd: "/project" } }),
      responseItem({ type: "custom_tool_call", call_id: "custom-1", namespace: "apps", name: "render", input: "raw input", status: "in_progress" }),
      responseItem({ type: "custom_tool_call_output", call_id: "custom-1", output: { content: "done", success: false } }),
      responseItem({ type: "local_shell_call", call_id: "shell-1", status: "completed", action: { type: "exec", command: ["pwd"] }, duration_ms: 12 }),
      responseItem({ type: "tool_search_call", call_id: "search-1", status: "in_progress", execution: "client", arguments: { query: "diagram" } }),
      responseItem({ type: "tool_search_output", call_id: "search-1", status: "completed", execution: "client", tools: [{ name: "imagegen" }] }),
      responseItem({ type: "image_generation_call", id: "image-1", status: "completed", revised_prompt: "A graph", result: "base64-result" }),
      responseItem({ type: "function_call_output", call_id: "orphan", output: "ignore" }),
      responseItem({ type: "function_call", call_id: "unmatched", name: "shell", arguments: "{}" }),
    ].join("\n"), "utf8");

    const tools = (await readCodexReplayTranscript(transcriptPath)).records.filter((record) => record.kind === "tool");
    assert.equal(tools.length, 5);
    assert.deepEqual(tools.map(({ reasoningStep: _step, ...tool }) => tool), [
      { kind: "tool", toolName: "render", input: { namespace: "apps", input: "raw input" }, output: { content: "done", success: false }, status: "error" },
      { kind: "tool", toolName: "local_shell", input: { type: "exec", command: ["pwd"] }, status: "completed", durationMs: 12 },
      { kind: "tool", toolName: "tool_search", input: { execution: "client", arguments: { query: "diagram" } }, output: [{ name: "imagegen" }], status: "completed" },
      { kind: "tool", toolName: "image_generation", input: { revisedPrompt: "A graph" }, output: "base64-result", status: "completed" },
      { kind: "tool", toolName: "shell", input: {} },
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run the Codex tests to verify they fail**

Run: `node --import=tsx --test test/codex/codex-replay.test.ts`

Expected: FAIL because `src/platforms/codex/replay.ts` does not exist.

- [x] **Step 3: Implement Codex replay discovery and normalization**

Create `src/platforms/codex/replay.ts`. Use the replay-only parser below; do not modify or import the conservative live `readCodexTranscript()` implementation:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ReplayPlatformAdapter,
  ReplayRecord,
  ReplayToolRecord,
  ReplayTranscript,
} from "../../interfaces.js";
import {
  discoverRegularJsonlFiles,
  normalizeAbsolutePath,
} from "../../runtime/replay-files.js";
import { homeDirectory } from "../../runtime/paths.js";
import { firstString, isPlainObject } from "../../runtime/util.js";

export const codexReplayAdapter: ReplayPlatformAdapter = {
  platform: "codex",
  discoverTranscripts: () => discoverCodexReplayTranscripts(),
  readTranscript: readCodexReplayTranscript,
};

export async function readCodexReplayTranscript(transcriptPath: string): Promise<ReplayTranscript> {
  const records: ReplayRecord[] = [];
  const calls = new Map<string, ReplayToolRecord>();
  let sourceSessionId: string | undefined;
  let sourceStartedAt: string | undefined;
  let projectDirectory: string | undefined;
  let sawCwd = false;
  let sawSessionMeta = false;
  let malformedLineCount = 0;
  let unsupportedRecordCount = 0;

  for (const line of (await readFile(transcriptPath, "utf8")).split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      malformedLineCount += 1;
      continue;
    }
    if (!isPlainObject(raw)) {
      unsupportedRecordCount += 1;
      continue;
    }

    const payload = isPlainObject(raw.payload) ? raw.payload : undefined;
    if (!sawCwd && payload !== undefined && Object.hasOwn(payload, "cwd")) {
      sawCwd = true;
      projectDirectory = normalizeAbsolutePath(payload.cwd);
    }
    if (raw.type === "session_meta" && payload !== undefined) {
      sourceSessionId ??= firstString(payload.id, payload.session_id);
      if (!sawSessionMeta) {
        sawSessionMeta = true;
        sourceStartedAt = firstString(payload.timestamp, raw.timestamp);
      }
      continue;
    }

    const item = responseItem(raw);
    if (item === undefined || isCompaction(raw, item)) {
      unsupportedRecordCount += 1;
      continue;
    }
    if (item.type === "message") {
      const role = item.role;
      const content = role === "user" || role === "assistant" ? visibleText(item.content, role).trim() : "";
      if ((role === "user" || role === "assistant") && content !== "") {
        records.push({ kind: "message", role, content });
      } else {
        unsupportedRecordCount += 1;
      }
      continue;
    }
    if (item.type === "reasoning" || item.type === "agent_message") {
      unsupportedRecordCount += 1;
      continue;
    }

    const tool = toolFromItem(item);
    if (tool !== undefined) {
      records.push(tool);
      const sourceCallId = firstString(item.call_id, item.id);
      if (sourceCallId !== undefined && isPairableCall(item.type)) calls.set(sourceCallId, tool);
      continue;
    }
    if (isOutputItem(item.type)) {
      const call = calls.get(firstString(item.call_id) ?? "");
      if (call === undefined) {
        unsupportedRecordCount += 1;
        continue;
      }
      if (Object.hasOwn(item, "output")) call.output = item.output;
      if (item.type === "tool_search_output" && Object.hasOwn(item, "tools")) call.output = item.tools;
      const status = explicitStatus(item);
      if (status !== undefined) applyStatus(call, status);
      continue;
    }
    unsupportedRecordCount += 1;
  }

  return {
    sourceSessionId: sourceSessionId ?? path.basename(transcriptPath, ".jsonl"),
    ...(projectDirectory !== undefined ? { projectDirectory } : {}),
    ...(sourceStartedAt !== undefined ? { sourceStartedAt } : {}),
    records,
    malformedLineCount,
    unsupportedRecordCount,
  };
}

export async function discoverCodexReplayTranscripts(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const configured = firstString(env.CODEX_HOME);
  const home = homeDirectory(env);
  if (configured === undefined && home === undefined) return [];
  const codexRoot = path.resolve(configured ?? path.join(home as string, ".codex"));
  return discoverRegularJsonlFiles([
    path.join(codexRoot, "sessions"),
    path.join(codexRoot, "archived_sessions"),
  ]);
}

function toolFromItem(item: Record<string, unknown>): ReplayToolRecord | undefined {
  const durationMs = finiteNumber(item.duration_ms, item.durationMs);
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const toolName = firstString(item.name);
    if (toolName === undefined) return undefined;
    const rawInput = item.type === "function_call" ? decodeJson(item.arguments) : item.input;
    const namespace = firstString(item.namespace);
    const input = namespace === undefined ? (rawInput ?? {}) : { namespace, input: rawInput ?? {} };
    return makeTool(toolName, input, explicitStatus(item), durationMs);
  }
  if (item.type === "local_shell_call" && isPlainObject(item.action)) {
    return makeTool("local_shell", item.action, explicitStatus(item), durationMs);
  }
  if (item.type === "tool_search_call") {
    return makeTool("tool_search", { execution: item.execution, arguments: item.arguments }, explicitStatus(item), durationMs);
  }
  if (item.type === "web_search_call" && isPlainObject(item.action)) {
    return makeTool("web_search", item.action, explicitStatus(item), durationMs);
  }
  if (item.type === "image_generation_call") {
    const tool = makeTool(
      "image_generation",
      firstString(item.revised_prompt) === undefined ? {} : { revisedPrompt: firstString(item.revised_prompt) },
      explicitStatus(item),
      durationMs,
    );
    if (Object.hasOwn(item, "result")) tool.output = item.result;
    return tool;
  }
  return undefined;
}

function makeTool(
  toolName: string,
  input: unknown,
  status?: string,
  durationMs?: number,
): ReplayToolRecord {
  const tool: ReplayToolRecord = {
    kind: "tool",
    toolName,
    input,
    ...(status !== undefined ? { status } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    reasoningStep: {
      reasoning: `Codex exposed ${toolName} from the session transcript.`,
      actionTaken: `Ran ${toolName}`,
      ...(status !== undefined ? { result: `Codex transcript recorded status: ${status}.` } : {}),
    },
  };
  return tool;
}

function applyStatus(tool: ReplayToolRecord, status: string): void {
  tool.status = status;
  tool.reasoningStep.result = `Codex transcript recorded status: ${status}.`;
}

function explicitStatus(item: Record<string, unknown>): string | undefined {
  const status = firstString(item.status);
  if (status !== undefined) return status;
  if (isPlainObject(item.output) && typeof item.output.success === "boolean") return item.output.success ? "success" : "error";
  return undefined;
}

function responseItem(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (raw.type === "response_item") {
    if (isPlainObject(raw.item)) return raw.item;
    if (isPlainObject(raw.payload)) return raw.payload;
  }
  if (isPlainObject(raw.item) && raw.item.type === "response_item") {
    if (isPlainObject(raw.item.item)) return raw.item.item;
    if (isPlainObject(raw.item.payload)) return raw.item.payload;
  }
  return undefined;
}

function visibleText(value: unknown, role: "user" | "assistant"): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const visibleTypes = role === "user" ? new Set(["input_text", "text"]) : new Set(["output_text", "text"]);
  return value
    .filter(isPlainObject)
    .filter((part) => visibleTypes.has(String(part.type)))
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isPairableCall(type: unknown): boolean {
  return type === "function_call" || type === "custom_tool_call" || type === "tool_search_call";
}

function isOutputItem(type: unknown): boolean {
  return type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_search_output";
}

function isCompaction(raw: Record<string, unknown>, item: Record<string, unknown>): boolean {
  return raw.type === "compact" || raw.type === "compacted" || raw.type === "compacted_summary" || raw.type === "conversation_summary" || item.type === "compaction" || item.type === "compaction_summary" || item.type === "context_compaction";
}

function finiteNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

```

The finite-number helper above is the only duration source; do not derive duration from timestamps or `event_msg` mirrors.

- [x] **Step 4: Run the Codex tests**

Run: `node --import=tsx --test test/codex/codex-replay.test.ts`

Expected: PASS with 4 tests.

- [x] **Step 5: Run existing live Codex transcript tests**

Run: `node --import=tsx --test test/codex/codex-transcript.test.ts test/codex/codex-memory-flow.test.ts`

Expected: PASS; replay did not change the live fallback parser or adapter behavior.

- [x] **Step 6: Commit the Codex replay reader**

```bash
git add src/platforms/codex/replay.ts test/codex/codex-replay.test.ts
git commit -m "feat: normalize Codex rollout history"
```

### Task 4: Replay Command Provenance Without Live Memory Changes

**Files:**
- Modify: `src/runtime/provenance.ts`
- Create: `test/provenance.test.ts`

**Interfaces:**
- Consumes: the existing live provenance behavior and `ReplayPlatform`.
- Produces: `namsReplayProvenanceHeaders()` only. Do not modify `src/runtime/memory-service.ts`, its types, or its tests.

- [x] **Step 1: Write the failing replay provenance test**

Create `test/provenance.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { namsReplayProvenanceHeaders } from "../src/runtime/provenance.js";

test("replay provenance identifies the command without simulating a hook event", () => {
  const headers = namsReplayProvenanceHeaders("claude");
  assert.equal(headers["X-NAMS-Hooks-Harness"], "claude");
  assert.equal(headers["X-NAMS-Hooks-Command"], "replay");
  assert.equal(headers["X-NAMS-Hooks-Event"], undefined);
});
```

- [x] **Step 2: Run the provenance test to verify it fails**

Run: `node --import=tsx --test test/provenance.test.ts`

Expected: FAIL because `namsReplayProvenanceHeaders()` does not exist.

- [x] **Step 3: Add replay command provenance while preserving live headers**

Refactor `src/runtime/provenance.ts` only enough to share the non-secret base headers:

```ts
import type { HookInvocation, ReplayPlatform } from "../interfaces.js";

export function namsProvenanceHeaders(invocation: HookInvocation): Record<string, string> {
  return {
    ...baseProvenanceHeaders(invocation.platform),
    "X-NAMS-Hooks-Event": invocation.event,
  };
}

export function namsReplayProvenanceHeaders(platform: ReplayPlatform): Record<string, string> {
  return {
    ...baseProvenanceHeaders(platform),
    "X-NAMS-Hooks-Command": "replay",
  };
}

function baseProvenanceHeaders(harness: string): Record<string, string> {
  return {
    "X-NAMS-Hooks-Harness": harness,
    "X-NAMS-Hooks-Version": namsHooksVersion,
    "X-NAMS-Hooks-Platform": process.platform,
    "X-NAMS-Hooks-Node-Version": process.version,
  };
}
```

- [x] **Step 4: Run provenance and live memory regression tests**

Run: `node --import=tsx --test test/provenance.test.ts test/memory-service.test.ts test/claude/claude-memory-flow.test.ts test/codex/codex-memory-flow.test.ts`

Expected: PASS; existing live hook headers and memory-service behavior are unchanged.

- [x] **Step 5: Commit the focused provenance change**

```bash
git add src/runtime/provenance.ts test/provenance.test.ts
git commit -m "feat: add replay request provenance"
```

### Task 5: Static Replay Registry, One-Time Config Resolution, Retry, And Sequential Import

**Files:**
- Modify: `src/platforms/claude/index.ts`
- Modify: `src/platforms/codex/index.ts`
- Modify: `src/platforms/index.ts`
- Create: `src/runtime/replay.ts`
- Create: `test/replay-runtime.test.ts`
- Modify: `test/architecture.test.ts`
- Modify: `test/support/nams-fetch-mock.ts`

**Interfaces:**
- Consumes: `claudeReplayAdapter`, `codexReplayAdapter`, the adapter-owned optional `NamsConfigDiscovery`, existing `loadNamsConnectionConfig()` unchanged, `validWorkspaces()`, generated NAMS request/client types, existing `serializeToolInput()`/`serializeToolOutput()`, replay provenance, and Task 1 cwd containment.
- Produces: `getReplayPlatformAdapter()`, `runReplay(): Promise<ReplaySummary>`, `formatReplaySummary()`, and the complete request ordering/failure policy. The retry classifier and write helpers remain private to `src/runtime/replay.ts`.

- [x] **Step 1: Add a bulk-message helper to the existing NAMS test mock**

Extend `NamsFetchMock` in `test/support/nams-fetch-mock.ts` with:

```ts
bulkMessages(response?: RouteResponse, status?: number, conversationId?: string): NamsFetchMock;
```

Implement it beside `message()`:

```ts
bulkMessages(response = { messages: [] }, status = 201, conversationId = "conversation-1") {
  return api.post(`/v1/conversations/${conversationId}/messages/bulk`, response, status, "addMessagesBulk");
},
```

- [x] **Step 2: Write failing runtime tests for one-time resolution and timeline writes**

Create `test/replay-runtime.test.ts` with an in-memory `ReplayPlatformAdapter`. Isolate the existing process-environment-based configuration rather than changing `src/runtime/config.ts`: each test creates a temporary `HOME`, saves the relevant environment variables, sets `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL`, and restores them in `finally`. Keep these tests non-concurrent.

Start with these helpers:

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  ReplayPlatform,
  ReplayPlatformAdapter,
  ReplayTranscript,
} from "../src/interfaces.js";
import type { NamsConfigDiscovery } from "../src/runtime/config.js";
import { formatReplaySummary, runReplay } from "../src/runtime/replay.js";
import { createNamsFetchMock } from "./support/nams-fetch-mock.js";

const namsEnvironmentKeys = [
  "HOME",
  "NAMS_API_KEY",
  "NAMS_WORKSPACE_ID",
  "NAMS_BASE_URL",
] as const;

async function withNamsEnvironment<T>(
  callback: () => Promise<T>,
  overrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<T> {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-replay-runtime-"));
  const saved = Object.fromEntries(
    namsEnvironmentKeys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof namsEnvironmentKeys)[number], string | undefined>;
  Object.assign(process.env, {
    HOME: fixture,
    NAMS_API_KEY: "key",
    NAMS_WORKSPACE_ID: "workspace-1",
    NAMS_BASE_URL: "https://memory.example.test",
    ...overrides,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
  try {
    return await callback();
  } finally {
    for (const key of namsEnvironmentKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(fixture, { recursive: true, force: true });
  }
}

function adapter(
  platform: ReplayPlatform,
  paths: string[],
  transcripts: Record<string, ReplayTranscript>,
  discoverConfig?: NamsConfigDiscovery,
): ReplayPlatformAdapter {
  return {
    platform,
    ...(discoverConfig !== undefined ? { discoverConfig } : {}),
    async discoverTranscripts() { return paths; },
    async readTranscript(transcriptPath) { return transcripts[transcriptPath]; },
  };
}

function transcript(
  sourceSessionId: string,
  records: ReplayTranscript["records"],
  projectDirectory = "/project",
): ReplayTranscript {
  return {
    sourceSessionId,
    projectDirectory,
    records,
    malformedLineCount: 0,
    unsupportedRecordCount: 0,
  };
}

const noSleep = async (): Promise<void> => undefined;
```

The primary test exposes matching sessions in reverse discovery order plus one out-of-scope session. It proves that the adapter-owned configuration discovery runs exactly once, sessions run lexically and sequentially, source order is preserved across bulk-message/tool boundaries, and no recall endpoint is called:

```ts
test("resolves once and writes matching sessions sequentially in source order", async () => {
  await withNamsEnvironment(async () => {
    const nams = createNamsFetchMock()
      .createConversation({ id: "conversation-1" })
      .bulkMessages()
      .reasoningStep({ id: "step-1" })
      .toolCall({ id: "tool-1" });
    let configDiscoveryCalls = 0;
    const matching: ReplayTranscript = {
      sourceSessionId: "session-a",
      projectDirectory: "/project/worktree",
      sourceStartedAt: "2026-08-01T00:00:00.000Z",
      malformedLineCount: 1,
      unsupportedRecordCount: 2,
      records: [
        { kind: "message", role: "user", content: "one" },
        { kind: "message", role: "assistant", content: "two" },
        {
          kind: "tool",
          toolName: "shell",
          input: { command: "pwd", output: "strip" },
          output: "result",
          status: "success",
          reasoningStep: {
            reasoning: "Codex exposed shell from the session transcript.",
            actionTaken: "Ran shell",
          },
        },
        { kind: "message", role: "assistant", content: "three" },
      ],
    };
    const replayAdapter = adapter(
      "codex",
      ["/transcripts/z.jsonl", "/transcripts/a.jsonl", "/transcripts/out.jsonl"],
      {
        "/transcripts/a.jsonl": matching,
        "/transcripts/z.jsonl": {
          ...matching,
          sourceSessionId: "session-z",
          records: [{ kind: "message", role: "user", content: "z" }],
        },
        "/transcripts/out.jsonl": {
          ...matching,
          sourceSessionId: "outside",
          projectDirectory: "/project-old",
        },
      },
      async (receivedEnv) => {
        configDiscoveryCalls += 1;
        assert.equal(receivedEnv, process.env);
        return {};
      },
    );

    const summary = await runReplay({
      adapter: replayAdapter,
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
    });

    assert.equal(configDiscoveryCalls, 1);
    assert.deepEqual(summary, {
      discovered: 3,
      matched: 2,
      imported: 2,
      skipped: 1,
      failed: 0,
      messages: 4,
      toolCalls: 1,
      malformedLines: 3,
      unsupportedRecords: 6,
    });
    assert.deepEqual(nams.requestBodies("createConversation")[0].metadata, {
      harness: "codex",
      projectDirectory: "/project/worktree",
      sourceSessionId: "session-a",
      importSource: "nams-hooks-replay",
      sourceStartedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(
      Object.hasOwn(nams.requestBodies("createConversation")[0].metadata, "title"),
      false,
    );
    assert.deepEqual(
      nams.requestBodies("addMessagesBulk")
        .map((body) => body.messages.map((message: { content: string }) => message.content)),
      [["one", "two"], ["three"], ["z"]],
    );
    assert.deepEqual(nams.requestBodies("addReasoningStep"), [{
      conversationId: "conversation-1",
      reasoning: "Codex exposed shell from the session transcript.",
      actionTaken: "Ran shell",
    }]);
    assert.deepEqual(nams.requestBodies("addToolCall"), [{
      stepId: "step-1",
      toolName: "shell",
      input: "{\"command\":\"pwd\"}",
      output: "result",
      status: "success",
    }]);
    assert.equal(nams.calls("getConversationContext").length, 0);
    assert.equal(nams.calls("searchEntities").length, 0);
  });
});
```

Add focused tests for the following behavior. Exercise retry only through `runReplay()`; do not export or directly test the private classifier:

| Test | Required assertions |
|---|---|
| 101 contiguous messages | Bulk bodies have lengths `[100, 1]`; summary has `messages: 101`. |
| Message/tool/message order | The first message bulk completes before reasoning/tool requests and the trailing bulk follows them. |
| Sanitization parity | Tool input strips nested output-like fields and is capped exactly like `serializeToolInput()`; explicit output equals `serializeToolOutput()` and is not capped. |
| Missing tool output | The `RecordToolCallRequest` omits `output` instead of sending an empty string. |
| Missing/relative cwd, outside prefix sibling, empty records | All skip; only the eligible-empty transcript increments `matched`; no conversation is created. |
| Unreadable transcript | Increments `failed`, continues to the next session, and never includes the thrown message/path in progress. |
| Active transcript | `readTranscript()` is called exactly once; there is no stabilization or second pass. |
| Missing corpus root | After config resolution, discovery returns `[]`; summary succeeds with `discovered: 0`. |
| Reasoning response without id | Fails that session and never creates an unlinked tool call. |
| Tool call transient failure | Reasoning is written once; only the failed tool request is retried. |
| Partial write | A successful 100-message batch remains counted; a failed next batch stops that session; a later transcript imports. |
| Progress/summary | Startup progress reports `configSources` before discovery. Each eligible session reports `processing...` and one indented method/route-template line per HTTP attempt. Successful/skipped progress contains platform, source session id, status, and counts only. Failed NAMS writes report request/response bodies and HTTP attempt details while scrubbing credentials. The summary string remains stable. |

Use this observable retry matrix, with a fresh fetch mock and attempt counter per row:

```ts
test("retries recoverable HTTP failures twice after 500 ms", async () => {
  await withNamsEnvironment(async () => {
    for (const status of [408, 429, 500, 503, 599]) {
      let attempts = 0;
      const nams = createNamsFetchMock().createConversation(() => {
        attempts += 1;
        return attempts <= 2
          ? { status, body: { error: "temporary" } }
          : { status: 201, body: { id: "conversation-1" } };
      }).bulkMessages();
      const delays: number[] = [];
      const summary = await runReplay({
        adapter: adapter("claude", ["/one.jsonl"], {
          "/one.jsonl": transcript("one", [
            { kind: "message", role: "user", content: "one" },
          ]),
        }),
        importRoot: "/project",
        fetch: nams.fetch,
        sleep: async (delay) => { delays.push(delay); },
      });
      assert.equal(summary.failed, 0);
      assert.equal(attempts, 3);
      assert.deepEqual(delays, [500, 500]);
    }
  });
});

test("does not retry other 4xx failures", async () => {
  await withNamsEnvironment(async () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      let attempts = 0;
      const nams = createNamsFetchMock().createConversation(() => {
        attempts += 1;
        return { status, body: { error: "rejected" } };
      });
      const summary = await runReplay({
        adapter: adapter("codex", ["/one.jsonl"], {
          "/one.jsonl": transcript("one", [
            { kind: "message", role: "user", content: "one" },
          ]),
        }),
        importRoot: "/project",
        fetch: nams.fetch,
        sleep: noSleep,
      });
      assert.equal(summary.failed, 1);
      assert.equal(attempts, 1);
    }
  });
});
```

Add separate cases proving a transport `TypeError` succeeds on the third attempt, and a permanently recoverable response stops after exactly three attempts and two 500 ms waits. This is the explicit limit: one initial request plus two retries.

For workspace resolution, temporarily remove `NAMS_WORKSPACE_ID` inside `withNamsEnvironment()`. Assert that one valid workspace is requested exactly once and allows empty discovery; zero or multiple valid workspaces reject before transcript discovery. Assert top-level discovery and workspace errors use stable, path-free messages.

Finally assert:

```ts
assert.equal(
  formatReplaySummary("claude", summary),
  "Replay claude: discovered 1, matched 1, imported 1, skipped 0, failed 0; messages 1, tools 0, malformed lines 0, unsupported records 0.",
);
```

These tests cover one-time configuration, configuration-source and per-request progress, bulk boundaries, direct generated request bodies, sanitization reuse, eligibility skips, read isolation, retry classes and limits, tool-step retry granularity, partial writes, empty discovery, workspace resolution, credential-safe failure diagnostics, and stable summary formatting.

- [x] **Step 3: Run the runtime tests to verify they fail**

Run: `node --import=tsx --test test/replay-runtime.test.ts`

Expected: FAIL because the replay registry/runtime do not exist. Tests set and restore the three existing `NAMS_*` process variables around each run, following `test/runtime-config.test.ts`; do not add environment injection to production configuration APIs.

- [x] **Step 4: Export replay adapters through the existing platform entrypoints and add the static registry**

Add these replay-only re-exports to the platform entrypoints so `src/platforms/index.ts` remains the only consumer of concrete platform entrypoints:

```ts
// src/platforms/claude/index.ts
export { claudeReplayAdapter } from "./replay.js";

// src/platforms/codex/index.ts
export { codexReplayAdapter } from "./replay.js";
```

Modify the existing `src/platforms/index.ts` imports from `./claude/index.js` and `./codex/index.js` to include those replay adapter names. Import only `ReplayPlatform` and `ReplayPlatformAdapter`, then add:

```ts
const replayAdapters: Record<ReplayPlatform, ReplayPlatformAdapter> = {
  claude: claudeReplayAdapter,
  codex: codexReplayAdapter,
};

export function getReplayPlatformAdapter(platform: ReplayPlatform): ReplayPlatformAdapter {
  return replayAdapters[platform];
}
```

Add this assertion to `test/architecture.test.ts`. It rejects dynamic discovery, requires exactly Claude and Codex, and verifies that replay adapters enter the root registry through the established platform entrypoints:

```ts
test("replay adapter registry is static and limited to Claude and Codex", async () => {
  const content = await readFile("src/platforms/index.ts", "utf8");
  assert.equal(/\bimport\s*\(|\breaddir(?:Sync)?\b|\bdynamic\b/.test(content), false);
  assert.match(content, /import\s+\{[^}]*\bclaudeReplayAdapter\b[^}]*\}\s+from\s+["']\.\/claude\/index\.js["']/);
  assert.match(content, /import\s+\{[^}]*\bcodexReplayAdapter\b[^}]*\}\s+from\s+["']\.\/codex\/index\.js["']/);

  const registry = content.match(
    /const\s+replayAdapters:\s*Record<ReplayPlatform, ReplayPlatformAdapter>\s*=\s*\{([\s\S]*?)\n\};/,
  );
  assert.ok(registry);
  assert.deepEqual(
    [...registry[1].matchAll(/\b(claude|codex)\s*:/g)].map((match) => match[1]).sort(),
    ["claude", "codex"],
  );
});
```

- [x] **Step 5: Implement replay orchestration and retry policy directly on the generated client**

Create `src/runtime/replay.ts` with these imports and the input interface. The exported function implementations immediately below provide the public signatures:

```ts
import path from "node:path";
import {
  NamsClient,
  NamsClientError,
  NamsWorkspaceClient,
  type AddMessageRequest,
  type RecordToolCallRequest,
  type WorkspaceListResponse,
} from "../generated/nams-client.js";
import type {
  ReplayPlatform,
  ReplayPlatformAdapter,
  ReplayRecord,
  ReplaySummary,
  ReplayTranscript,
} from "../interfaces.js";
import {
  loadNamsConnectionConfig,
  type NamsRuntimeConfig,
} from "./config.js";
import {
  serializeToolInput,
  serializeToolOutput,
} from "./memory-service.js";
import { namsReplayProvenanceHeaders } from "./provenance.js";
import { isDirectoryWithinImportRoot } from "./replay-files.js";
import { validWorkspaces } from "./workspace-configuration.js";

export interface RunReplayInput {
  adapter: ReplayPlatformAdapter;
  importRoot: string;
  fetch?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  onProgress?: (line: string) => void;
}

```

Implement the functions with the following complete control flow. Keep the platform adapter injected so `src/runtime/**` never imports `src/platforms/**`:

```ts
const retryDelayMs = 500;
const maxReplayRetries = 2;

export async function runReplay(input: RunReplayInput): Promise<ReplaySummary> {
  const sleep = input.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const importRoot = path.resolve(input.importRoot);
  const platform = input.adapter.platform;

  const config = await resolveReplayConfig(importRoot, input.adapter, input.fetch, sleep);
  const client = new NamsClient({
    apiKey: config.apiKey,
    workspaceId: config.workspaceId,
    baseUrl: config.baseUrl,
    defaultHeaders: namsReplayProvenanceHeaders(platform),
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
  });
  let transcriptPaths: string[];
  try {
    transcriptPaths = [...await input.adapter.discoverTranscripts()].sort();
  } catch {
    throw new Error(`Unable to discover ${platform} replay transcripts`);
  }
  const summary = emptySummary(transcriptPaths.length);

  for (let index = 0; index < transcriptPaths.length; index += 1) {
    const transcriptPath = transcriptPaths[index];
    let transcript: ReplayTranscript;
    try {
      transcript = await input.adapter.readTranscript(transcriptPath);
    } catch {
      summary.failed += 1;
      input.onProgress?.(progressLine(index, transcriptPaths.length, platform, path.basename(transcriptPath, ".jsonl"), "failed", "unreadable transcript"));
      continue;
    }

    summary.malformedLines += transcript.malformedLineCount;
    summary.unsupportedRecords += transcript.unsupportedRecordCount;
    if (transcript.projectDirectory === undefined || !isDirectoryWithinImportRoot(importRoot, transcript.projectDirectory)) {
      summary.skipped += 1;
      input.onProgress?.(progressLine(index, transcriptPaths.length, platform, transcript.sourceSessionId, "skipped", "cwd outside import root or unusable"));
      continue;
    }
    summary.matched += 1;
    if (transcript.records.length === 0) {
      summary.skipped += 1;
      input.onProgress?.(progressLine(index, transcriptPaths.length, platform, transcript.sourceSessionId, "skipped", "zero eligible records"));
      continue;
    }

    try {
      const conversationId = await withReplayRetry(
        async () => {
          const response = await client.createConversation({
            metadata: {
              harness: platform,
              projectDirectory: transcript.projectDirectory as string,
              sourceSessionId: transcript.sourceSessionId,
              importSource: "nams-hooks-replay",
              ...(transcript.sourceStartedAt !== undefined ? { sourceStartedAt: transcript.sourceStartedAt } : {}),
            },
          });
          if (response.id === undefined || response.id.trim() === "") {
            throw new Error("NAMS conversation response did not include id");
          }
          return response.id;
        },
        sleep,
      );
      const counts = await importTimeline(client, conversationId, transcript.records, sleep, summary);
      summary.imported += 1;
      input.onProgress?.(progressLine(index, transcriptPaths.length, platform, transcript.sourceSessionId, "imported", `${counts.messages} messages, ${counts.toolCalls} tools`));
    } catch {
      summary.failed += 1;
      input.onProgress?.(progressLine(index, transcriptPaths.length, platform, transcript.sourceSessionId, "failed", "NAMS write failed"));
    }
  }
  return summary;
}

async function importTimeline(
  client: NamsClient,
  conversationId: string,
  records: ReplayRecord[],
  sleep: (delayMs: number) => Promise<void>,
  summary: ReplaySummary,
): Promise<{ messages: number; toolCalls: number }> {
  let messages = 0;
  let toolCalls = 0;
  let pending: AddMessageRequest[] = [];
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    await withReplayRetry(() => client.addMessagesBulk(conversationId, { messages: batch }), sleep);
    messages += batch.length;
    summary.messages += batch.length;
  };

  for (const record of records) {
    if (record.kind === "message") {
      pending.push({ role: record.role, content: record.content });
      if (pending.length === 100) await flush();
      continue;
    }
    await flush();
    const stepResponse = await withReplayRetry(
      () => client.recordReasoningStep({ conversationId, ...record.reasoningStep }),
      sleep,
    );
    const stepId = stepResponse.id;
    if (stepId === undefined || stepId.trim() === "") {
      throw new Error("NAMS reasoning response did not include id");
    }
    const toolRequest: RecordToolCallRequest = {
      stepId,
      toolName: record.toolName,
      input: serializeToolInput(record.input),
      ...(record.output !== undefined ? { output: serializeToolOutput(record.output) } : {}),
      ...(record.status !== undefined ? { status: record.status } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    };
    await withReplayRetry(() => client.recordToolCall(toolRequest), sleep);
    toolCalls += 1;
    summary.toolCalls += 1;
  }
  await flush();
  return { messages, toolCalls };
}

async function withReplayRetry<T>(operation: () => Promise<T>, sleep: (delayMs: number) => Promise<void>): Promise<T> {
  let retries = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isRecoverableReplayError(error) || retries === maxReplayRetries) throw error;
      retries += 1;
      await sleep(retryDelayMs);
    }
  }
}

function isRecoverableReplayError(error: unknown): boolean {
  if (error instanceof NamsClientError) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599);
  }
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error) || !("code" in error)) return false;
  return new Set(["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN"]).has(String(error.code));
}
```

Add the remaining helpers to the same file. Do not introduce a named input type for a private function whose existing argument types are sufficient. Configuration calls the unchanged loader exactly once with the adapter's optional discovery callback; workspace lookup occurs only when that one result lacks a workspace id:

```ts
async function resolveReplayConfig(
  importRoot: string,
  adapter: ReplayPlatformAdapter,
  fetchImpl: typeof fetch | undefined,
  sleep: (delayMs: number) => Promise<void>,
): Promise<NamsRuntimeConfig> {
  const connection = await loadNamsConnectionConfig(importRoot, adapter.discoverConfig);
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
  const client = new NamsWorkspaceClient({
    apiKey: connection.config.apiKey,
    baseUrl: connection.config.baseUrl,
    defaultHeaders: namsReplayProvenanceHeaders(adapter.platform),
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
  });
  let response: WorkspaceListResponse;
  try {
    response = await withReplayRetry(() => client.listMyWorkspaces(), sleep);
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

function emptySummary(discovered: number): ReplaySummary {
  return {
    discovered,
    matched: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    messages: 0,
    toolCalls: 0,
    malformedLines: 0,
    unsupportedRecords: 0,
  };
}

function progressLine(
  index: number,
  total: number,
  platform: ReplayPlatform,
  sourceSessionId: string,
  status: "imported" | "skipped" | "failed",
  detail: string,
): string {
  return `[${index + 1}/${total}] ${platform} ${sourceSessionId}: ${status} ${detail}`;
}

export function formatReplaySummary(platform: ReplayPlatform, summary: ReplaySummary): string {
  return [
    `Replay ${platform}: discovered ${summary.discovered}, matched ${summary.matched}, imported ${summary.imported}, skipped ${summary.skipped}, failed ${summary.failed};`,
    `messages ${summary.messages}, tools ${summary.toolCalls}, malformed lines ${summary.malformedLines}, unsupported records ${summary.unsupportedRecords}.`,
  ].join(" ");
}
```

- [x] **Step 6: Run runtime, config, memory, and architecture tests**

Run: `node --import=tsx --test test/replay-runtime.test.ts test/runtime-config.test.ts test/memory-service.test.ts test/architecture.test.ts`

Expected: PASS; replay uses the current configuration and sanitization behavior without changing either module.

- [x] **Step 7: Commit the replay runtime**

```bash
git add src/platforms/claude/index.ts src/platforms/codex/index.ts src/platforms/index.ts src/runtime/replay.ts test/replay-runtime.test.ts test/architecture.test.ts test/support/nams-fetch-mock.ts
git commit -m "feat: orchestrate sequential session replay"
```

### Task 6: CLI Command, End-To-End Behavior, Domain Language, And Verification

**Files:**
- Modify: `src/cli.ts`
- Create: `test/cli-replay.test.ts`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `replayPlatforms`, `getReplayPlatformAdapter()`, `runReplay()`, and `formatReplaySummary()`.
- Produces: the public `nams-hooks replay <claude|codex> [--working-dir PATH]` command and final user-visible behavior.

- [x] **Step 1: Write failing CLI replay tests**

Create `test/cli-replay.test.ts` using `node:http.createServer`, the compiled `.build/tsc/cli.js`, temporary `HOME`, and a temporary Claude/Codex corpus. Start the file with these complete helpers:

```ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, ".build", "tsc", "cli.js");

interface CliResult { code: number | null; stdout: string; stderr: string }
interface CapturedRequest { path: string; headers: Record<string, string | string[] | undefined>; body: unknown }

async function withNamsServer<T>(handler: (baseUrl: string, requests: CapturedRequest[]) => Promise<T>): Promise<T> {
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
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
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
  requests.push({ path: pathname, headers: request.headers, body: text === "" ? undefined : JSON.parse(text) });
  if (request.method === "POST" && pathname === "/v1/conversations") return json(response, 201, { id: "conversation-1" });
  if (request.method === "POST" && pathname === "/v1/conversations/conversation-1/messages/bulk") return json(response, 201, { messages: [] });
  if (request.method === "POST" && pathname === "/v1/reasoning/steps") return json(response, 201, { id: "step-1" });
  if (request.method === "POST" && pathname === "/v1/reasoning/tool-calls") return json(response, 201, { id: "tool-1" });
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

test("replay claude imports without reading stdin and writes no replay state or logs", async () => {
  await withNamsServer(async (baseUrl, requests) => {
    const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-replay-"));
    try {
      const project = path.join(fixture, "project");
      const home = path.join(fixture, "home");
      const transcriptDir = path.join(fixture, "claude", "projects", "encoded");
      await mkdir(project, { recursive: true });
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(path.join(transcriptDir, "session-1.jsonl"), [
        JSON.stringify({ type: "user", sessionId: "session-1", cwd: project, message: { role: "user", content: "Remember replay." } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Imported." } }),
      ].join("\n"), "utf8");

      const result = await runCli(["replay", "claude", "--working-dir", project], project, {
        HOME: home,
        CLAUDE_CONFIG_DIR: path.join(fixture, "claude"),
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: baseUrl,
      }, "{not-json");

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Replay claude: discovered 1, matched 1, imported 1, skipped 0, failed 0/);
      assert.match(result.stderr, /claude session-1: imported/);
      assert.deepEqual(requests.map((request) => request.path), [
        "/v1/conversations",
        "/v1/conversations/conversation-1/messages/bulk",
      ]);
      assert.equal(requests[0].headers["x-nams-hooks-command"], "replay");
      assert.equal(requests[0].headers["x-nams-hooks-event"], undefined);
      const createBody = requests[0].body as { metadata: Record<string, string> };
      assert.equal(Object.hasOwn(createBody.metadata, "title"), false);
      await assert.rejects(access(path.join(home, ".nams", "state")));
      await assert.rejects(access(path.join(home, ".nams", "logs")));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
```

The first test sends malformed JSON on stdin; its successful import proves replay never calls `readJsonPayload()` without risking a hanging child process. Add these parsing and empty-corpus tests:

```ts
test("replay defaults the import root to the child cwd", async () => {
  await withNamsServer(async (baseUrl) => {
    const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-replay-"));
    try {
      const transcriptDir = path.join(fixture, "codex", "sessions", "2026", "08");
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(path.join(transcriptDir, "rollout.jsonl"), [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-1", cwd: fixture } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "default cwd" } }),
      ].join("\n"), "utf8");
      const result = await runCli(["replay", "codex"], fixture, {
        HOME: path.join(fixture, "home"),
        CODEX_HOME: path.join(fixture, "codex"),
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: baseUrl,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /matched 1, imported 1/);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

test("replay rejects unsupported platforms malformed flags and extra arguments", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-replay-"));
  try {
    for (const args of [
      ["replay", "gemini"],
      ["replay", "claude", "--working-dir"],
      ["replay", "claude", "--working-dir", ""],
      ["replay", "claude", `--working-dir=${fixture}`],
      ["replay", "claude", "--working-dir", fixture, "extra"],
    ]) {
      const result = await runCli(args, fixture, {});
      assert.equal(result.code, 1);
      assert.match(result.stderr, /nams-hooks replay <claude\|codex>/);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a missing transcript root is a successful zero import", async () => {
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
      assert.match(result.stdout, /discovered 0, matched 0, imported 0/);
      assert.deepEqual(requests, []);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
```

The successful endpoint list in the first test also proves replay does not call conversation-context, entity-search, single-message, or workspace-list endpoints when a workspace is configured. Per-session partial failure and nonzero final exit are covered at the runtime boundary in Task 5, where the NAMS request sequence is deterministic.

- [x] **Step 2: Run the CLI tests to verify they fail**

Run: `npm run build && node --import=tsx --test test/cli-replay.test.ts`

Expected: FAIL with replay usage/dispatch missing.

- [x] **Step 3: Add replay parsing and dispatch to the CLI gateway**

Modify `src/cli.ts` imports to add these replay dependencies. Merge the named imports into the existing blocks rather than duplicating module imports:

```ts
import path from "node:path";
import {
  replayPlatforms,
  type ReplayPlatform,
} from "./interfaces.js";
import {
  getReplayPlatformAdapter,
} from "./platforms/index.js";
import { formatReplaySummary, runReplay } from "./runtime/replay.js";
```

Extend `CliArgs`:

```ts
type CliArgs =
  | { command: "run"; platform: Platform; event: HookEvent }
  | { command: "workspaces"; platform: Platform; event: WorkspaceHookEvent }
  | { command: "replay"; platform: ReplayPlatform; workingDirectory?: string }
  | {
      command: "workspace-configure";
      platform: Platform;
      scope: "project" | "user" | "session";
      workspace?: string;
      sessionId?: string;
    };
```

Handle replay before `readJsonPayload()` in `main()`:

```ts
if (args.command === "replay") {
  const importRoot = path.resolve(args.workingDirectory ?? process.cwd());
  const adapter = getReplayPlatformAdapter(args.platform);
  const summary = await runReplay({
    importRoot,
    adapter,
    onProgress: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${formatReplaySummary(adapter.platform, summary)}\n`);
  return summary.failed === 0 ? 0 : 1;
}
```

Add strict replay parsing at the beginning of `parseArgs()`:

```ts
if (command === "replay" && isReplayPlatform(platformArg)) {
  if (argv.length === 2) return { command: "replay", platform: platformArg };
  if (argv.length === 4 && argv[2] === "--working-dir" && argv[3] !== undefined && argv[3].trim() !== "" && !argv[3].startsWith("--")) {
    return { command: "replay", platform: platformArg, workingDirectory: argv[3] };
  }
  return null;
}
```

Add the guard and usage line:

```ts
function isReplayPlatform(value: string | undefined): value is ReplayPlatform {
  return value !== undefined && replayPlatforms.includes(value as ReplayPlatform);
}
```

```text
Usage: nams-hooks replay <claude|codex> [--working-dir PATH]
```

Do not add a hook event or route replay through `routeEvent()`.

- [x] **Step 4: Run CLI and focused replay tests**

Run: `npm run build && node --import=tsx --test test/cli-replay.test.ts test/replay-files.test.ts test/replay-runtime.test.ts test/claude/claude-replay.test.ts test/codex/codex-replay.test.ts`

Expected: PASS.

- [x] **Step 5: Update the domain language without adding documentation tests**

Edit `CONTEXT.md` so it no longer defines imports as top-level-only. Replace `Top-Level Session` with:

```markdown
**Persisted Source Session**:
Any independently persisted Claude or Codex JSONL transcript in the standard corpus whose first working directory belongs to the import root. Subagent, sidechain, fork, active, and archived classifications do not change eligibility; each matching file maps to its own imported conversation.
_Avoid_: Top-level-only session, reconstructed parent history
```

Update `Eligible Session Record` to remove “from a top-level session” and state that only visible user/assistant text and clearly exposed tool activity are eligible. Keep `Operational Trace` explicit that raw/summarized model reasoning is excluded. Do not add a test that reads or asserts `CONTEXT.md`.

- [x] **Step 6: Run the complete repository verification**

Run: `npm run check`

Expected: OpenAPI generation/freshness, TypeScript build, test typecheck, rebuild, and the complete Node test suite all pass.

- [x] **Step 7: Inspect the final diff for scope and generated artifacts**

Run:

```bash
git status --short
git diff --check
git diff -- src test CONTEXT.md
```

Expected: no whitespace errors; only replay-related source/tests and `CONTEXT.md` are changed; `.build/`, `dist/`, `.nams/`, logs, state, credentials, and unrelated untracked files are absent from the staged feature diff.

- [x] **Step 8: Commit the public command and domain update**

```bash
git add src/cli.ts test/cli-replay.test.ts CONTEXT.md
git commit -m "feat: add offline session replay command"
```
