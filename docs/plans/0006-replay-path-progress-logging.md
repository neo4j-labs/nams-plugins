# Replay Path Progress Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit the full path and disposition of every processed Codex rollout file, plus the full temporary outbox path, through replay progress logging.

**Architecture:** The Codex collector will report one typed file-progress event after each JSONL file is classified as imported or skipped. The replay runner will translate those events and the newly created outbox path into stable progress lines through its existing `onProgress` callback; the CLI already writes that callback to stderr. This intentionally supersedes the path-redaction requirements in `docs/plans/0005-codex-session-outbox-replay.md`, while retaining private file permissions and `finally` cleanup.

**Tech Stack:** TypeScript 5.9, Node.js 20+ ESM and built-ins, Node `node:test`, and `tsx`.

## Global Constraints

- Emit progress through `RunCodexReplayInput.onProgress`; the CLI continues writing progress to stderr and the aggregate summary to stdout.
- Emit exactly `Codex replay file imported: <absolute path>` for a rollout accepted into the normalized corpus.
- Emit exactly `Codex replay file skipped: <absolute path>` for a rollout rejected by metadata or import-root filtering.
- `imported` means the file contributed to the normalized corpus and outbox projection; it does not claim that every remote NAMS request succeeded.
- Emit exactly `Codex replay outbox: <absolute path>` after the private outbox file is created and before delivery begins, including for a zero-session outbox.
- Full rollout and outbox paths are intentionally operator-visible on stderr. Do not print file contents, tool inputs/outputs, API keys, or other secrets.
- Keep the outbox directory mode `0700`, file mode `0600`, and `finally` cleanup unchanged. The logged outbox path may no longer exist after the handled run finishes.
- A rollout read/parse exception that aborts collection is not mislabeled imported or skipped.
- Do not add runtime dependencies, persistent replay logs, `.nams/state/` writes, retries, checkpoints, or generated-artifact edits.
- Tests use OS temporary fixtures, make no external network calls, and leave no replay artifacts in the repository.

---

### Task 1: Emit Rollout And Outbox Paths Through Replay Progress

**Files:**
- Modify: `src/platforms/codex/replay-model.ts`
- Modify: `src/platforms/codex/replay-collector.ts`
- Modify: `src/platforms/codex/replay-runner.ts`
- Modify: `test/codex/codex-replay-runner.test.ts`
- Modify: `test/cli-replay.test.ts`
- Modify: `docs/adr/0002-codex-session-outbox-replay.md`
- Modify: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`

**Interfaces:**
- Consumes: `RunCodexReplayInput.onProgress?: (line: string) => void` and the existing sorted `transcriptPaths` collection loop.
- Produces: `CodexReplayFileProgress` and `CollectCodexReplayInput.onFileProcessed?: (event: CodexReplayFileProgress) => void`.
- Emits: `Codex replay file imported: <absolute path>`, `Codex replay file skipped: <absolute path>`, and `Codex replay outbox: <absolute path>`.

- [x] **Step 1: Write failing runner progress coverage**

Extend the return type of `writeRunnerRollouts()` in `test/codex/codex-replay-runner.test.ts` with the three paths:

```ts
Promise<{
  project: string;
  temporaryRoot: string;
  rootPath: string;
  childPath: string;
  skippedPath: string;
}>
```

After the existing `childPath` declaration, add:

```ts
const skippedPath = path.join(sessionsRoot, "outside.jsonl");
```

After the existing `writeFile(childPath, ...)` call, add the skipped fixture and replace the helper's return statement:

```ts
await writeFile(skippedPath, jsonl([
  sessionMeta({
    sessionId: "outside-session",
    cwd: path.join(fixture, "outside-project"),
    threadSource: "user",
  }),
]), "utf8");
return { project, temporaryRoot, rootPath, childPath, skippedPath };
```

In `imports one grouped session and cleans the successful outbox`, capture progress and assert the processed-file lines and transient outbox line before the request-progress lines:

```ts
const progress: string[] = [];
const summary = await runCodexReplay({
  importRoot: project,
  temporaryRoot,
  fetch: nams.fetch,
  onProgress: (line) => progress.push(line),
});

