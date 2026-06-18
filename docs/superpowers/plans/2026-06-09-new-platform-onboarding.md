# New Platform Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a repeatable, test-first path for adding a new agent harness platform to `nams-hooks`, using Antygravity as the worked example platform id `antygravity`.

**Architecture:** New platforms are additive adapters behind the existing CLI gateway. `src/cli.ts` continues to parse only the command, platform, typed `--event`, and opaque stdin JSON; all native hook parsing, stdout shaping, transcript handling, and platform-specific fallback behavior lives under `src/platforms/<platform>/`. Shared runtime modules continue to own config, local state, logging, workspace resolution, duplicate suppression, and NAMS REST calls through the generated client.

**Tech Stack:** TypeScript, Node.js built-ins only for runtime code, generated `NamsClient`, Node's built-in `node:test`, `fetch-mock` test support, ArchUnitTS architecture tests, split source templates under `templates/local/`, `templates/marketplace/`, and optional shared `templates/<platform>/`, split distribution projection scripts, and generated distribution checks through `npm run package:check`.

---

## How To Use This Plan

This is a generic onboarding guide. The examples use:

- Display name: `Antygravity`
- Platform id: `antygravity`
- Source folder: `src/platforms/antygravity/`
- Test folder: `test/antygravity/`
- Local template folder: `templates/local/antygravity/`
- Marketplace template folder: `templates/marketplace/antygravity/`
- Shared template folder, only when needed by both outputs: `templates/antygravity/`

When adding a different platform, choose one stable lowercase id and apply the same file pattern consistently. Do not add runtime dependencies, do not teach `src/cli.ts` native payload details, do not infer `invocation.event` from payload fields, and do not fetch OpenAPI or inspect schemas at hook runtime.

## Platform Intake Checklist

Complete this before touching TypeScript:

- Native hook event names and their lifecycle order.
- Stable session identity fields, plus fallback identity when the stable field is missing.
- Project directory field, plus fallback to the hook process cwd.
- Before-agent user prompt field and whether context can be injected safely.
- Assistant response source, either direct payload field or readable transcript.
- Tool completion source, tool name field, exposed input, exposed output, status, duration, and stable tool-call id.
- Native stdout contract for allow, block, additional context, and diagnostics.
- Install model: extension, plugin marketplace, project-local config, or global CLI command.
- Configuration model: native user config, environment variables, or only `.nams/config.json`.
- Unsupported lifecycle events and the intended degraded behavior.

Record the answers in the implementation PR and update a design doc when the answer changes architecture, distribution shape, or platform contract. If the platform does not expose one of the core events, leave the adapter method optional or no-op, add explicit tests for the degraded behavior, and document the gap.

## File Structure

Create for Antygravity:

- `src/platforms/antygravity/index.ts`: memory adapter orchestration for `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- `src/platforms/antygravity/payload.ts`: typed extraction from raw Antygravity hook payloads.
- `src/platforms/antygravity/workspaces.ts`: workspace preflight adapter and install-time workspace configuration.
- `src/platforms/antygravity/transcript.ts`: only if assistant or tool capture requires reading a platform transcript file.
- `test/antygravity/antygravity-payload.test.ts`: parser contract tests.
- `test/antygravity/antygravity-memory-flow.test.ts`: mocked NAMS memory-flow tests.
- `test/antygravity/antygravity-workspaces.test.ts`: workspace preflight tests when the platform supports a pre-memory hook.
- `test/antygravity-template.test.ts`: template shape, local command, marketplace command, and projection tests when source templates are added.
- `templates/local/antygravity/`: project-shaped local config or shim files that call an installed `nams-hooks` executable.
- `templates/marketplace/antygravity/`: self-contained marketplace or extension files that call bundled runtime files.
- `templates/antygravity/`: optional shared fragments only when both local and marketplace outputs use the same source.

Modify:

- `src/interfaces.ts`: add the new platform id to `platforms`.
- `src/platforms/index.ts`: statically register the memory and workspace adapters.
- `test/architecture.test.ts`: include the new platform in platform-boundary and concrete-adapter rules.
- `test/cli-session-start.test.ts`: add gateway routing coverage for the new platform and supported typed events.
- `scripts/build-dist-local.mjs`: project Antygravity local templates to `dist-local/antygravity/` when the platform has a project-local install path.
- `scripts/build-dist-marketplace.mjs`: project Antygravity marketplace templates and bundled runtime to `dist-marketplace/` when the platform has a self-contained marketplace or extension install path.
- `scripts/build-dist-common.mjs`: modify only when the existing projection kinds cannot express the Antygravity output.
- `scripts/check-dist.mjs`: verify generated Antygravity files only for the output trees that the build scripts emit.
- `README.md`, `INSTALL.md`, and `DEVELOPMENT.md`: document support level, install path, config requirements, and local validation commands.
- `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`: amend supported-platform notes when Antygravity becomes an official target.

## Event Mapping Contract

Every platform maps native hook events into these typed NAMS lifecycle events:

| NAMS event | Required platform capability | Runtime behavior |
| --- | --- | --- |
| `SessionStart` | Session initialization or resume hook | Initialize local state and raw session log only. Do not create a NAMS conversation. |
| `BeforeAgent` | User prompt or pre-agent hook | Resolve or create state, resolve workspace, recall memory, persist the user prompt, and inject context only through the platform's safe context surface. |
| `AfterAgent` | Assistant-complete or stop hook | Persist exposed assistant response best-effort, with duplicate suppression. Skip when the response is not cleanly exposed. |
| `AfterTool` | Tool completion hook | Persist tool name, sanitized input, optional step id, status, duration, and exposed output only when the platform provides it cleanly. |

Native hook names stay in templates and platform adapters. The CLI command always uses `--event <NAMS event>`, for example:

```bash
nams-hooks run antygravity --event BeforeAgent
```

---

### Task 1: Add The Platform Contract And Gateway Stub

**Files:**

- Modify: `src/interfaces.ts`
- Modify: `src/platforms/index.ts`
- Create: `src/platforms/antygravity/index.ts`
- Create: `src/platforms/antygravity/payload.ts`
- Create: `src/platforms/antygravity/workspaces.ts`
- Modify: `test/architecture.test.ts`
- Modify: `test/cli-session-start.test.ts`

- [ ] **Step 1: Add failing CLI routing coverage**

In `test/cli-session-start.test.ts`, extend the session-start harness list:

```ts
for (const harness of ["gemini", "claude", "codex", "opencode", "antygravity"] as const) {
```

Add typed event routing coverage for the Antygravity events that the platform intake proved are available:

```ts
for (const event of ["BeforeAgent", "AfterAgent", "AfterTool"]) {
  test(`routes antygravity ${event} hook event`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const result = await runCliWithEvent(
        "antygravity",
        event,
        {
          session_id: `antygravity-${event}`,
          cwd: projectDir,
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

- [ ] **Step 2: Verify the gateway test is red**

Run:

```bash
npm run build && node --import=tsx --test test/cli-session-start.test.ts
```

Expected: FAIL because `antygravity` is not yet accepted by `isPlatform()`.

- [ ] **Step 3: Add Antygravity to shared platform types**

Modify `src/interfaces.ts`:

```ts
export const platforms = ["gemini", "claude", "codex", "opencode", "antygravity"] as const;
export type Platform = (typeof platforms)[number];
```

Do not add native Antygravity hook event names to `hookEvents`. The shared event list remains semantic:

```ts
export const hookEvents = ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool"] as const;
```

- [ ] **Step 4: Create the payload parser skeleton**

Create `src/platforms/antygravity/payload.ts`:

```ts
export interface AntygravityPayloadInfo {
  sessionId?: string;
  projectDirectory: string;
  prompt?: string;
  assistantResponse?: string;
  transcriptPath?: string;
}

export function parseAntygravityPayload(
  payload: Record<string, unknown>,
  processCwd: string,
): AntygravityPayloadInfo {
  const sessionId = firstString(payload.session_id, payload.sessionId);
  const projectDirectory = firstString(payload.cwd, payload.projectDirectory, payload.workspace_dir) ?? processCwd;
  const prompt = firstString(payload.prompt, payload.user_prompt, payload.message);
  const assistantResponse = firstString(payload.response, payload.assistant_response);
  const transcriptPath = firstString(payload.transcript_path, payload.transcriptPath);

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    projectDirectory,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(assistantResponse !== undefined ? { assistantResponse } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "");
}
```

Replace the field names with the real Antygravity hook fields discovered during platform intake. Keep event-name fields out of this parser except as raw logged payload data.

- [ ] **Step 5: Create a log-only memory adapter stub**

Create `src/platforms/antygravity/index.ts`:

```ts
import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { appendRawPlatformLog } from "../../runtime/logging.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import { parseAntygravityPayload } from "./payload.js";

export class AntygravityAdapter implements MemoryPlatformAdapter {
  async startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    await logInvocation(invocation);
    return allowOutput();
  }

  async beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    await logInvocation(invocation);
    return allowOutput();
  }

  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    await logInvocation(invocation);
    return allowOutput();
  }

  async afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    await logInvocation(invocation);
    return allowOutput();
  }
}

async function logInvocation(invocation: HookInvocation): Promise<void> {
  const payloadInfo = parseAntygravityPayload(invocation.rawPayload, invocation.processCwd);
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    sessionId: payloadInfo.sessionId,
    projectDirectory: payloadInfo.projectDirectory,
  });
  const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ?? initialState;
  await appendRawPlatformLog(invocation, state);
  await saveSessionState(invocation.platform, state.sessionKey, state);
}

function allowOutput(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}
```

This stub proves the gateway, state, and logging contract before any NAMS writes are added.

- [ ] **Step 6: Create the workspace adapter skeleton**

Create `src/platforms/antygravity/workspaces.ts`:

```ts
import type { WorkspaceHookInvocation, WorkspaceHookResult, WorkspacePlatformAdapter } from "../../interfaces.js";
import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";

export class AntygravityWorkspaceAdapter implements WorkspacePlatformAdapter {
  async installConfigure(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<WorkspaceHookResult> {
    return configureWorkspaceSelection(invocation);
  }
}
```

Add `beforeAgent()` later only if the native Antygravity template can run workspace resolution before memory.

- [ ] **Step 7: Register the platform statically**

Modify `src/platforms/index.ts`:

```ts
import { AntygravityAdapter } from "./antygravity/index.js";
import { AntygravityWorkspaceAdapter } from "./antygravity/workspaces.js";
```

Add the platform to both records:

```ts
const memoryAdapters: Record<Platform, MemoryPlatformAdapter> = {
  gemini: new GeminiAdapter(),
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  opencode: new OpenCodeAdapter(),
  antygravity: new AntygravityAdapter(),
};

const workspaceAdapters: Record<Platform, WorkspacePlatformAdapter> = {
  gemini: new GeminiWorkspaceAdapter(),
  claude: new ClaudeWorkspaceAdapter(),
  codex: new CodexWorkspaceAdapter(),
  opencode: new OpenCodeWorkspaceAdapter(),
  antygravity: new AntygravityWorkspaceAdapter(),
};
```

- [ ] **Step 8: Update architecture tests**

In `test/architecture.test.ts`, include `antygravity` in every platform list and add its concrete adapter paths to `importsConcreteAdapter()`:

```ts
const concreteAdapters = new Set([
  "src/platforms/gemini/index.ts",
  "src/platforms/claude/index.ts",
  "src/platforms/codex/index.ts",
  "src/platforms/opencode/index.ts",
  "src/platforms/antygravity/index.ts",
  "src/platforms/gemini/workspaces.ts",
  "src/platforms/claude/workspaces.ts",
  "src/platforms/codex/workspaces.ts",
  "src/platforms/opencode/workspaces.ts",
  "src/platforms/antygravity/workspaces.ts",
]);
```

Expected boundaries:

- Antygravity adapter modules do not import other platform modules.
- Shared runtime modules do not import Antygravity modules.
- Only `src/platforms/index.ts` imports the concrete Antygravity adapters.

- [ ] **Step 9: Verify the stub is green**

Run:

```bash
npm run build && node --import=tsx --test test/architecture.test.ts test/cli-session-start.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/interfaces.ts src/platforms/index.ts src/platforms/antygravity test/architecture.test.ts test/cli-session-start.test.ts
git commit -m "feat: add antygravity platform gateway" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Lock Down Payload Parsing

**Files:**

- Modify: `src/platforms/antygravity/payload.ts`
- Create: `test/antygravity/antygravity-payload.test.ts`

- [ ] **Step 1: Write parser tests from real hook fixtures**

Create fixture-style tests that cover the real Antygravity payload shape:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAntygravityPayload } from "../../src/platforms/antygravity/payload.js";

test("extracts Antygravity session, project directory, and prompt", () => {
  const info = parseAntygravityPayload(
    {
      session_id: "antygravity-session-1",
      cwd: "/tmp/project",
      prompt: "Remember this preference.",
      event: "native-event-name-must-not-drive-routing",
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    sessionId: "antygravity-session-1",
    projectDirectory: "/tmp/project",
    prompt: "Remember this preference.",
  });
});

test("falls back to process cwd when Antygravity omits project directory", () => {
  const info = parseAntygravityPayload({ session_id: "session-1" }, "/fallback");

  assert.equal(info.projectDirectory, "/fallback");
});
```

Add separate tests for assistant response, transcript path, tool payload fields, blank strings, and any nested native structures.

- [ ] **Step 2: Verify parser tests are red or incomplete**

Run:

```bash
npm run build && node --import=tsx --test test/antygravity/antygravity-payload.test.ts
```

Expected: FAIL if the skeleton field names do not match the real fixtures.

- [ ] **Step 3: Implement the exact parser**

Update `parseAntygravityPayload()` to use the real field names and nested records. Keep return values typed and narrow. Do not parse or trust native event-name fields for routing.

- [ ] **Step 4: Verify parser behavior**

Run:

```bash
npm run build && node --import=tsx --test test/antygravity/antygravity-payload.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/platforms/antygravity/payload.ts test/antygravity/antygravity-payload.test.ts
git commit -m "test: cover antygravity payload parsing" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Implement Before-Agent Memory Flow

**Files:**

- Modify: `src/platforms/antygravity/index.ts`
- Create: `test/antygravity/antygravity-memory-flow.test.ts`

- [ ] **Step 1: Write the first-prompt memory-flow test**

Use `createNamsFetchMock()` and temp HOME fixtures like existing platform tests. Assert:

- `SessionStart` initializes state and does not create a conversation.
- First `BeforeAgent` with a prompt creates one NAMS conversation.
- Recall calls `getConversationContext` and `searchEntities`.
- User prompt is persisted through `addMessage`.
- Additional context is returned only in the Antygravity-native safe context location.
- Logs include raw hook event and sanitized `nams.request` entries.
- API keys are not present in logs.

Use this request body expectation:

```ts
assert.deepEqual(nams.requestBody("createConversation"), {
  metadata: {
    harness: "antygravity",
    projectDirectory: projectDir,
  },
});
```

- [ ] **Step 2: Verify the memory-flow test is red**

Run:

```bash
npm run build && node --import=tsx --test test/antygravity/antygravity-memory-flow.test.ts
```

Expected: FAIL because `beforeAgent()` is still log-only.

- [ ] **Step 3: Implement the minimal BeforeAgent flow**

In `src/platforms/antygravity/index.ts`, follow the existing platform pattern:

- Parse payload.
- Create or load session state with `createInitialSessionState()`.
- Append raw platform log before NAMS work.
- Return allow output when no prompt is exposed.
- Load config with `loadEffectiveNamsConfigForMemory()`.
- Create a NAMS conversation only when `state.conversationId` is missing.
- Recall once per session using `memory.recall()` and `memory.searchEntities()`.
- Combine recall output with `combineMemoryContexts()`.
- Persist the user prompt once using a SHA-256 duplicate key.
- Save state before every return.
- On any NAMS failure, append a diagnostic and allow the hook to continue.

The Antygravity-specific part is only the stdout context shape. Keep it in a small helper:

```ts
function allowOutput(additionalContext?: string): HookResult {
  return {
    stdout: {
      continue: true,
      suppressOutput: true,
      ...(additionalContext !== undefined
        ? {
            hookSpecificOutput: {
              additionalContext,
            },
          }
        : {}),
    },
  };
}
```

Replace `hookSpecificOutput.additionalContext` with the real Antygravity context surface if the platform uses a different contract.

- [ ] **Step 4: Add duplicate user-message coverage**

In `test/antygravity/antygravity-memory-flow.test.ts`, call `beforeAgent()` twice with the same prompt and assert `nams.calls("addMessage").length === 1`.

- [ ] **Step 5: Verify BeforeAgent behavior**

Run:

```bash
npm run build && node --import=tsx --test test/antygravity/antygravity-memory-flow.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/platforms/antygravity/index.ts test/antygravity/antygravity-memory-flow.test.ts
git commit -m "feat: add antygravity before-agent memory flow" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Add Workspace Resolution Support

**Files:**

- Modify: `src/platforms/antygravity/workspaces.ts`
- Modify: `src/platforms/antygravity/index.ts`
- Create: `test/antygravity/antygravity-workspaces.test.ts`
- Modify: Antygravity templates when they exist

- [ ] **Step 1: Decide whether Antygravity can run workspace preflight**

Use a workspace preflight only if Antygravity can run a command before the memory `BeforeAgent` hook and can use the result to continue safely. If it cannot, keep `workspaces.ts` install-configure-only and rely on `loadEffectiveNamsConfigForMemory()` during memory hooks.

- [ ] **Step 2: Write workspace preflight tests**

When preflight is supported, assert:

- Configured `workspaceId` returns allow output.
- Single workspace auto-selection stores `state.workspace`.
- Multiple workspaces return the platform-specific selection-required output without writing secrets.
- Project and user config files are not created in the repository root.

- [ ] **Step 3: Implement `beforeAgent()` in the workspace adapter**

Follow the existing pattern:

```ts
const result = await resolveWorkspaceForMemory({
  invocation,
  state,
  projectDirectory: payloadInfo.projectDirectory,
  interaction: "single-only",
});
await saveSessionState(invocation.platform, state.sessionKey, state);
return result.status === "ready" ? allowOutput() : result.output;
```

Use `interaction: "gemini-blocking"` only if Antygravity can safely block the prompt before memory starts.

- [ ] **Step 4: Verify workspace behavior**

Run:

```bash
npm run build && node --import=tsx --test test/antygravity/antygravity-workspaces.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/platforms/antygravity/workspaces.ts src/platforms/antygravity/index.ts test/antygravity/antygravity-workspaces.test.ts
git commit -m "feat: resolve antygravity workspaces before memory" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Persist Assistant Responses Best-Effort

**Files:**

- Modify: `src/platforms/antygravity/index.ts`
- Modify: `src/platforms/antygravity/payload.ts`
- Create or modify: `src/platforms/antygravity/transcript.ts`
- Modify: `test/antygravity/antygravity-memory-flow.test.ts`
- Create or modify: `test/antygravity/antygravity-transcript.test.ts`

- [ ] **Step 1: Write assistant persistence tests**

Cover the cleanest response source first:

- Direct response field if Antygravity exposes one in `AfterAgent`.
- Transcript-derived response only when the transcript is documented, readable, and contains completed assistant text.
- No write when the response is missing or blank.
- Duplicate response suppression across repeated `AfterAgent` events.
- No hidden reasoning or internal trace text is stored as assistant content.

- [ ] **Step 2: Verify assistant tests are red**

Run:

```bash
npm run build && node --import=tsx --test test/antygravity/antygravity-memory-flow.test.ts
```

Expected: FAIL until `afterAgent()` stores assistant messages.

- [ ] **Step 3: Implement assistant capture**

In `afterAgent()`:

- Load state and raw-log the payload.
- Return allow output when no conversation exists.
- Extract the response from the approved source.
- Load effective NAMS config.
- Hash `[platform, sessionKey, "assistant", response]`.
- Store through `memory.storeAssistantMessage()` only when not seen.
- Track `state.lastAssistantMessageHash` and `state.seenAssistantMessageHashes`.
- Save state before return.

- [ ] **Step 4: Verify assistant behavior**

Run:

```bash
npm run build && node --import=tsx --test test/antygravity/antygravity-memory-flow.test.ts test/antygravity/antygravity-transcript.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/platforms/antygravity test/antygravity
git commit -m "feat: persist antygravity assistant responses" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 6: Record Tool Metadata

**Files:**

- Modify: `src/platforms/antygravity/index.ts`
- Modify: `src/platforms/antygravity/payload.ts`
- Modify: `test/antygravity/antygravity-memory-flow.test.ts`

- [ ] **Step 1: Write tool metadata tests**

Assert:

- No NAMS write occurs when no conversation exists.
- No NAMS write occurs when tool name is missing.
- One tool completion creates a safe operational reasoning step when needed.
- `recordToolCall` receives tool name, sanitized input, exposed output only when safe, status, duration, and optional step id.
- Replayed tool events do not create duplicate tool calls.

- [ ] **Step 2: Verify tool tests are red**

Run:

```bash
npm run build && node --import=tsx --test test/antygravity/antygravity-memory-flow.test.ts
```

Expected: FAIL until `afterTool()` records tool metadata.

- [ ] **Step 3: Implement tool parsing and dedupe**

Use the real Antygravity tool-call id when available. If no stable id exists, derive a fallback hash from:

- session key
- tool name
- sanitized input
- native timestamp or turn index when available

Store an operational reasoning summary only, for example:

```ts
const reasoningStep = {
  conversationId: state.conversationId,
  reasoning: `Antygravity ran ${toolPayload.toolName} with the provided tool input.`,
  actionTaken: `Ran ${toolPayload.toolName}`,
  ...(toolPayload.outputSummary !== undefined ? { result: toolPayload.outputSummary } : {}),
};
```

Do not store hidden chain-of-thought. Do not scrape tool output from unsupported fields.

- [ ] **Step 4: Verify tool behavior**

Run:

```bash
npm run build && node --import=tsx --test test/antygravity/antygravity-memory-flow.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/platforms/antygravity test/antygravity/antygravity-memory-flow.test.ts
git commit -m "feat: record antygravity tool metadata" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 7: Add Templates And Distribution Projections

**Files:**

- Create: `templates/local/antygravity/` when Antygravity has project-local config.
- Create: `templates/marketplace/antygravity/` when Antygravity has a self-contained marketplace or extension artifact.
- Create: `templates/antygravity/` only for fragments shared by both local and marketplace templates.
- Create: `test/antygravity-template.test.ts`
- Modify: `scripts/build-dist-local.mjs` when local project config is generated.
- Modify: `scripts/build-dist-marketplace.mjs` when marketplace or extension output is generated.
- Modify: `scripts/build-dist-common.mjs` only when a new projection kind is required.
- Modify: `scripts/check-dist.mjs`

- [ ] **Step 1: Choose the installation model**

Use the least surprising native model:

- Extension artifact if Antygravity has extension roots like Gemini.
- Marketplace plugin if Antygravity supports self-contained plugin bundles like Claude or Codex.
- Project-local config or plugin shim if Antygravity requires local files like OpenCode.
- Global CLI fallback only when no self-contained platform install exists.

Keep the output tree responsibilities separate:

- `dist/` is the npm-installable package artifact only. It should contain the compiled runtime under `bin/` and `package.json`, not platform marketplace metadata, project-local config, source templates, or OpenAPI artifacts.
- `dist-marketplace/` is the self-contained marketplace or extension output. Hook commands in this tree must call bundled runtime files, such as `${PLUGIN_ROOT}/bin/cli.js`, `${CLAUDE_PLUGIN_ROOT}/bin/cli.js`, `${extensionPath}/plugins/antygravity-nams-hooks/bin/cli.js`, or the Antygravity-native equivalent.
- `dist-local/` is symlinkable or copyable project config. Hook commands in this tree intentionally call an installed `nams-hooks` executable and must not include compiled runtime files or marketplace roots.

Do not add templates until the native hook command shape and install model are known.

- [ ] **Step 2: Write template tests first**

Assert:

- Each native hook maps to the correct typed NAMS event.
- Marketplace hook commands call the bundled runtime path for self-contained installs.
- Marketplace templates never call a global `nams-hooks` executable when a bundled CLI path is available.
- Local project templates intentionally call the installed `nams-hooks` executable.
- Local generated files are symlinkable or copyable into a project root without depending on repository source paths.
- Workspace preflight or workspace command templates route through `workspaces run antygravity --event <workspace-event>` when the platform supports them.
- Templates do not contain API keys, secret placeholders, or hardcoded NAMS service URLs.

Example marketplace command expectation:

```ts
assert.equal(
  command,
  'node "${extensionPath}/plugins/antygravity-nams-hooks/bin/cli.js" run antygravity --event BeforeAgent',
);
```

Replace `${extensionPath}` with the Antygravity-native root variable.

Example local command expectation:

```ts
assert.equal(command, "nams-hooks run antygravity --event BeforeAgent");
```

- [ ] **Step 3: Create source templates**

Create only the native files Antygravity needs in the matching source tree:

- `templates/marketplace/antygravity/` for marketplace manifests, extension roots, plugin metadata, hooks, command files, or shims that use bundled runtime paths.
- `templates/local/antygravity/` for project-shaped fallback config or shims that use the installed executable.
- `templates/antygravity/` only for shared fragments that are rendered into both target trees by explicit projection entries.

Marketplace hook commands must pass the typed NAMS event explicitly:

```bash
node "<platform-plugin-root>/bin/cli.js" run antygravity --event SessionStart
node "<platform-plugin-root>/bin/cli.js" workspaces run antygravity --event <workspace-event>
node "<platform-plugin-root>/bin/cli.js" run antygravity --event BeforeAgent
node "<platform-plugin-root>/bin/cli.js" run antygravity --event AfterAgent
node "<platform-plugin-root>/bin/cli.js" run antygravity --event AfterTool
```

Local hook commands use the installed executable:

```bash
nams-hooks run antygravity --event SessionStart
nams-hooks workspaces run antygravity --event <workspace-event>
nams-hooks run antygravity --event BeforeAgent
nams-hooks run antygravity --event AfterAgent
nams-hooks run antygravity --event AfterTool
```

- [ ] **Step 4: Wire distribution generation**

Update only the projection script for the output tree Antygravity uses:

- Add local project config to `scripts/build-dist-local.mjs` with `to: "antygravity"` under `dist-local/antygravity/`. Local projections should render installed-command templates and should not copy `.build/tsc`.
- Add marketplace or extension output to `scripts/build-dist-marketplace.mjs`. Self-contained plugin installs should add template projections, a `packageJson` projection when a plugin package is needed, and a `runtime` projection that copies `.build/tsc` into `dist-marketplace/plugins/antygravity-nams-hooks/bin/` and marks `bin/cli.js` executable.
- Leave `scripts/build-dist-npm.mjs` alone unless the npm package runtime shape itself changes.
- Update `scripts/build-dist-common.mjs` only when Antygravity needs a reusable projection kind that existing `template`, `runtime`, `packageJson`, or platform shim projections cannot express.

- [ ] **Step 5: Add release checks**

Update `scripts/check-dist.mjs` to verify:

- Required Antygravity files exist in `dist-marketplace/` and/or `dist-local/`, depending on the chosen install model.
- `dist/` remains npm-only and does not include Antygravity marketplace metadata, project-local config, source templates, or OpenAPI artifacts.
- Marketplace plugin or extension metadata versions match `package.json`.
- Marketplace runtime CLI files are executable.
- Marketplace commands use bundled runtime paths and do not require global `nams-hooks`.
- Local commands intentionally use installed `nams-hooks`.
- `dist-local/` does not include compiled runtime files, marketplace roots, or bundled plugin directories.
- OpenAPI artifacts are absent.
- npm dry-run package output includes only the npm runtime package files and documentation, not generated marketplace or local project artifacts.

- [ ] **Step 6: Verify templates and package output**

Run:

```bash
npm run build && node --import=tsx --test test/antygravity-template.test.ts
npm run dist
npm run dist:check
```

Expected: PASS.

Commit:

Stage only the outputs that actually changed. For example:

```bash
git add templates/local/antygravity templates/marketplace/antygravity templates/antygravity test/antygravity-template.test.ts scripts/build-dist-local.mjs scripts/build-dist-marketplace.mjs scripts/build-dist-common.mjs scripts/check-dist.mjs
git commit -m "feat: package antygravity hook templates" -m "Co-authored-by: Codex <codex@openai.com>"
```

Omit template or script paths that do not exist or did not change.

---

### Task 8: Update Documentation And Design Records

**Files:**

- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `DEVELOPMENT.md`
- Modify: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- Create: `docs/superpowers/specs/2026-06-09-antygravity-platform-design.md` only when platform behavior needs a dedicated design record

- [ ] **Step 1: Document support level**

In README or INSTALL, state:

- Supported OS scope.
- Native install method.
- Required config values: `apiKey`, `workspaceId`, and `baseUrl` from `.nams/config.json` or `NAMS_*` environment variables.
- Supported lifecycle events.
- Best-effort assistant and tool capture limitations.

- [ ] **Step 2: Amend the source-of-truth design**

Update `docs/superpowers/specs/2026-05-10-nams-hooks-design.md` when Antygravity becomes officially supported. Add a platform note with:

- Native hook names and NAMS event mapping.
- Install or distribution path.
- Session identity strategy.
- Context injection strategy.
- Known unsupported hooks or best-effort capture areas.

- [ ] **Step 3: Add a dedicated platform design only for new decisions**

Create a new spec when Antygravity introduces a new distribution model, blocking behavior, workspace selection interaction, or payload source that does not fit existing adapter patterns. Keep routine adapter implementation details in this plan and tests.

- [ ] **Step 4: Verify docs mention only supported behavior**

Run:

```bash
rg -n "antygravity|Antygravity" README.md INSTALL.md DEVELOPMENT.md docs/superpowers/specs
```

Expected: Every mention describes implemented behavior or clearly labels deferred behavior.

Commit:

```bash
git add README.md INSTALL.md DEVELOPMENT.md docs/superpowers/specs
git commit -m "docs: document antygravity platform support" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 9: Run Full Verification

**Files:**

- No source files unless verification exposes a defect.

- [ ] **Step 1: Run targeted platform tests**

Run:

```bash
npm run build && node --import=tsx --test test/antygravity/*.test.ts test/antygravity-template.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository verification**

Run:

```bash
npm run check
```

Expected:

- OpenAPI generation is fresh.
- TypeScript build passes.
- Test typecheck passes.
- Full test suite passes.

- [ ] **Step 3: Run package verification when templates changed**

Run:

```bash
npm run package:check
```

Expected:

- Full checks pass.
- `dist/`, `dist-local/`, and `dist-marketplace/` are generated from source.
- Distribution checks pass.
- `dist/` remains npm-only.
- Marketplace artifacts, when added, live under `dist-marketplace/`.
- Project-local artifacts, when added, live under `dist-local/`.
- No OpenAPI files are packaged into runtime or generated distribution artifacts.
- No runtime dependencies are added.

- [ ] **Step 4: Inspect dependency policy**

Run:

```bash
node -e 'const p=require("./package.json"); if (p.dependencies && Object.keys(p.dependencies).length) process.exit(1)'
```

Expected: exit code `0`.

Commit only fixes that were required by verification.

---

### Task 10: Manual Harness Validation

**Files:**

- No source files unless manual validation exposes a defect.

- [ ] **Step 1: Build local distribution artifacts**

Run:

```bash
npm run dist
```

Expected:

- `dist/` contains only the npm package runtime.
- `dist-marketplace/` contains Antygravity marketplace or extension artifacts when Antygravity uses a self-contained install path.
- `dist-local/` contains Antygravity project-local config when Antygravity uses a local fallback path.

- [ ] **Step 2: Link or install into a throwaway project**

Use the Antygravity-native local install command for the chosen output tree:

- For marketplace or extension validation, install or link the generated artifact from `dist-marketplace/`.
- For project-local validation, install the npm artifact with `npm install -g ./dist`, then symlink or copy the project-shaped config from `dist-local/antygravity/` into the throwaway project.

Keep all test config under the throwaway project or temp HOME. Do not write `.nams/` artifacts into the repository root.

- [ ] **Step 3: Validate session start**

Start or resume Antygravity and confirm:

- A session-scoped log appears under `~/.nams/logs/antygravity/`.
- State appears under `~/.nams/state/antygravity/`.
- No NAMS conversation is created on `SessionStart`.

- [ ] **Step 4: Validate first user prompt**

Send one prompt and confirm:

- One NAMS conversation is created.
- User prompt is stored once.
- Recall requests are logged.
- Context is injected only through the platform's safe context channel.
- The agent can continue if NAMS is unavailable.

- [ ] **Step 5: Validate assistant and tool capture**

Run one assistant response and one tool call. Confirm:

- Assistant text is stored only when exposed cleanly.
- Tool metadata includes tool name and sanitized input.
- Exposed tool output is stored only when the harness provides it cleanly.
- Replaying the same native event does not duplicate NAMS writes.

- [ ] **Step 6: Capture validation notes**

Add manual validation notes to the PR description or a design amendment. Include native Antygravity version, OS, install method, supported event list, and known gaps.

---

## Final Acceptance Checklist

- `src/cli.ts` remains a platform-agnostic gateway.
- `invocation.event` is still the only event source of truth.
- Antygravity-specific parsing is confined to `src/platforms/antygravity/`.
- The platform registry stays static.
- Runtime code uses Node built-ins only and no new `dependencies`.
- Runtime code, templates, generators, and generated artifacts do not hardcode NAMS service URLs.
- Hook runtime never fetches or reads OpenAPI artifacts.
- Tests use temp directories and mocks, not repository `.nams/` state.
- Raw hook payload logs preserve the platform payload for debugging.
- NAMS request logs and diagnostics never expose API keys.
- `npm run check` passes before claiming implementation complete.
- `npm run package:check` passes when distribution files or templates changed.
