# Inline Workspace Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-resolve a single available NAMS workspace inline for all memory adapters when config has no `workspaceId`, while preserving Gemini/OpenCode ordered workspace behavior for multi-workspace flows.

**Architecture:** Extend the shared effective memory config helper so config wins, session state is reused, and `/v1/users/me/workspaces` is called only when neither config nor state has a workspace. Claude and Codex memory adapters switch to this helper, so they can auto-select one workspace before conversation creation without adding sibling first-prompt hooks. Diagnostics record whether the workspace came from config, session state, or runtime single-workspace auto-selection.

**Tech Stack:** TypeScript, Node built-ins, generated NAMS clients, Node `node:test`, existing `fetch-mock` test helper.

---

## Source Documents

- Design: `docs/superpowers/specs/2026-06-09-inline-workspace-resolution-design.md`
- Existing workspace design: `docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md`
- Key-scope design: `docs/superpowers/specs/2026-06-08-nams-key-scope-workspace-resolution-design.md`
- Architecture rules: `AGENTS.md`

## File Structure

- `src/runtime/workspace-resolution.ts`: add inline listing fallback to `loadEffectiveNamsConfigForMemory`, preserve config-first and state-second ordering, and log fixed workspace diagnostics.
- `src/runtime/logging.ts`: add `loadedFromSessionState` to `workspaceDiagnosticMessages`.
- `src/platforms/claude/index.ts`: use `loadEffectiveNamsConfigForMemory` with Claude config discovery for `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- `src/platforms/codex/index.ts`: use `loadEffectiveNamsConfigForMemory` for `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- `test/workspace-resolution.test.ts`: cover config, session, single, zero, and multiple cardinality behavior through the shared helper.
- `test/claude/claude-memory-flow.test.ts`: cover Claude single-workspace auto-resolution and multi-workspace skip behavior.
- `test/codex/codex-memory-flow.test.ts`: cover Codex single-workspace auto-resolution and multi-workspace skip behavior.
- `templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json`: mark workspace ID optional for runtime auto-resolution.
- `test/claude-template.test.js`: update Claude plugin config expectation.
- `README.md`, `INSTALL.md`, and workspace specs: document that all memory adapters can single-workspace auto-resolve when config is missing `workspaceId`.

---

### Task 1: Extend Shared Effective Workspace Resolution

**Files:**
- Modify: `src/runtime/workspace-resolution.ts`
- Modify: `src/runtime/logging.ts`
- Modify: `test/workspace-resolution.test.ts`

- [x] **Step 1: Add failing shared-helper tests**

In `test/workspace-resolution.test.ts`, import `loadEffectiveNamsConfigForMemory`:

```ts
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
  workspaceSelectionRequiredOutput,
} from "../src/runtime/workspace-resolution.js";
```

Add this test after `single listed workspace auto-selects by cardinality`:

