# OpenCode Memory Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build an OpenCode NAMS integration comparable to the existing Gemini memory flow: project-local plugin shim, lazy NAMS conversation creation, first-response recall, user and assistant message persistence, tool metadata capture, session-scoped logs, and no runtime npm dependencies.

**Architecture:** OpenCode uses a plugin shim in `.opencode/plugins/` that shells out to the existing CLI gateway with typed semantic events. `src/cli.ts` stays platform-agnostic; `src/platforms/opencode/` parses OpenCode payloads and orchestrates NAMS calls through shared runtime services. OpenCode context injection uses `experimental.chat.system.transform` so recalled memory is not written into user-authored message parts.

**Tech Stack:** TypeScript, Node.js built-ins, OpenCode project plugin JavaScript, generated `NamsClient`, Node's built-in `node:test`, existing fetch mock support, and the current ArchUnitTS architecture tests.

---

## Scope

Included:

- Add `opencode` to the shared platform contract and static adapter registry.
- Add OpenCode parser and adapter modules under `src/platforms/opencode/`.
- Add a dependency-free OpenCode plugin template under `templates/opencode/plugins/nams-hooks.js`.
- Route OpenCode `session.created`, `chat.message`, `experimental.chat.system.transform`, `experimental.text.complete`, and `tool.execute.after`.
- Persist local state under `.nams/state/sessions/opencode/`.
- Use session-scoped `.nams/logs/session-*.jsonl` logs for OpenCode.
- Preserve zero runtime dependencies.
- Update README/INSTALL documentation for manual project-level OpenCode setup.

Deferred:

- Publishing a dedicated npm OpenCode plugin package.
- Automatic installer support.
- Persisting OpenCode reasoning parts.
- Stable full-response assembly if OpenCode later exposes a non-experimental completed assistant-message hook.
- Live OpenCode CLI integration tests.

## File Structure

Create:

- `src/platforms/opencode/index.ts`: OpenCode adapter and memory-flow orchestration.
- `src/platforms/opencode/payload.ts`: OpenCode payload extraction helpers.
- `templates/opencode/plugins/nams-hooks.js`: project-local OpenCode plugin shim.
- `test/opencode/opencode-payload.test.js`: parser contract tests.
- `test/opencode/opencode-memory-flow.test.js`: adapter memory-flow tests with mocked NAMS.
- `test/opencode/opencode-template.test.js`: plugin template smoke tests.

Modify:

- `src/interfaces.ts`: add `opencode` platform.
- `src/platforms/index.ts`: register `OpenCodeAdapter`.
- `src/runtime/session-state.ts`: add optional pending context and OpenCode id tracking fields.
- `test/architecture.test.js`: include `opencode` in platform-boundary rules.
- `test/cli-session-start.test.js`: add OpenCode gateway routing coverage.
- `README.md`: add OpenCode support note.
- `INSTALL.md`: add OpenCode local plugin setup.

---

### Task 1: Add OpenCode Platform Contract And Gateway Routing

**Files:**

- Modify: `src/interfaces.ts`
- Modify: `src/platforms/index.ts`
- Create: `src/platforms/opencode/index.ts`
- Modify: `test/architecture.test.js`
- Modify: `test/cli-session-start.test.js`

- [x] **Step 1: Write failing CLI routing tests**

In `test/cli-session-start.test.js`, extend the harness list and route checks:

```js
for (const harness of ["gemini", "claude", "codex", "opencode"]) {
  test(`logs ${harness} session-start JSON payload`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const payload = {
        session_id: `${harness}-session-1`,
        hook_event_name: "SessionStart",
        cwd: projectDir,
        timestamp: "2026-05-10T09:00:00.000Z",
      };

      const result = await runCli(harness, payload, projectDir);

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        continue: true,
        suppressOutput: true,
      });

      const logPath =
        harness === "gemini" || harness === "opencode"
          ? await singleSessionLogPath(projectDir)
          : path.join(projectDir, ".nams", "logs", `${harness}-session-start.jsonl`);
      const lines = (await readFile(logPath, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.harness, harness);
      assert.equal(entry.event, "SessionStart");
      assert.deepEqual(entry.payload, payload);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
}

for (const event of ["BeforeAgent", "AfterAgent", "AfterTool"]) {
  test(`routes opencode ${event} hook event`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const result = await runCliWithEvent(
        "opencode",
        event,
        {
          hook: "test",
          input: { sessionID: `opencode-${event}` },
          directory: projectDir,
        },
        projectDir,
      );

      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).continue, true);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
}
```

For the existing session-start log path assertion, treat `opencode` like Gemini because it should use session-scoped logs once the adapter exists:

```js
const logPath =
  harness === "gemini" || harness === "opencode"
    ? await singleSessionLogPath(projectDir)
    : path.join(projectDir, ".nams", "logs", `${harness}-session-start.jsonl`);
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/cli-session-start.test.js
```

Expected: FAIL because `opencode` is not a valid platform.

- [x] **Step 3: Add OpenCode to shared interfaces**

Change `src/interfaces.ts`:

```ts
export const platforms = ["gemini", "claude", "codex", "opencode"] as const;
```

Do not change `src/cli.ts` routing logic unless TypeScript requires a type-only adjustment. The existing semantic hook events remain:

```ts
export const hookEvents = ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool"] as const;
```

- [x] **Step 4: Add an allow-only OpenCode adapter stub**

Create `src/platforms/opencode/index.ts`:

```ts
import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import { appendPlatformLog } from "../../runtime/logging.js";
import {
  createInitialSessionState,
  loadSessionState,
  saveSessionState,
} from "../../runtime/session-state.js";

export class OpenCodeAdapter implements PlatformAdapter {
  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const projectDirectory = resolveOpenCodeProjectDirectory(invocation);
    const sessionId = resolveOpenCodeSessionId(invocation.rawPayload);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      ...(sessionId !== undefined ? { sessionId } : {}),
      projectDirectory,
    });
    const state =
      (await loadSessionState(projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;

    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      kind: "hook.event",
      payload: invocation.rawPayload,
      projectDirectory,
      sessionCreatedAt: state.createdAt,
      sessionKey: state.sessionKey,
    });
    await saveSessionState(projectDirectory, invocation.platform, state.sessionKey, state);

    return allowOutput();
  }

  async beforeAgent(): Promise<HookResult> {
    return allowOutput();
  }

  async afterAgent(): Promise<HookResult> {
    return allowOutput();
  }

  async afterTool(): Promise<HookResult> {
    return allowOutput();
  }
}

function allowOutput(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}

function resolveOpenCodeProjectDirectory(invocation: HookInvocation): string {
  const value = invocation.rawPayload.directory ?? invocation.rawPayload.cwd;
  return typeof value === "string" && value.trim() !== "" ? value : invocation.processCwd;
}

function resolveOpenCodeSessionId(payload: Record<string, unknown>): string | undefined {
  const input = firstRecord(payload.input);
  const event = firstRecord(payload.event);
  const properties = firstRecord(event?.properties);
  const info = firstRecord(properties?.info);
  return firstString(input?.sessionID, properties?.sessionID, info?.id);
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "");
}
```

- [x] **Step 5: Register the adapter**

Modify `src/platforms/index.ts`:

```ts
import { OpenCodeAdapter } from "./opencode/index.js";

const adapters: Record<Platform, PlatformAdapter> = {
  gemini: new GeminiAdapter(),
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  opencode: new OpenCodeAdapter(),
};
```

- [x] **Step 6: Update architecture tests**

In `test/architecture.test.js`, replace each hard-coded platform array with:

```js
const platforms = ["gemini", "claude", "codex", "opencode"];
```

Add `"src/platforms/opencode/index.ts"` to the `concreteAdapters` set in `importsConcreteAdapter`.