assert.equal(summary.discoveredFiles, 3);
assert.equal(summary.matchedFiles, 2);
assert.equal(summary.skippedFiles, 1);
assert.deepEqual(progress.slice(0, 3), [
  `Codex replay file skipped: ${skippedPath}`,
  `Codex replay file imported: ${rootPath}`,
  `Codex replay file imported: ${childPath}`,
]);
assert.equal(
  progress[3].startsWith(
    `Codex replay outbox: ${temporaryRoot}${path.sep}nams-hooks-codex-replay-`,
  ),
  true,
);
assert.equal(progress[3].endsWith(`${path.sep}outbox.jsonl`), true);
```

Replace the complete summary assertion with:

```ts
assert.deepEqual(summary, {
  discoveredFiles: 3,
  matchedFiles: 2,
  skippedFiles: 1,
  sessions: 1,
  conversations: 1,
  messages: 1,
  reasoningSteps: 1,
  toolCalls: 1,
  malformedLines: 0,
  unsupportedRecords: 0,
});
```

Retain `assert.deepEqual(await readdir(temporaryRoot), []);` to prove cleanup.

- [x] **Step 2: Write failing CLI stderr coverage**

In `replay codex groups root and subagent files without reading stdin` in `test/cli-replay.test.ts`, add an `outsidePath` rollout under the same Codex sessions root:

```ts
const outsidePath = path.join(codexHome, "sessions", "outside.jsonl");
await writeFile(outsidePath, jsonl([
  sessionMeta({
    sessionId: "outside-session",
    cwd: path.join(fixture, "outside-project"),
    threadSource: "user",
  }),
]), "utf8");
```

Replace the prior assertion that stderr does not expose an outbox path with:

```ts
assert.equal(result.stderr.includes(`Codex replay file imported: ${rootPath}\n`), true);
assert.equal(result.stderr.includes(`Codex replay file imported: ${childPath}\n`), true);
assert.equal(result.stderr.includes(`Codex replay file skipped: ${outsidePath}\n`), true);
assert.match(
  result.stderr,
  /Codex replay outbox: .*nams-hooks-codex-replay-.*[\\/]outbox\.jsonl/,
);
```

Update the stdout summary expectation to `discovered files 3, matched files 2, skipped files 1, sessions 1`. Keep the request-order and no-`.nams/state`/`.nams/logs` assertions unchanged.

- [x] **Step 3: Run the focused tests to verify RED**

Run:

```bash
npm run build
node --import=tsx --test \
  test/codex/codex-replay-runner.test.ts \
  test/cli-replay.test.ts