```ts
test("effective memory config auto-selects single listed workspace when config and state are missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    const nams = createNamsFetchMock().workspaces({
      workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
    });
    useEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const state = createInitialSessionState({
      platform: "claude",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });

    const config = await loadEffectiveNamsConfigForMemory(invocation(projectDir, "claude"), state, projectDir);

    assert.deepEqual(config, {
      apiKey: "key",
      workspaceId: "workspace-1",
      baseUrl: "https://memory.example.test",
    });
    assert.deepEqual(state.workspace, {
      id: "workspace-1",
      source: "runtime-single-workspace",
      selectedAt: state.workspace?.selectedAt,
    });
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

Add this test after it:

```ts
test("effective memory config reuses session workspace without listing workspaces", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    const nams = createNamsFetchMock().all({ error: "unexpected workspace listing" }, 500);
    useEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const state = createInitialSessionState({
      platform: "claude",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });
    state.workspace = {
      id: "session-workspace",
      source: "runtime-single-workspace",
      selectedAt: "2026-06-09T11:00:00.000Z",
    };

    const config = await loadEffectiveNamsConfigForMemory(invocation(projectDir, "claude"), state, projectDir);

    assert.deepEqual(config, {
      apiKey: "key",
      workspaceId: "session-workspace",
      baseUrl: "https://memory.example.test",
    });
    assert.equal(nams.calls("listMyWorkspaces").length, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

Add this test after it:

```ts
test("effective memory config skips memory when multiple workspaces require selection", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    const nams = createNamsFetchMock().workspaces({
      workspaces: [
        { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
        { id: "workspace-2", name: "Research", role: "member", status: "active" },
      ],
    });
    useEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const state = createInitialSessionState({
      platform: "claude",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });

    const config = await loadEffectiveNamsConfigForMemory(invocation(projectDir, "claude"), state, projectDir);

    assert.equal(config, undefined);
    assert.equal(state.workspace, undefined);
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

Update the local invocation helper to accept a platform:

```ts
function invocation(projectDir: string, platform: HookInvocation<"BeforeAgent">["platform"] = "gemini"): HookInvocation<"BeforeAgent"> {
  return {
    platform,
    event: "BeforeAgent",
    processCwd: projectDir,
    rawPayload: {
      session_id: "session-1",
      cwd: projectDir,
      prompt: "hello",
    },
  };
}
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
node --import=tsx --test test/workspace-resolution.test.ts
```

Expected: new effective-helper tests fail because `loadEffectiveNamsConfigForMemory` logs `NAMS workspaceId missing` and does not list workspaces.

- [x] **Step 3: Implement shared helper fallback**

In `src/runtime/logging.ts`, add:

```ts
loadedFromSessionState: "NAMS workspace loaded from session state",
```

to `workspaceDiagnosticMessages`.

In `src/runtime/workspace-resolution.ts`, change `loadEffectiveNamsConfigForMemory` to accept optional config discovery:

```ts
import type { NamsConfigDiscovery } from "./config.js";

export async function loadEffectiveNamsConfigForMemory(
  invocation: HookInvocation,
  state: SessionState,
  projectDirectory: string,
  discoverConfig?: NamsConfigDiscovery,
): Promise<NamsRuntimeConfig | undefined> {
  const result = await resolveWorkspaceForMemory({
    invocation,
    state,
    projectDirectory,
    interaction: "single-only",
    discoverConfig,
  });
  return result.status === "ready" ? result.config : undefined;
}
```

Extend `ResolveWorkspaceInput`:

```ts
discoverConfig?: NamsConfigDiscovery;
```

Pass discovery into config loading:

```ts
const connectionResult = await loadNamsConnectionConfig(input.projectDirectory, input.discoverConfig);
```

Add a diagnostic when using session state:

```ts
if (input.state.workspace !== undefined) {
  await appendWorkspaceDiagnostic(input.invocation, input.state, {
    message: workspaceDiagnosticMessages.loadedFromSessionState,
    workspace: { id: input.state.workspace.id, source: input.state.workspace.source },
  });
  return {
    status: "ready",
    config: runtimeConfig(config.apiKey, input.state.workspace.id, config.baseUrl),
  };
}
```

- [x] **Step 4: Verify and commit**

Run:

```bash
node --import=tsx --test test/workspace-resolution.test.ts
npm run build
```

Expected: workspace-resolution tests and build pass.

Commit:

```bash
git add src/runtime/workspace-resolution.ts src/runtime/logging.ts test/workspace-resolution.test.ts
git commit -m "feat: auto-resolve effective workspace for memory" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Enable Claude Inline Workspace Resolution

**Files:**
- Modify: `src/platforms/claude/index.ts`
- Modify: `test/claude/claude-memory-flow.test.ts`

- [x] **Step 1: Add failing Claude tests**

In `test/claude/claude-memory-flow.test.ts`, add after `creates Claude conversation, recalls memory, injects additionalContext, and stores UserPromptSubmit prompt`:

```ts
test("Claude BeforeAgent auto-selects a single listed workspace when config workspaceId is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const prompt = "Resolve my workspace before memory.";
    const nams = createNamsFetchMock()
      .workspaces({
        workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
      })
      .createConversation()
      .context()
      .searchEntities()
      .message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 1);
    const createHeaders = nams.calls("createConversation")[0].options.headers as Record<string, string>;
    assert.equal(createHeaders["x-workspace-id"], "workspace-1");
    const state = (await loadSessionState("claude", "session-1"))!;
    assert.equal(state.workspace?.id, "workspace-1");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

Add after it:

```ts
test("Claude BeforeAgent skips memory when multiple listed workspaces require selection", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock()
      .workspaces({
        workspaces: [
          { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
          { id: "workspace-2", name: "Research", role: "member", status: "active" },
        ],
      })
      .all({ error: "unexpected memory call" }, 500);
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "This should not create memory yet.",
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 0);
    const state = (await loadSessionState("claude", "session-1"))!;
    assert.equal(state.workspace, undefined);
    assert.equal(state.conversationId, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
node --import=tsx --test test/claude/claude-memory-flow.test.ts
```

Expected: new single-workspace test fails because Claude still uses `loadNamsConfig`.

- [x] **Step 3: Switch Claude adapter to effective helper**

In `src/platforms/claude/index.ts`, replace:

```ts
import { loadNamsConfig } from "../../runtime/config.js";
```

with:

```ts
import { loadEffectiveNamsConfigForMemory } from "../../runtime/workspace-resolution.js";
```

Remove `appendNamsConfigDiagnostic` from the logging import.

Replace every config block shaped like:

```ts
const configResult = await loadNamsConfig(payloadInfo.projectDirectory, discoverClaudeNamsConfig);
await appendNamsConfigDiagnostic(invocation, state, configResult);
if (!configResult.ok) {
  await saveSessionState(invocation.platform, state.sessionKey, state);
  return allowOutput();
}
const config = configResult.config;
```

with:

```ts
const config = await loadEffectiveNamsConfigForMemory(
  invocation,
  state,
  payloadInfo.projectDirectory,
  discoverClaudeNamsConfig,
);
if (config === undefined) {
  await saveSessionState(invocation.platform, state.sessionKey, state);
  return allowOutput();
}
```

For `afterAgent` and `afterTool`, use the same helper and pass `config` into
`createNamsMemoryService(config, invocation, state)`.

- [x] **Step 4: Verify and commit**

Run:

```bash
node --import=tsx --test test/claude/claude-memory-flow.test.ts
npm run build
```

Expected: Claude tests and build pass.

Commit:

```bash
git add src/platforms/claude/index.ts test/claude/claude-memory-flow.test.ts
git commit -m "feat: auto-resolve Claude workspace inline" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Enable Codex Inline Workspace Resolution

**Files:**
- Modify: `src/platforms/codex/index.ts`
- Modify: `test/codex/codex-memory-flow.test.ts`

- [x] **Step 1: Add failing Codex tests**

In `test/codex/codex-memory-flow.test.ts`, add after `creates Codex conversation, recalls memory, returns context, and stores UserPromptSubmit prompt`:

```ts
test("Codex beforeAgent auto-selects a single listed workspace when config workspaceId is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const prompt = "Resolve my workspace before memory.";
    const nams = createNamsFetchMock()
      .workspaces({
        workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
      })
      .createConversation()
      .context()
      .searchEntities()
      .message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new CodexAdapter();

    const result = await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 1);
    const createHeaders = nams.calls("createConversation")[0].options.headers as Record<string, string>;
    assert.equal(createHeaders["x-workspace-id"], "workspace-1");
    const state = (await loadSessionState("codex", "session-1"))!;
    assert.equal(state.workspace?.id, "workspace-1");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

Add after it:

```ts
test("Codex beforeAgent skips memory when multiple listed workspaces require selection", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock()
      .workspaces({
        workspaces: [
          { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
          { id: "workspace-2", name: "Research", role: "member", status: "active" },
        ],
      })
      .all({ error: "unexpected memory call" }, 500);
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new CodexAdapter();

    const result = await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "This should not create memory yet.",
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 0);
    const state = (await loadSessionState("codex", "session-1"))!;
    assert.equal(state.workspace, undefined);
    assert.equal(state.conversationId, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
node --import=tsx --test test/codex/codex-memory-flow.test.ts
```

Expected: new single-workspace test fails because Codex still uses `loadNamsConfig`.

- [x] **Step 3: Switch Codex adapter to effective helper**

In `src/platforms/codex/index.ts`, replace:

```ts
import { loadNamsConfig } from "../../runtime/config.js";
```

with:

```ts
import { loadEffectiveNamsConfigForMemory } from "../../runtime/workspace-resolution.js";
```

Remove `appendNamsConfigDiagnostic` from the logging import.

Replace every `loadNamsConfig` block with:

```ts
const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
if (config === undefined) {
  await saveSessionState(invocation.platform, state.sessionKey, state);
  return allowOutput();
}
```

Use `config` for `createNamsMemoryService(config, invocation, state)`.

- [x] **Step 4: Verify and commit**

Run:

```bash
node --import=tsx --test test/codex/codex-memory-flow.test.ts
npm run build
```

Expected: Codex tests and build pass.

Commit:

```bash
git add src/platforms/codex/index.ts test/codex/codex-memory-flow.test.ts
git commit -m "feat: auto-resolve Codex workspace inline" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Update Docs And Claude Template Expectations

**Files:**
- Modify: `templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json`
- Modify: `test/claude-template.test.js`
- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md`

- [x] **Step 1: Add failing Claude template test**

In `test/claude-template.test.js`, update the `NAMS_WORKSPACE_ID` expectation:

```js
assert.deepEqual(template.userConfig.NAMS_WORKSPACE_ID, {
  type: "string",
  title: "NAMS workspace ID",
  description: "Optional workspace ID for Neo4j Agent Memory Service. If omitted, nams-hooks auto-selects a single available workspace before memory starts.",
});
assert.equal(Object.hasOwn(template.userConfig.NAMS_WORKSPACE_ID, "required"), false);
```

- [x] **Step 2: Run test to verify failure**

Run:

```bash
node --test test/claude-template.test.js
```

Expected: fail because the template still marks `NAMS_WORKSPACE_ID.required` as `true`.

- [x] **Step 3: Update Claude plugin config template**

In `templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json`, change:

```json
"description": "Neo4j Agent Memory Service workspace ID.",
"required": true
```

to:

```json
"description": "Optional workspace ID for Neo4j Agent Memory Service. If omitted, nams-hooks auto-selects a single available workspace before memory starts."
```

Keep `NAMS_BASE_URL.default` as `https://memory.neo4jlabs.com`; that default belongs to configuration, not generated runtime source.

- [x] **Step 4: Update docs**

In `README.md` and `INSTALL.md`, update workspace-selection language so it says:

```md
When `workspaceId` is omitted, nams-hooks calls `GET /v1/users/me/workspaces` before memory creation. If exactly one valid workspace is returned, that workspace is stored in session state and reused by later memory hooks. If multiple valid workspaces are returned, memory stays inactive for that turn until the user selects a workspace explicitly. The quickest fix is `nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>`.
```

In `docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md`, add an amendment note after the platform matrix:

```md
> 2026-06-09 amendment: Claude and Codex still must not use sibling first-prompt workspace hooks, but their memory adapters can now perform inline single-workspace auto-resolution before creating a conversation. This preserves deterministic side effects while supporting workspace keys that return exactly one workspace.
```

- [x] **Step 5: Verify and commit**

Run:

```bash
node --test test/claude-template.test.js
rg -n "auto-selects a single available workspace|multiple valid workspaces|2026-06-09 amendment" README.md INSTALL.md docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md
npm run build
```

Expected: template test and build pass; docs contain the amendment language.

Commit:

```bash
git add templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json test/claude-template.test.js README.md INSTALL.md docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md
git commit -m "docs: clarify inline workspace auto-resolution" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Final Verification

**Files:**
- Verify only unless checks reveal a missed source or doc update.

- [x] **Step 1: Run full verification**

Run:

```bash
npm run check
npm run dist
npm run dist:check
git diff --check
```

Expected: all commands exit `0`.

- [x] **Step 2: Inspect runtime URL and key-type constraints**

Run:

```bash
rg -n "https://memory\\.neo4jlabs\\.com" src scripts/generate-nams-client.mjs templates/claude/plugins/nams-hooks/hooks templates/codex templates/gemini README.md INSTALL.md
rg -n "keyType|workspaceKey|adminKey|admin-key|workspace-key" src scripts/generate-nams-client.mjs
```

Expected:

- No production URL hardcode in source, generator, generated runtime, or hook command templates.
- Claude config template may still contain the production URL as a user configuration default.
- No runtime key-type branching exists.

- [x] **Step 3: Commit verification fixes if needed**

If verification required changes:

```bash
git add <changed-files>
git commit -m "fix: finalize inline workspace resolution" -m "Co-authored-by: Codex <codex@openai.com>"
```

If no files changed, skip this commit.