- [x] **Step 7: Verify green for routing**

Run:

```bash
npm run build && node --test test/architecture.test.js test/cli-session-start.test.js
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/interfaces.ts src/platforms/index.ts src/platforms/opencode/index.ts test/architecture.test.js test/cli-session-start.test.js
git commit -m "feat: route opencode hook events" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Add OpenCode Payload Parser

**Files:**

- Create: `src/platforms/opencode/payload.ts`
- Create: `test/opencode/opencode-payload.test.js`

- [x] **Step 1: Write parser tests**

Create `test/opencode/opencode-payload.test.js` with cases for the five supported OpenCode surfaces:

```js
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const payloadUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "opencode", "payload.js")).href;

test("extracts OpenCode session-created payload", async () => {
  const { parseOpenCodePayload } = await import(payloadUrl);
  const info = parseOpenCodePayload(
    {
      hook: "event",
      directory: "/project",
      event: {
        type: "session.created",
        properties: { info: { id: "session-1", directory: "/project-from-session" } },
      },
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    hookName: "event",
    eventType: "session.created",
    sessionId: "session-1",
    projectDirectory: "/project",
  });
});

test("extracts user text from chat.message text parts", async () => {
  const { parseOpenCodePayload } = await import(payloadUrl);
  const info = parseOpenCodePayload(
    {
      hook: "chat.message",
      directory: "/project",
      input: { sessionID: "session-1", messageID: "user-1" },
      output: {
        message: { id: "user-1", sessionID: "session-1", role: "user" },
        parts: [
          { type: "text", text: "Remember NAMS" },
          { type: "file", filename: "notes.md" },
          { type: "text", text: "Use fixture tests", ignored: true },
        ],
      },
    },
    "/fallback",
  );

  assert.equal(info.sessionId, "session-1");
  assert.equal(info.messageId, "user-1");
  assert.equal(info.userPrompt, "Remember NAMS");
});

test("extracts assistant text from experimental.text.complete", async () => {
  const { parseOpenCodePayload } = await import(payloadUrl);
  const info = parseOpenCodePayload(
    {
      hook: "experimental.text.complete",
      directory: "/project",
      input: { sessionID: "session-1", messageID: "assistant-1", partID: "part-1" },
      output: { text: "Done." },
    },
    "/fallback",
  );

  assert.equal(info.assistantText, "Done.");
  assert.equal(info.messageId, "assistant-1");
  assert.equal(info.partId, "part-1");
});