```

Expected: FAIL because no processed-file or outbox-path progress lines are emitted, and the collection summary does not yet include the new skipped fixture correctly in the asserted progress.

- [x] **Step 4: Add the typed collector progress interface**

Add this interface to `src/platforms/codex/replay-model.ts`:

```ts
export interface CodexReplayFileProgress {
  path: string;
  status: "imported" | "skipped";
}
```

Extend `CollectCodexReplayInput` with:

```ts
onFileProcessed?: (event: CodexReplayFileProgress) => void;
```

- [x] **Step 5: Emit one collector event after each successful classification**

Import `CodexReplayFileProgress` only where TypeScript needs it. In `collectCodexReplaySessions()`, emit the skipped event immediately before continuing from the metadata/import-root rejection:

```ts
skippedFiles += 1;
input.onFileProcessed?.({ path: transcriptPath, status: "skipped" });
continue;
```

Emit the imported event only after group validation and stream collection have succeeded and the file has contributed its messages/steps:

```ts
session.messages.push(...stream.messages);
session.steps.push(...stream.steps);
unsupportedRecords += stream.unsupportedRecords;
input.onFileProcessed?.({ path: transcriptPath, status: "imported" });
```

Do not emit a classification when `parseRollout()`, conflicting project-directory validation, or stream assembly throws.

- [x] **Step 6: Translate collector and outbox events into runner progress**

Import `CodexReplayFileProgress` as a type from `replay-model.js`.

Replace `runCodexReplay()` with this complete function so collector progress is forwarded and the outbox line remains inside `try` for cleanup safety:

```ts
export async function runCodexReplay(
  input: RunCodexReplayInput,
): Promise<CodexReplayRunSummary> {
  const collection = await collectCodexReplaySessions({
    importRoot: input.importRoot,
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.onProgress !== undefined
      ? {
          onFileProcessed: (event: CodexReplayFileProgress) => {
            input.onProgress?.(`Codex replay file ${event.status}: ${event.path}`);
          },
        }
      : {}),
  });
  const outbox = await createCodexReplayOutbox({
    sessions: collection.sessions,
    ...(input.temporaryRoot !== undefined ? { temporaryRoot: input.temporaryRoot } : {}),
  });
  try {
    input.onProgress?.(`Codex replay outbox: ${outbox.path}`);
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
```

This emits the outbox location for successful, failed-delivery, and zero-session runs without changing cleanup or delivery semantics.

- [x] **Step 7: Record the intentional path-disclosure contract**

Append this paragraph to `docs/adr/0002-codex-session-outbox-replay.md`:

```markdown
Replay progress intentionally writes full processed rollout paths and their `imported` or `skipped` classification to stderr. After creating the private temporary outbox, it also writes the full outbox path before delivery begins. These paths are operator-visible diagnostics; the outbox still uses private permissions and is removed after a handled run, so the logged path may no longer exist when replay exits. Progress never includes rollout contents, outbox contents, tool inputs or outputs, or credentials.
```

Add this paragraph after the outbox-creation paragraph and before sender behavior in `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`:

```markdown
Replay progress on stderr includes one full-path classification for every successfully processed rollout stream: `Codex replay file imported: <absolute path>` when the stream contributes to the normalized corpus, or `Codex replay file skipped: <absolute path>` when metadata or import-root filtering rejects it. After the private outbox is created, stderr also includes `Codex replay outbox: <absolute path>` before delivery. These operator-visible paths intentionally supersede the earlier path-redaction rule; no rollout contents, outbox contents, tool inputs or outputs, or credentials are printed. The aggregate success summary remains on stdout.
```

- [x] **Step 8: Run focused and full verification**

Run:

```bash
npm run build
node --import=tsx --test \
  test/codex/codex-replay-collector.test.ts \
  test/codex/codex-replay-runner.test.ts \
  test/cli-replay.test.ts
npm run check
git diff --check
git status --short -- dist dist-marketplace dist-local
```

Expected: all focused tests and `npm run check` pass; whitespace output is empty; generated distribution directories have no source changes.

- [x] **Step 9: Commit the progress logging change**

```bash
git add \
  src/platforms/codex/replay-model.ts \
  src/platforms/codex/replay-collector.ts \
  src/platforms/codex/replay-runner.ts \
  test/codex/codex-replay-runner.test.ts \
  test/cli-replay.test.ts \
  docs/adr/0002-codex-session-outbox-replay.md \
  docs/superpowers/specs/2026-05-10-nams-hooks-design.md \
  docs/plans/0006-replay-path-progress-logging.md
git commit -m "feat: log Codex replay paths"
```

---

## Self-Review Results

- Spec coverage: rollout imported/skipped lines, outbox location, stderr routing, status meaning, cleanup, privacy boundary, tests, and documentation are all assigned to Task 1.
- Placeholder scan: no `TBD`, `TODO`, deferred implementation, comment-only test, or undefined interface remains.
- Type consistency: the collector emits `CodexReplayFileProgress`; the runner consumes it through the existing string `onProgress` interface; the CLI remains unchanged because it already maps progress to stderr.
- Scope: no persistent replay log, retry, checkpoint, runtime dependency, generated artifact, or content logging is introduced.