test("extracts tool metadata from tool.execute.after", async () => {
  const { parseOpenCodePayload } = await import(payloadUrl);
  const info = parseOpenCodePayload(
    {
      hook: "tool.execute.after",
      directory: "/project",
      input: {
        sessionID: "session-1",
        callID: "call-1",
        tool: "bash",
        args: { command: "npm test" },
      },
      output: {
        title: "npm test",
        output: "69 tests pass",
        metadata: { exit: 0 },
      },
    },
    "/fallback",
  );

  assert.equal(info.toolName, "bash");
  assert.equal(info.toolCallId, "call-1");
  assert.deepEqual(info.toolInput, { command: "npm test" });
  assert.equal(info.toolTitle, "npm test");
  assert.equal(info.toolOutput, "69 tests pass");
  assert.equal(info.toolStatus, "completed");
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm run build && node --test test/opencode/opencode-payload.test.js
```

Expected: FAIL because `payload.ts` does not exist.

- [x] **Step 3: Implement parser**

Create `src/platforms/opencode/payload.ts`:

```ts
export interface OpenCodePayloadInfo {
  hookName?: string;
  eventType?: string;
  sessionId?: string;
  messageId?: string;
  partId?: string;
  projectDirectory: string;
  userPrompt?: string;
  assistantText?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: unknown;
  toolTitle?: string;
  toolOutput?: string;
  toolStatus?: string;
}

export function parseOpenCodePayload(payload: Record<string, unknown>, processCwd: string): OpenCodePayloadInfo {
  const input = firstRecord(payload.input);
  const output = firstRecord(payload.output);
  const event = firstRecord(payload.event);
  const eventProperties = firstRecord(event?.properties);
  const eventInfo = firstRecord(eventProperties?.info);
  const message = firstRecord(output?.message);

  const sessionId = firstString(
    input?.sessionID,
    input?.sessionId,
    message?.sessionID,
    eventProperties?.sessionID,
    eventInfo?.id,
  );
  const messageId = firstString(input?.messageID, input?.messageId, message?.id);
  const partId = firstString(input?.partID, input?.partId);
  const hookName = firstString(payload.hook, payload.hookName);
  const toolName = firstString(input?.tool);

  return {
    ...(hookName !== undefined ? { hookName } : {}),
    ...optionalString("eventType", firstString(event?.type)),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(partId !== undefined ? { partId } : {}),
    projectDirectory:
      firstString(payload.directory, payload.cwd, eventInfo?.directory, payload.worktree) ?? processCwd,
    ...optionalString("userPrompt", extractTextParts(output?.parts)),
    ...optionalString("assistantText", firstString(output?.text)),
    ...optionalString("toolName", toolName),
    ...optionalString("toolCallId", toolName !== undefined ? firstString(input?.callID, input?.callId) : undefined),
    ...(toolName !== undefined && input !== undefined && "args" in input ? { toolInput: input.args } : {}),
    ...optionalString("toolTitle", toolName !== undefined ? firstString(output?.title) : undefined),
    ...optionalString("toolOutput", toolName !== undefined ? firstString(output?.output) : undefined),
    ...optionalString("toolStatus", toolName !== undefined ? firstString(output?.status) ?? "completed" : undefined),
  };
}

function extractTextParts(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((part) => {
      const record = firstRecord(part);
      if (record === undefined || record.type !== "text" || record.ignored === true) return [];
      return firstString(record.text) ?? [];
    })
    .join("\n")
    .trim();
  return text === "" ? undefined : text;
}

function optionalString<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value !== undefined ? ({ [key]: value } as { [P in K]: string }) : {};
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}
```

- [x] **Step 4: Verify parser tests**

Run:

```bash
npm run build && node --test test/opencode/opencode-payload.test.js
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/platforms/opencode/payload.ts test/opencode/opencode-payload.test.js
git commit -m "feat: parse opencode hook payloads" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Implement OpenCode SessionStart And Session Logs

**Files:**

- Modify: `src/platforms/opencode/index.ts`
- Modify: `test/opencode/opencode-memory-flow.test.js`

- [x] **Step 1: Add SessionStart flow test**

Create `test/opencode/opencode-memory-flow.test.js` with the same import pattern used by Gemini tests and add:

```js
test("initializes OpenCode session state on session.created without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const { OpenCodeAdapter } = await import(opencodeUrl);
    const { loadSessionState } = await import(stateUrl);
    const adapter = new OpenCodeAdapter();

    const result = await adapter.startConversation({
      platform: "opencode",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: {
        hook: "event",
        directory: projectDir,
        event: {
          type: "session.created",
          properties: { info: { id: "session-1", directory: projectDir } },
        },
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const state = await loadSessionState(projectDir, "opencode", "session-1");
    assert.notEqual(state, null);
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.conversationId, undefined);

    const { lines } = await readSingleSessionLog(projectDir);
    assert.equal(lines[0].kind, "hook.event");
    assert.equal(lines[0].harness, "opencode");
    assert.equal(lines[0].event, "SessionStart");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

Copy the `readSingleSessionLog` helper from the Gemini test file.

- [x] **Step 2: Verify red or update stub**

Run:

```bash
npm run build && node --test test/opencode/opencode-memory-flow.test.js
```

Expected: PASS if Task 1 stub already satisfies the test; otherwise FAIL on missing state/log detail.

- [x] **Step 3: Replace local parsing helpers with `parseOpenCodePayload`**

In `src/platforms/opencode/index.ts`, import:

```ts
import { parseOpenCodePayload } from "./payload.js";
```

Use it in `startConversation()` to resolve project directory and session id. Remove duplicate parser helpers that Task 2 made obsolete.

- [x] **Step 4: Verify**

Run:

```bash
npm run build && node --test test/opencode/opencode-memory-flow.test.js test/cli-session-start.test.js
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/platforms/opencode/index.ts test/opencode/opencode-memory-flow.test.js test/cli-session-start.test.js
git commit -m "feat: initialize opencode session state" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Implement User Message Flow And Context Injection

**Files:**

- Modify: `src/runtime/session-state.ts`
- Modify: `src/platforms/opencode/index.ts`
- Modify: `test/opencode/opencode-memory-flow.test.js`

- [x] **Step 1: Extend session state type**

Add optional fields to `SessionState`:

```ts
pendingMemoryContext?: {
  messageId?: string;
  content: string;
  createdAt: string;
};
seenUserMessageIds?: string[];
seenAssistantPartIds?: string[];
```

No migration code is required because these fields are optional.

- [x] **Step 2: Add failing test for `chat.message`**

Add a mocked NAMS flow test:

```js
test("OpenCode chat.message creates conversation, recalls memory, and stores user prompt", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User prefers fixture-driven tests." }] })
      .searchEntities({ entities: [{ name: "Fixtures", description: "User prefers fixture-driven tests." }] })
      .message();
    const { OpenCodeAdapter } = await import(opencodeUrl);
    const adapter = new OpenCodeAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" },
      fetch: nams.fetch,
    });

    const result = await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Remember fixture tests."),
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBody("createConversation"), {
      metadata: { harness: "opencode", projectDirectory: projectDir },
    });
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: "Remember fixture tests.",
    });

    const state = await loadSessionState(projectDir, "opencode", "session-1");
    assert.match(state.pendingMemoryContext.content, /User prefers fixture-driven tests\./);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

Add helper:

```js
function chatMessagePayload(projectDir, sessionID, messageID, text) {
  return {
    hook: "chat.message",
    directory: projectDir,
    input: { sessionID, messageID },
    output: {
      message: { id: messageID, sessionID, role: "user" },
      parts: [{ id: "part-1", sessionID, messageID, type: "text", text }],
    },
  };
}
```

- [x] **Step 3: Add failing test for context injection consumption**

```js
test("OpenCode system transform returns and consumes pending memory context", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User wants concise answers." }] })
      .searchEntities()
      .message();
    const { OpenCodeAdapter } = await import(opencodeUrl);
    const adapter = new OpenCodeAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" },
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Hello."),
    });

    const first = await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook: "experimental.chat.system.transform",
        directory: projectDir,
        input: { sessionID: "session-1" },
        output: { system: [] },
      },
    });
    assert.match(first.stdout.hookSpecificOutput.additionalContext, /User wants concise answers\./);

    const second = await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook: "experimental.chat.system.transform",
        directory: projectDir,
        input: { sessionID: "session-1" },
        output: { system: [] },
      },
    });
    assert.deepEqual(second.stdout, { continue: true, suppressOutput: true });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 4: Implement `beforeAgent` branching**

In `OpenCodeAdapter.beforeAgent()`:

```ts
const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
if (payloadInfo.hookName === "experimental.chat.system.transform") {
  return consumePendingContext(invocation, payloadInfo);
}
if (payloadInfo.hookName !== "chat.message") {
  return allowOutput();
}
```

Implement `chat.message` logic by following Gemini `beforeAgent`:

- append raw platform log
- create/load state
- initialize `seenUserMessageIds`
- skip if `userPrompt` is missing
- load config
- create conversation lazily
- recall only when `lastRecallAt` is missing
- store `pendingMemoryContext` when recall returns non-empty context
- dedupe by message id first, then by existing user hash logic
- store user message
- save state

Only mark a user message id or hash as seen after `storeUserMessage()` succeeds.

- [x] **Step 5: Implement `consumePendingContext`**

Return:

```ts
return {
  stdout: {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "BeforeAgent",
      additionalContext: state.pendingMemoryContext.content,
    },
  },
};
```

Clear `state.pendingMemoryContext` before saving state.

- [x] **Step 6: Add missing-config and NAMS-failure tests**

Port the Gemini tests for:

- missing `NAMS_API_KEY`
- NAMS request failure
- arbitrary exception text not appearing in diagnostics
- duplicate `chat.message` not storing the user prompt twice

Expected diagnostics must be fixed strings:

- `NAMS_API_KEY missing`
- `NAMS request failed`

- [x] **Step 7: Verify**

Run:

```bash
npm run build && node --test test/opencode/opencode-memory-flow.test.js
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/runtime/session-state.ts src/platforms/opencode/index.ts test/opencode/opencode-memory-flow.test.js
git commit -m "feat: add opencode user memory flow" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Persist OpenCode Assistant Text

**Files:**

- Modify: `src/platforms/opencode/index.ts`
- Modify: `test/opencode/opencode-memory-flow.test.js`

- [x] **Step 1: Add failing assistant text test**

```js
test("OpenCode experimental.text.complete stores assistant text", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { OpenCodeAdapter } = await import(opencodeUrl);
    const adapter = new OpenCodeAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" },
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Say hello."),
    });

    const result = await adapter.afterAgent({
      platform: "opencode",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook: "experimental.text.complete",
        directory: projectDir,
        input: { sessionID: "session-1", messageID: "assistant-1", partID: "part-1" },
        output: { text: "Hello!" },
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
```

- [x] **Step 2: Add replay dedupe test**

Call `afterAgent` twice with the same `messageID`, `partID`, and text. Assert only one assistant `addMessage` request is written.

- [x] **Step 3: Implement `afterAgent`**

Follow Gemini assistant persistence:

- parse payload
- append raw hook log
- create/load state
- initialize `seenAssistantPartIds`
- return allow output if there is no conversation id
- return allow output if `assistantText` is missing or blank
- load config
- dedupe by `messageId:partId` when both are present
- fallback to hash `[platform, sessionKey, "assistant", assistantText.trim()]`
- call `memory.storeAssistantMessage`
- mark part id/hash as seen only after successful write
- save state

- [x] **Step 4: Verify**

Run:

```bash
npm run build && node --test test/opencode/opencode-memory-flow.test.js
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/platforms/opencode/index.ts test/opencode/opencode-memory-flow.test.js
git commit -m "feat: store opencode assistant text" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 6: Persist OpenCode Tool Metadata

**Files:**

- Modify: `src/platforms/opencode/index.ts`
- Modify: `test/opencode/opencode-memory-flow.test.js`

- [x] **Step 1: Add failing tool metadata test**

```js
test("OpenCode tool.execute.after records sanitized tool metadata", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-1" })
      .toolCall();
    const { OpenCodeAdapter } = await import(opencodeUrl);
    const adapter = new OpenCodeAdapter({
      env: { NAMS_API_KEY: "key", NAMS_BASE_URL: "https://memory.example.test" },
      fetch: nams.fetch,
    });

    await adapter.beforeAgent({
      platform: "opencode",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: chatMessagePayload(projectDir, "session-1", "user-1", "Run tests."),
    });

    const result = await adapter.afterTool({
      platform: "opencode",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook: "tool.execute.after",
        directory: projectDir,
        input: {
          sessionID: "session-1",
          callID: "call-1",
          tool: "bash",
          args: {
            command: "npm test",
            output: "must be sanitized",
            keep: "metadata",
          },
        },
        output: { title: "npm test", output: "69 tests pass", metadata: { exit: 0 } },
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBody("addReasoningStep"), {
      conversationId: "conversation-1",
      reasoning: "OpenCode invoked bash with the provided tool input.",
      actionTaken: "Ran bash",
      result: "npm test",
    });

    const toolBody = nams.requestBody("addToolCall");
    assert.equal(toolBody.toolName, "bash");
    assert.equal(toolBody.stepId, "step-1");
    assert.equal(toolBody.status, "completed");
    assert.equal(toolBody.output, "69 tests pass");
    assert.match(toolBody.input, /"command":"npm test"/);
    assert.match(toolBody.input, /"keep":"metadata"/);
    assert.doesNotMatch(toolBody.input, /must be sanitized|"output"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Add tool replay dedupe test**

Call `afterTool` twice with the same `callID`. Assert one `addToolCall` request.

- [x] **Step 3: Implement `afterTool`**

Follow Gemini `afterTool` but use OpenCode-specific summary text:

```ts
const reasoningStep = {
  conversationId: state.conversationId,
  reasoning: `OpenCode invoked ${payloadInfo.toolName} with the provided tool input.`,
  actionTaken: `Ran ${payloadInfo.toolName}`,
  ...(payloadInfo.toolTitle !== undefined ? { result: payloadInfo.toolTitle } : {}),
};
```

Use dedupe keys:

- `opencode-call-id:<hash(sessionKey, toolCallId)>` when `toolCallId` exists.
- fallback hash of `sessionKey`, `toolName`, and `toolInput`.

Persist:

```ts
await memory.recordToolCall({
  ...(stepId !== undefined ? { stepId } : {}),
  toolName: payloadInfo.toolName,
  input: payloadInfo.toolInput,
  ...(payloadInfo.toolOutput !== undefined ? { output: payloadInfo.toolOutput } : {}),
  status: payloadInfo.toolStatus ?? "completed",
});
```

- [x] **Step 4: Verify**

Run:

```bash
npm run build && node --test test/opencode/opencode-memory-flow.test.js
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/platforms/opencode/index.ts test/opencode/opencode-memory-flow.test.js
git commit -m "feat: record opencode tool metadata" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 7: Add OpenCode Plugin Template

**Files:**

- Create: `templates/opencode/plugins/nams-hooks.js`
- Create: `test/opencode/opencode-template.test.js`

- [x] **Step 1: Add template tests**

Create `test/opencode/opencode-template.test.js`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const templatePath = path.join(repoRoot, "templates", "opencode", "plugins", "nams-hooks.js");

test("OpenCode plugin template registers NAMS hook surfaces", async () => {
  const source = await readFile(templatePath, "utf8");
  assert.match(source, /export const NamsHooks/);
  assert.match(source, /"chat.message"/);
  assert.match(source, /"experimental.chat.system.transform"/);
  assert.match(source, /"experimental.text.complete"/);
  assert.match(source, /"tool.execute.after"/);
  assert.match(source, /session\.created/);
  assert.match(source, /nams-hooks/);
});
```

- [x] **Step 2: Verify red**

Run:

```bash
node --test test/opencode/opencode-template.test.js
```

Expected: FAIL because the template does not exist.

- [x] **Step 3: Create template**

Create `templates/opencode/plugins/nams-hooks.js`:

```js
import { spawn } from "node:child_process";

const command = process.env.NAMS_HOOKS_COMMAND ?? "nams-hooks";

export const NamsHooks = async ({ client, directory, project, worktree }) => {
  async function run(event, payload) {
    try {
      return await invokeNams(event, {
        directory,
        project,
        worktree,
        ...payload,
      });
    } catch {
      await logDiagnostic(client, `NAMS OpenCode hook ${event} failed`);
      return undefined;
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "session.created") return;
      await run("SessionStart", { hook: "event", event });
    },

    "chat.message": async (input, output) => {
      await run("BeforeAgent", { hook: "chat.message", input, output });
    },

    "experimental.chat.system.transform": async (input, output) => {
      const result = await run("BeforeAgent", {
        hook: "experimental.chat.system.transform",
        input,
        output,
      });
      const context = result?.hookSpecificOutput?.additionalContext;
      if (typeof context === "string" && context.trim() !== "") {
        output.system.push(context);
      }
    },

    "experimental.text.complete": async (input, output) => {
      await run("AfterAgent", { hook: "experimental.text.complete", input, output });
    },

    "tool.execute.after": async (input, output) => {
      await run("AfterTool", { hook: "tool.execute.after", input, output });
    },
  };
};

export default NamsHooks;

async function invokeNams(event, payload) {
  const child = spawn(command, ["run", "opencode", "--event", event], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.end(`${JSON.stringify(payload)}\n`);

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (code !== 0) {
    throw new Error(stderr.trim() || `nams-hooks exited with ${code}`);
  }
  return stdout.trim() === "" ? undefined : JSON.parse(stdout);
}

async function logDiagnostic(client, message) {
  try {
    await client?.app?.log?.({
      body: {
        service: "nams-hooks",
        level: "warn",
        message,
      },
    });
  } catch {
    // Diagnostics must not block OpenCode.
  }
}
```

- [x] **Step 4: Verify template test**

Run:

```bash
node --test test/opencode/opencode-template.test.js
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add templates/opencode/plugins/nams-hooks.js test/opencode/opencode-template.test.js
git commit -m "feat: add opencode plugin template" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 8: Update Documentation And Run Full Verification

**Files:**

- Modify: `README.md`
- Modify: `INSTALL.md`

- [x] **Step 1: Update README platform support**

Add OpenCode to the platform support list and mention that OpenCode support uses a project-local plugin shim:

```md
- [OpenCode](https://opencode.ai/docs/) via a project-local `.opencode/plugins/` plugin shim
```

In Runtime Logs, mention that OpenCode and Gemini both use session-scoped JSONL logs.

- [x] **Step 2: Update INSTALL**

Add:

````md
## OpenCode

OpenCode loads project plugins from `.opencode/plugins/`.

```bash
npm install -g @neo4j-labs/nams-hooks
mkdir -p .opencode/plugins
cp templates/opencode/plugins/nams-hooks.js .opencode/plugins/nams-hooks.js
```

For local development from this repository:

```bash
npm install
npm run build
mkdir -p /path/to/project/.opencode/plugins
cp templates/opencode/plugins/nams-hooks.js /path/to/project/.opencode/plugins/nams-hooks.js
```

If `nams-hooks` is not on OpenCode's `PATH`, set `NAMS_HOOKS_COMMAND` to the executable path before starting OpenCode.
````

Keep the outer fence at four backticks so the nested shell snippets render correctly.

- [x] **Step 3: Run focused tests**

Run:

```bash
npm run build && node --test test/opencode/*.test.js test/cli-session-start.test.js test/architecture.test.js
```

Expected: PASS.

- [x] **Step 4: Run full check**

Run:

```bash
npm run check
```

Expected: PASS.

- [x] **Step 5: Run package check**

Run:

```bash
npm run package:check
```

Expected: PASS. This also verifies distribution output still keeps generated runtime code dependency-free.

- [x] **Step 6: Inspect git status**

Run:

```bash
git status --short
```

Expected: only intended source, template, test, and docs files are modified or added. No `.nams/`, `.build/`, `dist/`, or project-root test artifacts are tracked.

- [x] **Step 7: Commit**

```bash
git add README.md INSTALL.md
git commit -m "docs: add opencode setup notes" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

## Final Verification

After all tasks are complete, run:

```bash
npm run check
npm run package:check
```

Expected final state:

- OpenCode platform is registered.
- OpenCode adapter tests pass with mocked NAMS.
- OpenCode plugin template exists and routes the supported hooks.
- Gemini behavior remains unchanged.
- Architecture tests still enforce adapter boundaries.
- No runtime npm dependencies were added.
