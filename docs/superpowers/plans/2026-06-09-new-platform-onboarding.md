# New Platform Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a repeatable, test-first path for adding a new agent harness platform to `nams-hooks`, using Antigravity as the worked example platform id `antigravity`.

**Architecture:** New platforms are additive adapters behind the existing CLI gateway. `src/cli.ts` continues to parse only the command, platform, typed `--event`, and opaque stdin JSON; all native hook parsing, stdout shaping, transcript handling, and platform-specific fallback behavior lives under `src/platforms/<platform>/`. Shared runtime modules continue to own config, local state, logging, workspace resolution, duplicate suppression, and NAMS REST calls through the generated client.

**Tech Stack:** TypeScript, Node.js built-ins only for runtime code, generated `NamsClient` and `NamsWorkspaceClient`, Node's built-in `node:test`, `fetch-mock` test support, ArchUnitTS architecture tests, split source templates under `templates/local/`, `templates/marketplace/`, and optional shared `templates/<platform>/`, split distribution projection scripts, generated distribution checks through `npm run package:check`, and optional Maven/Testcontainers live validation under `live-tests/`.

---

## How To Use This Plan

This is a generic onboarding guide. The examples use:

- Display name: `Antigravity`
- Platform id: `antigravity`
- Source folder: `src/platforms/antigravity/`
- Test folder: `test/antigravity/`
- Local template folder: `templates/local/antigravity/`
- Marketplace template folder: `templates/marketplace/antigravity/`
- Shared template folder, only when needed by both outputs: `templates/antigravity/`

When adding a different platform, choose one stable lowercase id and apply the same file pattern consistently. Do not add runtime dependencies, do not teach `src/cli.ts` native payload details, do not infer `invocation.event` from payload fields, and do not fetch OpenAPI or inspect schemas at hook runtime.

## Freshness Review

Reviewed against repository changes from 2026-06-08 through 2026-06-22.

- Memory adapters now export singleton objects such as `geminiMemoryAdapter`, not adapter classes. Follow that pattern for new platforms.
- Workspace selection is resolved inside memory `beforeAgent()` with `resolveWorkspaceForMemory()`. Workspace adapters now mainly provide install-time configuration and native slash or custom-command handling through `makeWorkspaceAdapter()`.
- `WorkspaceHookEvent` includes `BeforeAgent`, `InstallConfigure`, `UserPromptExpansion`, `CommandExecuteBefore`, and `CustomCommand`. Pick the native command hook that matches the platform instead of inventing a new workspace event.
- Distribution is split into `dist/`, `dist-local/`, and `dist-marketplace/`. Keep npm runtime output, project-local templates, and bundled marketplace or extension artifacts separate.
- The `live-tests/` Maven project validates generated artifacts against real platform CLIs. It currently covers Codex and is optional for new platforms until a platform-specific live scenario is designed.
- Runtime configuration currently comes from user JSON config, project JSON config, optional platform-discovered config, and `NAMS_*` environment variables. Do not add `.env` parsing as part of platform onboarding unless a separate config design updates the runtime contract.

Reviewed against official Antigravity docs on 2026-06-22.

- Antigravity 2.0 and Antigravity IDE document command hooks in `hooks.json` with native events `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop`.
- Antigravity hook input uses camelCase common fields: `conversationId`, `workspacePaths`, `transcriptPath`, and `artifactDirectoryPath`.
- Antigravity does not document a native session-start hook. For this worked example, `SessionStart` remains an internal NAMS route for adapter completeness, but generated Antigravity templates must not emit it until a native startup/resume hook exists.
- Antigravity `PreInvocation` can inject context through `injectSteps`, including `ephemeralMessage`. Use that as the safe memory context channel.
- Antigravity `PostToolUse` exposes `stepIdx` and optional `error`, but not the completed tool name, arguments, output, or duration directly. Treat `transcriptPath` as the primary source for tool details and no-op when the transcript does not expose them cleanly.
- Antigravity plugins bundle `plugin.json`, optional `hooks.json`, optional `mcp_config.json`, `skills/`, and `rules/`. Antigravity CLI plugins may also include `agents/` subagent templates and can be managed with `agy plugin install|list|enable|disable|uninstall`.
- Official source references:
  - `https://antigravity.google/assets/docs/antigravity-2-0/hooks.md`
  - `https://antigravity.google/assets/docs/antigravity-2-0/plugins.md`
  - `https://antigravity.google/assets/docs/cli/cli-plugins.md`

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
- Configuration model: native platform config, user `~/.nams/config.json`, project `.nams/config.json`, and environment variable support.
- Unsupported lifecycle events and the intended degraded behavior.

Record the answers in the implementation PR and update a design doc when the answer changes architecture, distribution shape, or platform contract. If the platform does not expose one of the core events, leave the adapter method optional or no-op, add explicit tests for the degraded behavior, and document the gap.

For the Antigravity worked example, use these platform-intake answers unless manual validation proves a newer local version differs:

- Native hook event names and lifecycle order: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop`.
- Stable session identity: `conversationId`; fallback to a hash of `transcriptPath` and workspace roots when `conversationId` is absent.
- Project directory source: first entry in `workspacePaths`; fallback to `processCwd`.
- Prompt, assistant response, and completed tool details: read from `transcriptPath` only when the transcript format is documented by local fixtures and exposes user/assistant/tool text safely.
- Before-agent injection channel: `PreInvocation` stdout `injectSteps: [{ "ephemeralMessage": "<memory context>" }]`.
- `PostToolUse` direct payload: `stepIdx`, optional `error`, and common fields. Use it for step correlation and raw logging, not as a complete tool record by itself.
- Native stdout contracts:
  - `PreInvocation` returns `{}` or `{ "injectSteps": [...] }`.
  - `PostInvocation` returns `{}` or `{ "injectSteps": [...], "terminationBehavior": "" }`.
  - `PostToolUse` returns `{}`.
  - `Stop` returns `{ "decision": "" }` to allow normal stop, or `{ "decision": "continue", "reason": "..." }` only when intentionally forcing another loop.
  - `PreToolUse` returns `{ "decision": "allow" }`, `{ "decision": "deny" }`, `{ "decision": "ask" }`, or `{ "decision": "force_ask" }`; do not use this for v1 memory capture unless a separate pre-tool cache design is added.
- Install model: prefer a plugin bundle containing `plugin.json` and `hooks.json`. For workspace-local install use `.agents/plugins/nams-hooks/`. Manual validation with `agy` 1.0.8 showed `agy plugin install dist-marketplace/antigravity/plugins/nams-hooks` installs the plugin under `$HOME/.gemini/config/plugins/nams-hooks/`.
- Unsupported lifecycle events: native session start/resume is not documented. Initialize state lazily on the first hook and keep `SessionStart` out of generated templates.

## File Structure

Create for Antigravity:

- `src/platforms/antigravity/index.ts`: memory adapter orchestration for `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- `src/platforms/antigravity/payload.ts`: typed extraction from raw Antigravity hook payloads.
- `src/platforms/antigravity/workspaces.ts`: install-time workspace configuration and optional native workspace command handling.
- `src/platforms/antigravity/transcript.ts`: transcript reader for user prompt, assistant response, and tool capture. Antigravity exposes `transcriptPath` in hook metadata, so this file is expected for meaningful memory capture.
- `test/antigravity/antigravity-payload.test.ts`: parser contract tests.
- `test/antigravity/antigravity-memory-flow.test.ts`: mocked NAMS memory-flow tests.
- `test/antigravity/antigravity-workspaces.test.ts`: workspace selection and native workspace command tests when the platform supports them.
- `test/antigravity-template.test.ts`: template shape, local command, marketplace command, and projection tests when source templates are added.
- `templates/local/antigravity/`: project-shaped local config or shim files that call an installed `nams-hooks` executable.
- `templates/marketplace/antigravity/`: self-contained Antigravity plugin files that call bundled runtime files.
- `templates/antigravity/`: optional shared fragments only when both local and marketplace outputs use the same source.

Modify:

- `src/interfaces.ts`: add the new platform id to `platforms`.
- `src/cli.ts`: update hardcoded usage text so help output names the new platform.
- `src/platforms/index.ts`: statically register the memory and workspace adapters.
- `test/architecture.test.ts`: include the new platform in platform-boundary and concrete-adapter rules.
- `test/cli-session-start.test.ts`: add gateway routing coverage for the new platform and supported typed events.
- `scripts/build-dist-local.mjs`: project Antigravity local templates to `dist-local/antigravity/` when the platform has a project-local install path.
- `scripts/build-dist-marketplace.mjs`: project Antigravity plugin templates and bundled runtime to `dist-marketplace/` when the platform has a self-contained plugin install path.
- `scripts/build-dist-common.mjs`: modify only when the existing projection kinds cannot express the Antigravity output.
- `scripts/check-dist.mjs`: verify generated Antigravity files only for the output trees that the build scripts emit.
- `README.md`, `INSTALL.md`, and `DEVELOPMENT.md`: document support level, install path, config requirements, and local validation commands.
- `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`: amend supported-platform notes when Antigravity becomes an official target.
- `live-tests/`: add a platform live scenario only if the platform can be validated safely in the live-test project and the change explicitly includes live validation.

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
nams-hooks run antigravity --event BeforeAgent
```

For Antigravity, use this concrete native mapping:

| Antigravity native event | NAMS event | Notes |
| --- | --- | --- |
| `PreInvocation` | `BeforeAgent` | Parse the latest user message from `transcriptPath`, persist it, recall memory, and inject memory with `injectSteps[].ephemeralMessage`. |
| `PostInvocation` | `AfterAgent` | Preferred assistant checkpoint. Parse completed assistant text from `transcriptPath` when available. |
| `PostToolUse` | `AfterTool` | Use `stepIdx` and `transcriptPath` to find completed tool details. No-op when only `error` is exposed and no tool name can be recovered safely. |
| `Stop` | `AfterAgent` only if manual validation proves `PostInvocation` misses final assistant text | Do not route both `PostInvocation` and `Stop` by default unless duplicate suppression is proven with fixtures. |
| `PreToolUse` | None in v1 | Available for permission gating, but not needed for deterministic memory writes unless a future pre-tool cache design is added. |
| none documented | `SessionStart` | Keep adapter method for interface completeness. Do not include in Antigravity templates until a native startup/resume event exists. |

---

### Task 1: Add The Platform Contract And Gateway Stub

**Files:**

- Modify: `src/interfaces.ts`
- Modify: `src/cli.ts`
- Modify: `src/platforms/index.ts`
- Create: `src/platforms/antigravity/index.ts`
- Create: `src/platforms/antigravity/payload.ts`
- Create: `src/platforms/antigravity/workspaces.ts`
- Modify: `test/architecture.test.ts`
- Modify: `test/cli-session-start.test.ts`

- [ ] **Step 1: Add failing CLI routing coverage**

In `test/cli-session-start.test.ts`, extend the session-start harness list. This covers the required adapter method and manual route, even though generated Antigravity templates will not emit `SessionStart` until a native startup hook exists:

```ts
for (const harness of ["gemini", "claude", "codex", "opencode", "antigravity"] as const) {
```

Add typed event routing coverage for the Antigravity events that the platform intake proved are available. Use Antigravity common metadata field names in the payload fixture:

```ts
for (const event of ["BeforeAgent", "AfterAgent", "AfterTool"] as const) {
  test(`routes antigravity ${event} hook event`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const result = await runCliWithEvent(
        "antigravity",
        event,
        {
          conversationId: `antigravity-${event}`,
          workspacePaths: [projectDir],
          transcriptPath: path.join(projectDir, "transcript.jsonl"),
          artifactDirectoryPath: projectDir,
        },
        projectDir,
      );

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {});
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

Expected: FAIL because `antigravity` is not yet accepted by `isPlatform()`.

- [ ] **Step 3: Add Antigravity to shared platform types**

Modify `src/interfaces.ts`:

```ts
export const platforms = ["gemini", "claude", "codex", "opencode", "antigravity"] as const;
export type Platform = (typeof platforms)[number];
```

Do not add native Antigravity hook event names to `hookEvents`. The shared event list remains semantic:

```ts
export const hookEvents = ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool"] as const;
```

- [ ] **Step 4: Create the payload parser skeleton**

Create `src/platforms/antigravity/payload.ts`:

```ts
import { pickStringFields } from "../payload.js";

export interface AntigravityPayloadInfo {
  sessionId?: string;
  projectDirectory: string;
  workspacePaths: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  invocationNum?: number;
  initialNumSteps?: number;
  stepIdx?: number;
  error?: string;
  executionNum?: number;
  terminationReason?: string;
  fullyIdle?: boolean;
}

export function parseAntigravityPayload(
  payload: Record<string, unknown>,
  processCwd: string,
): AntigravityPayloadInfo {
  const strings = pickStringFields(payload, {
    sessionId: "conversationId",
    transcriptPath: "transcriptPath",
    artifactDirectoryPath: "artifactDirectoryPath",
    error: "error",
    terminationReason: "terminationReason",
  });
  const workspacePaths = stringArrayValue(payload.workspacePaths);
  const projectDirectory = workspacePaths[0] ?? processCwd;
  const invocationNum = numberValue(payload.invocationNum);
  const initialNumSteps = numberValue(payload.initialNumSteps);
  const stepIdx = numberValue(payload.stepIdx);
  const executionNum = numberValue(payload.executionNum);
  const fullyIdle = typeof payload.fullyIdle === "boolean" ? payload.fullyIdle : undefined;

  return {
    ...strings,
    projectDirectory,
    workspacePaths,
    ...(invocationNum !== undefined ? { invocationNum } : {}),
    ...(initialNumSteps !== undefined ? { initialNumSteps } : {}),
    ...(stepIdx !== undefined ? { stepIdx } : {}),
    ...(executionNum !== undefined ? { executionNum } : {}),
    ...(fullyIdle !== undefined ? { fullyIdle } : {}),
  };
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function numberValue(value: unknown): number | undefined {
  return Number.isInteger(value) ? value : undefined;
}
```

Keep native event-name fields out of this parser except as raw logged payload data. Do not add prompt, assistant response, or complete tool fields here until transcript fixtures prove the exact source and shape.

- [ ] **Step 5: Create a log-only memory adapter stub**

Create `src/platforms/antigravity/index.ts`:

```ts
import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { appendRawPlatformLog } from "../../runtime/logging.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import { parseAntigravityPayload } from "./payload.js";

async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
  await logInvocation(invocation);
  return allowOutput();
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
  await logInvocation(invocation);
  return allowOutput();
}

async function afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
  await logInvocation(invocation);
  return allowOutput();
}

async function afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
  await logInvocation(invocation);
  return allowOutput();
}

export const antigravityMemoryAdapter: Required<MemoryPlatformAdapter> = {
  startSession,
  beforeAgent,
  afterAgent,
  afterTool,
};

async function logInvocation(invocation: HookInvocation): Promise<void> {
  const payloadInfo = parseAntigravityPayload(invocation.rawPayload, invocation.processCwd);
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
  return { stdout: {} };
}
```

This stub proves the gateway, state, and logging contract before any NAMS writes are added. Antigravity stdout is event-specific; the no-op output for `PreInvocation`, `PostInvocation`, and `PostToolUse` is `{}`.

- [ ] **Step 6: Create the workspace adapter skeleton**

Create `src/platforms/antigravity/workspaces.ts`:

```ts
import type { WorkspacePlatformAdapter } from "../../interfaces.js";
import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";

export const antigravityWorkspaceAdapter: WorkspacePlatformAdapter = {
  installConfigure: configureWorkspaceSelection,
};
```

Replace this with a `makeWorkspaceAdapter()` implementation later if Antigravity supports a native `nams:workspace` command surface. The current official docs expose skills as slash commands but do not document arbitrary custom command files equivalent to Claude or Codex.

- [ ] **Step 7: Register the platform statically**

Modify `src/platforms/index.ts`:

```ts
import { antigravityMemoryAdapter } from "./antigravity/index.js";
import { antigravityWorkspaceAdapter } from "./antigravity/workspaces.js";
```

Add the platform to both records:

```ts
const memoryAdapters: Record<Platform, MemoryPlatformAdapter> = {
  gemini: geminiMemoryAdapter,
  claude: claudeMemoryAdapter,
  codex: codexMemoryAdapter,
  opencode: opencodeMemoryAdapter,
  antigravity: antigravityMemoryAdapter,
};

const workspaceAdapters: Record<Platform, WorkspacePlatformAdapter> = {
  gemini: geminiWorkspaceAdapter,
  claude: claudeWorkspaceAdapter,
  codex: codexWorkspaceAdapter,
  opencode: opencodeWorkspaceAdapter,
  antigravity: antigravityWorkspaceAdapter,
};
```

Update the hardcoded usage strings in `src/cli.ts` so all three usage lines include `antigravity` in the platform list.

- [ ] **Step 8: Update architecture tests**

In `test/architecture.test.ts`, include `antigravity` in every platform list and add its concrete adapter paths to `importsConcreteAdapter()`:

```ts
const concreteAdapters = new Set([
  "src/platforms/gemini/index.ts",
  "src/platforms/claude/index.ts",
  "src/platforms/codex/index.ts",
  "src/platforms/opencode/index.ts",
  "src/platforms/antigravity/index.ts",
  "src/platforms/gemini/workspaces.ts",
  "src/platforms/claude/workspaces.ts",
  "src/platforms/codex/workspaces.ts",
  "src/platforms/opencode/workspaces.ts",
  "src/platforms/antigravity/workspaces.ts",
]);
```

Expected boundaries:

- Antigravity adapter modules do not import other platform modules.
- Shared runtime modules do not import Antigravity modules.
- Only `src/platforms/index.ts` imports the concrete Antigravity adapters.

- [ ] **Step 9: Verify the stub is green**

Run:

```bash
npm run build && node --import=tsx --test test/architecture.test.ts test/cli-session-start.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/interfaces.ts src/platforms/index.ts src/platforms/antigravity test/architecture.test.ts test/cli-session-start.test.ts
git commit -m "feat: add antigravity platform gateway" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Lock Down Payload Parsing

**Files:**

- Modify: `src/platforms/antigravity/payload.ts`
- Create: `test/antigravity/antigravity-payload.test.ts`

- [ ] **Step 1: Write parser tests from real hook fixtures**

Create fixture-style tests that cover the documented Antigravity common payload shape:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAntigravityPayload } from "../../src/platforms/antigravity/payload.js";

test("extracts Antigravity common metadata", () => {
  const info = parseAntigravityPayload(
    {
      conversationId: "antigravity-session-1",
      workspacePaths: ["/tmp/project", "/tmp/other"],
      transcriptPath: "/tmp/project/transcript.jsonl",
      artifactDirectoryPath: "/tmp/project/artifacts",
      invocationNum: 3,
      initialNumSteps: 10,
      event: "native-event-name-must-not-drive-routing",
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    sessionId: "antigravity-session-1",
    projectDirectory: "/tmp/project",
    workspacePaths: ["/tmp/project", "/tmp/other"],
    transcriptPath: "/tmp/project/transcript.jsonl",
    artifactDirectoryPath: "/tmp/project/artifacts",
    invocationNum: 3,
    initialNumSteps: 10,
  });
});

test("falls back to process cwd when Antigravity omits project directory", () => {
  const info = parseAntigravityPayload({ conversationId: "session-1" }, "/fallback");

  assert.equal(info.projectDirectory, "/fallback");
  assert.deepEqual(info.workspacePaths, []);
});

test("extracts Antigravity PostToolUse status metadata without inventing tool details", () => {
  const info = parseAntigravityPayload(
    {
      conversationId: "antigravity-session-1",
      workspacePaths: ["/tmp/project"],
      transcriptPath: "/tmp/project/transcript.jsonl",
      stepIdx: 5,
      error: "exit status 1",
      toolCall: { name: "run_command" },
    },
    "/fallback",
  );

  assert.deepEqual(info, {
    sessionId: "antigravity-session-1",
    projectDirectory: "/tmp/project",
    workspacePaths: ["/tmp/project"],
    transcriptPath: "/tmp/project/transcript.jsonl",
    stepIdx: 5,
    error: "exit status 1",
  });
});
```

Add separate tests for `PostInvocation` fields, `Stop` fields if supported later, invalid `workspacePaths`, blank strings, and numeric fields that are present but not integers.

- [ ] **Step 2: Verify parser tests are red or incomplete**

Run:

```bash
npm run build && node --import=tsx --test test/antigravity/antigravity-payload.test.ts
```

Expected: FAIL if the parser still uses snake_case placeholder fields or accepts undocumented tool details.

- [ ] **Step 3: Implement the exact parser**

Update `parseAntigravityPayload()` to use the documented camelCase fields. Keep return values typed and narrow. Do not parse or trust native event-name fields for routing. Do not extract prompt, assistant response, tool input, or tool output from raw hook payloads; those belong in transcript parsing once fixtures prove the transcript shape.

- [ ] **Step 4: Verify parser behavior**

Run:

```bash
npm run build && node --import=tsx --test test/antigravity/antigravity-payload.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/platforms/antigravity/payload.ts test/antigravity/antigravity-payload.test.ts
git commit -m "test: cover antigravity payload parsing" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Implement Before-Agent Memory Flow

**Files:**

- Modify: `src/platforms/antigravity/index.ts`
- Create: `test/antigravity/antigravity-memory-flow.test.ts`
- Create: `test/antigravity/fixtures/transcript-before-agent.jsonl`
- Create or modify: `src/platforms/antigravity/transcript.ts`

- [ ] **Step 1: Write the first-prompt memory-flow test**

Use `createNamsFetchMock()`, temp HOME fixtures, and a temp Antigravity transcript file. Seed the transcript fixture with one completed user message in the documented local transcript shape discovered during manual intake. Assert:

- Synthetic `SessionStart`, when called by tests or future templates, initializes state and does not create a conversation.
- First `BeforeAgent` with a transcript-derived user prompt creates one NAMS conversation.
- Recall calls `getConversationContext` and `searchEntities`.
- User prompt is persisted through `addMessage`.
- Additional context is returned only as Antigravity `PreInvocation` `injectSteps`, using an `ephemeralMessage`.
- Logs include raw hook event and sanitized `nams.request` entries.
- API keys are not present in logs.

Use this request body expectation:

```ts
assert.deepEqual(nams.requestBody("createConversation"), {
  metadata: {
    harness: "antigravity",
    projectDirectory: projectDir,
  },
});
```

- [ ] **Step 2: Verify the memory-flow test is red**

Run:

```bash
npm run build && node --import=tsx --test test/antigravity/antigravity-memory-flow.test.ts
```

Expected: FAIL because `beforeAgent()` is still log-only.

- [ ] **Step 3: Implement the minimal BeforeAgent flow**

In `src/platforms/antigravity/index.ts`, follow the existing platform pattern:

- Parse payload.
- Create or load session state with `createInitialSessionState()`.
- Append raw platform log before NAMS work.
- Return `{ stdout: {} }` when no transcript path or no user prompt is exposed cleanly.
- Resolve config and workspace with `resolveWorkspaceForMemory()`.
- If workspace resolution returns `selection-required`, save state and return a platform-specific selection notice in the same safe context surface used for recalled memory.
- If workspace resolution returns `unavailable`, save state and allow the hook to continue without memory.
- Create a NAMS conversation only when `state.conversationId` is missing.
- Recall once per session using `memory.recall()` and `memory.searchEntities()`.
- Combine recall output with `combineMemoryContexts()`.
- Persist the user prompt once using a SHA-256 duplicate key.
- Save state before every return.
- On any NAMS failure, append a diagnostic and allow the hook to continue.

The Antigravity-specific part is the `PreInvocation` stdout context shape. Keep it in a small helper:

```ts
function allowOutput(additionalContext?: string): HookResult {
  return {
    stdout:
      additionalContext !== undefined
        ? {
            injectSteps: [{ ephemeralMessage: additionalContext }],
          }
        : {},
  };
}
```

Do not use `hookSpecificOutput.additionalContext` for Antigravity; that is a Gemini/Claude/Codex-style convention, not the documented Antigravity `PreInvocation` contract.

- [ ] **Step 4: Add duplicate user-message coverage**

In `test/antigravity/antigravity-memory-flow.test.ts`, call `beforeAgent()` twice with the same transcript-derived user message and assert `nams.calls("addMessage").length === 1`.

- [ ] **Step 5: Verify BeforeAgent behavior**

Run:

```bash
npm run build && node --import=tsx --test test/antigravity/antigravity-memory-flow.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/platforms/antigravity/index.ts test/antigravity/antigravity-memory-flow.test.ts
git commit -m "feat: add antigravity before-agent memory flow" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Add Workspace Selection And Command Support

**Files:**

- Modify: `src/platforms/antigravity/workspaces.ts`
- Modify: `src/platforms/antigravity/index.ts`
- Create: `test/antigravity/antigravity-workspaces.test.ts`
- Modify: `test/cli-workspaces.test.ts`
- Modify: Antigravity templates when they exist

- [ ] **Step 1: Choose the native workspace command hook**

Workspace readiness for memory is already handled inside `beforeAgent()` through `resolveWorkspaceForMemory()`. Use `workspaces.ts` for:

- `InstallConfigure`, which is supplied by `configureWorkspaceSelection()`.
- The user-facing workspace command, only when Antigravity exposes a deterministic command or prompt-expansion surface that can invoke `nams-hooks workspaces run ...` directly.

Choose the matching `WorkspaceHookEvent`:

- `UserPromptExpansion` when the platform has a Claude-like prompt expansion hook.
- `CommandExecuteBefore` when the platform can intercept a command before normal execution.
- `CustomCommand` when the platform has a native custom command file or command extension.

Keep `WorkspacePlatformAdapter.beforeAgent` unused unless Antigravity has a documented pre-memory workspace hook that does not overlap with memory `BeforeAgent`. The current Antigravity docs mention skills becoming slash commands, but they do not document a safe arbitrary command file equivalent to Claude/Codex custom commands. Do not implement `CustomCommand` for Antigravity until a local version proves that deterministic command surface.

- [ ] **Step 2: Write workspace selection tests**

In `test/antigravity/antigravity-memory-flow.test.ts`, assert:

- Configured `workspaceId` returns allow output.
- Single workspace auto-selection stores `state.workspace`.
- Multiple workspaces return the platform-specific selection-required memory notice without writing secrets.
- Multiple workspaces do not create a conversation or store messages until a workspace is selected.

If Antigravity supports an active-session workspace command, also add `test/antigravity/antigravity-workspaces.test.ts` or extend `test/cli-workspaces.test.ts` to assert:

- The command routes through `nams-hooks workspaces run antigravity --event <workspace-event>`.
- `runActiveSessionWorkspaceUseCommand()` stores a session-selected workspace.
- Missing active session fails closed with the platform-specific usage text.
- Project and user config files are not created in the repository root.

- [ ] **Step 3: Record active session markers when selection is required**

If the workspace command needs to find the active session later, call `recordActiveWorkspaceSession()` from the memory adapter when workspace selection is required and when the platform receives an explicit workspace-command prompt. Follow the Codex and Gemini pattern:

```ts
await recordActiveWorkspaceSession({
  platform: invocation.platform,
  sessionId: payloadInfo.sessionId,
  sessionKey: state.sessionKey,
  projectDirectory: payloadInfo.projectDirectory,
  statePath: sessionStatePath(invocation.platform, state.sessionKey, state.createdAt),
});
```

Wrap this marker write in `try/catch` so memory hooks never fail because the command marker could not be written.

- [ ] **Step 4: Implement the workspace command adapter only when supported**

Current official Antigravity docs do not document a deterministic custom-command hook equivalent to Claude/Codex custom commands. For the first Antigravity implementation, keep `antigravityWorkspaceAdapter` as install-configure only and do not add `CustomCommand`, `UserPromptExpansion`, or `CommandExecuteBefore` handling.

If manual validation later proves a deterministic workspace command surface exists, add a short design amendment before implementing it. That amendment must record the native payload fields, stdout contract, and generated template command shape before code is added.

- [ ] **Step 5: Verify workspace behavior**

Run:

```bash
npm run build && node --import=tsx --test test/antigravity/antigravity-memory-flow.test.ts test/antigravity/antigravity-workspaces.test.ts test/cli-workspaces.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/platforms/antigravity/workspaces.ts src/platforms/antigravity/index.ts test/antigravity/antigravity-memory-flow.test.ts test/antigravity/antigravity-workspaces.test.ts test/cli-workspaces.test.ts
git commit -m "feat: support antigravity workspace selection" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Persist Assistant Responses Best-Effort

**Files:**

- Modify: `src/platforms/antigravity/index.ts`
- Modify: `src/platforms/antigravity/payload.ts`
- Create or modify: `src/platforms/antigravity/transcript.ts`
- Modify: `test/antigravity/antigravity-memory-flow.test.ts`
- Create or modify: `test/antigravity/antigravity-transcript.test.ts`

- [ ] **Step 1: Write assistant persistence tests**

Cover the cleanest response source first:

- Transcript-derived response from the `PostInvocation` hook, only when the transcript is readable and contains completed assistant text.
- Direct response field only if a later local Antigravity version exposes one in the documented `PostInvocation` payload.
- No write when the response is missing or blank.
- Duplicate response suppression across repeated `AfterAgent` events.
- No hidden reasoning or internal trace text is stored as assistant content.
- No write for `Stop` unless a separate test fixture proves `PostInvocation` misses final assistant text and the adapter can return the required Stop stdout contract.

- [ ] **Step 2: Verify assistant tests are red**

Run:

```bash
npm run build && node --import=tsx --test test/antigravity/antigravity-memory-flow.test.ts
```

Expected: FAIL until `afterAgent()` stores assistant messages.

- [ ] **Step 3: Implement assistant capture**

In `afterAgent()`:

- Load state and raw-log the payload.
- Return allow output when no conversation exists.
- Extract the response from the approved source.
- Load effective NAMS config.
- Hash `[platform, sessionKey, "assistant", response]`.
- Store through `memory.storeAssistantMessage()` only when `hasSeenAssistantMessage()` returns false.
- Mark all equivalent response hashes with `markAssistantMessageSeen()`, including transcript-entry hashes when transcript fallback is used.
- Track `state.seenTranscriptEntryIds` for transcript-derived messages so replayed transcript reads do not duplicate writes.
- Save state before return.
- Return `{ stdout: {} }` for the `PostInvocation` mapping. Do not route native `Stop` to this method unless the implementation also returns Stop-compatible stdout, such as `{ decision: "" }`.

- [ ] **Step 4: Verify assistant behavior**

Run:

```bash
npm run build && node --import=tsx --test test/antigravity/antigravity-memory-flow.test.ts test/antigravity/antigravity-transcript.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/platforms/antigravity test/antigravity
git commit -m "feat: persist antigravity assistant responses" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 6: Record Tool Metadata

**Files:**

- Modify: `src/platforms/antigravity/index.ts`
- Modify: `src/platforms/antigravity/payload.ts`
- Modify: `test/antigravity/antigravity-memory-flow.test.ts`

- [ ] **Step 1: Write tool metadata tests**

Assert:

- No NAMS write occurs when no conversation exists.
- No NAMS write occurs when tool name is missing.
- One tool completion creates a safe operational reasoning step when needed.
- `recordToolCall` receives tool name, sanitized input, exposed output only when safe, status, duration, and optional step id.
- Replayed tool events do not create duplicate tool calls.
- `PostToolUse` with only `stepIdx` and `error` logs raw payload and returns `{}` but does not invent tool metadata.

- [ ] **Step 2: Verify tool tests are red**

Run:

```bash
npm run build && node --import=tsx --test test/antigravity/antigravity-memory-flow.test.ts
```

Expected: FAIL until `afterTool()` records tool metadata.

- [ ] **Step 3: Implement tool parsing and dedupe**

Use the real Antigravity transcript tool-call id when available. If no stable id exists, derive a fallback hash from:

- session key
- tool name
- sanitized input
- native transcript entry id, timestamp, or `stepIdx` when available

Store an operational reasoning summary only, for example:

```ts
const reasoningStep = {
  conversationId: state.conversationId,
  reasoning: `Antigravity ran ${toolPayload.toolName} with the provided tool input.`,
  actionTaken: `Ran ${toolPayload.toolName}`,
  ...(toolPayload.outputSummary !== undefined ? { result: toolPayload.outputSummary } : {}),
};
```

Do not store hidden chain-of-thought. Do not scrape tool output from unsupported fields.

The documented `PostToolUse` stdin payload does not include tool name, arguments, or output by itself. Prefer a transcript parser keyed by `stepIdx`; if the transcript cannot recover a clean completed tool call, skip the NAMS tool write and keep only the raw local platform log.

- [ ] **Step 4: Verify tool behavior**

Run:

```bash
npm run build && node --import=tsx --test test/antigravity/antigravity-memory-flow.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/platforms/antigravity test/antigravity/antigravity-memory-flow.test.ts
git commit -m "feat: record antigravity tool metadata" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 7: Add Templates And Distribution Projections

**Files:**

- Create: `templates/local/antigravity/` when Antigravity has project-local config.
- Create: `templates/marketplace/antigravity/` when Antigravity has a self-contained plugin artifact.
- Create: `templates/antigravity/` only for fragments shared by both local and marketplace templates.
- Create: `test/antigravity-template.test.ts`
- Modify: `scripts/build-dist-local.mjs` when local project config is generated.
- Modify: `scripts/build-dist-marketplace.mjs` when marketplace plugin output is generated.
- Modify: `scripts/build-dist-common.mjs` only when a new projection kind is required.
- Modify: `scripts/check-dist.mjs`

- [ ] **Step 1: Choose the installation model**

Use the least surprising native model:

- Project-local Antigravity plugin if the user wants repository-scoped setup. The plugin root should be `.agents/plugins/nams-hooks/` and should contain `plugin.json` plus `hooks.json`.
- Antigravity CLI global plugin if the user wants machine-wide setup. Manual validation with `agy` 1.0.8 showed `agy plugin install` places the plugin under `$HOME/.gemini/config/plugins/<plugin_name>/`.
- Antigravity IDE or Antigravity 2.0 global plugin only after manual validation proves the active product reads the same installed plugin for the target surface.
- Global CLI fallback only when no self-contained platform install exists.

Keep the output tree responsibilities separate:

- `dist/` is the npm-installable package artifact only. It should contain the compiled runtime under `bin/` and `package.json`, not platform marketplace metadata, project-local config, source templates, or OpenAPI artifacts.
- `dist-marketplace/` is the self-contained Antigravity plugin output. Hook commands in this tree must call bundled runtime files through the validated Antigravity plugin path, such as `node "$HOME/.gemini/config/plugins/nams-hooks/bin/cli.js" ...`.
- `dist-local/` is symlinkable or copyable project config. Hook commands in this tree intentionally call an installed `nams-hooks` executable and must not include compiled runtime files or marketplace roots.

Do not add templates until the native hook command shape, command working directory, and plugin install path are known from local validation.

- [ ] **Step 2: Write template tests first**

Assert:

- Each native hook maps to the correct typed NAMS event: `PreInvocation` to `BeforeAgent`, `PostInvocation` to `AfterAgent`, and `PostToolUse` to `AfterTool`.
- No template emits `SessionStart` for Antigravity until a native startup/resume hook exists.
- No template emits `Stop` for Antigravity unless a Stop-specific stdout contract is implemented and covered by tests.
- Marketplace hook commands call the bundled runtime path for self-contained installs.
- Marketplace templates never call a global `nams-hooks` executable when a bundled CLI path is available.
- Local project templates intentionally call the installed `nams-hooks` executable.
- Local generated files are symlinkable or copyable into a project root without depending on repository source paths.
- Workspace command templates route through `workspaces run antigravity --event <workspace-event>` when the platform supports them.
- Templates do not contain real API keys or hardcoded NAMS service URLs. Native marketplace manifests may declare sensitive user-config keys when the platform requires them, but generated hook commands must not embed secrets.

Example marketplace command expectation for an Antigravity CLI global plugin:

```ts
assert.equal(
  command,
  'node "$HOME/.gemini/config/plugins/nams-hooks/bin/cli.js" run antigravity --event BeforeAgent',
);
```

Replace this command only if manual validation proves Antigravity provides a better plugin-root variable or resolves relative commands from the plugin root.

Example local command expectation:

```ts
assert.equal(command, "nams-hooks run antigravity --event BeforeAgent");
```

- [ ] **Step 3: Create source templates**

Create only the native files Antigravity needs in the matching source tree:

- `templates/marketplace/antigravity/plugins/nams-hooks/` for the self-contained Antigravity CLI plugin root, including `plugin.json`, `hooks.json`, and bundled runtime destination assumptions.
- `templates/local/antigravity/.agents/plugins/nams-hooks/` for project-shaped plugin config that uses the installed executable.
- `templates/antigravity/` only for shared fragments that are rendered into both target trees by explicit projection entries.

The local `hooks.json` source should use Antigravity native events and pass typed NAMS events explicitly:

```json
{
  "nams-memory-before-invocation": {
    "PreInvocation": [
      {
        "type": "command",
        "command": "nams-hooks run antigravity --event BeforeAgent",
        "timeout": 30
      }
    ]
  },
  "nams-memory-after-invocation": {
    "PostInvocation": [
      {
        "type": "command",
        "command": "nams-hooks run antigravity --event AfterAgent",
        "timeout": 30
      }
    ]
  },
  "nams-memory-after-tool": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run antigravity --event AfterTool",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

The marketplace `hooks.json` should use the same native events but point commands at the bundled runtime:

```json
{
  "nams-memory-before-invocation": {
    "PreInvocation": [
      {
        "type": "command",
        "command": "node \"$HOME/.gemini/config/plugins/nams-hooks/bin/cli.js\" run antigravity --event BeforeAgent",
        "timeout": 30
      }
    ]
  },
  "nams-memory-after-invocation": {
    "PostInvocation": [
      {
        "type": "command",
        "command": "node \"$HOME/.gemini/config/plugins/nams-hooks/bin/cli.js\" run antigravity --event AfterAgent",
        "timeout": 30
      }
    ]
  },
  "nams-memory-after-tool": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.gemini/config/plugins/nams-hooks/bin/cli.js\" run antigravity --event AfterTool",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 4: Wire distribution generation**

Update only the projection script for the output tree Antigravity uses:

- Add local project config to `scripts/build-dist-local.mjs` with `to: "antigravity"` under `dist-local/antigravity/`. Local projections should render installed-command templates and should not copy `.build/tsc`.
- Add marketplace plugin output to `scripts/build-dist-marketplace.mjs`. Self-contained plugin installs should add template projections and a `runtime` projection that copies `.build/tsc` into `dist-marketplace/antigravity/plugins/nams-hooks/bin/` and marks `bin/cli.js` executable.
- Leave `scripts/build-dist-npm.mjs` alone unless the npm package runtime shape itself changes.
- Update `scripts/build-dist-common.mjs` only when Antigravity needs a reusable projection kind that existing `template`, `runtime`, `packageJson`, or platform shim projections cannot express.

- [ ] **Step 5: Add release checks**

Update `scripts/check-dist.mjs` to verify:

- Required Antigravity files exist in `dist-marketplace/` and/or `dist-local/`, depending on the chosen install model.
- `dist/` remains npm-only and does not include Antigravity marketplace metadata, project-local config, source templates, or OpenAPI artifacts.
- Marketplace plugin metadata versions match `package.json`.
- Marketplace runtime CLI files are executable.
- Marketplace commands use bundled runtime paths and do not require global `nams-hooks`.
- Local commands intentionally use installed `nams-hooks`.
- `dist-local/` does not include compiled runtime files, marketplace roots, or bundled plugin directories.
- OpenAPI artifacts are absent.
- npm dry-run package output includes only the npm runtime package files and documentation, not generated marketplace or local project artifacts.

- [ ] **Step 6: Verify templates and package output**

Run:

```bash
npm run build && node --import=tsx --test test/antigravity-template.test.ts
npm run dist
npm run dist:check
```

Expected: PASS.

Commit:

Stage only the outputs that actually changed. For example:

```bash
git add templates/local/antigravity templates/marketplace/antigravity templates/antigravity test/antigravity-template.test.ts scripts/build-dist-local.mjs scripts/build-dist-marketplace.mjs scripts/build-dist-common.mjs scripts/check-dist.mjs
git commit -m "feat: package antigravity hook templates" -m "Co-authored-by: Codex <codex@openai.com>"
```

Omit template or script paths that do not exist or did not change.

---

### Task 8: Update Documentation And Design Records

**Files:**

- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `DEVELOPMENT.md`
- Modify: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- Create: `docs/superpowers/specs/2026-06-09-antigravity-platform-design.md` only when platform behavior needs a dedicated design record

- [ ] **Step 1: Document support level**

In README or INSTALL, state:

- Supported OS scope.
- Native install method.
- Required config values: `apiKey`, `workspaceId`, and `baseUrl` from `~/.nams/config.json`, project `.nams/config.json`, native platform configuration when supported, or `NAMS_*` environment variables. `workspaceId` may be omitted only when the runtime can auto-select a single available workspace before memory writes.
- Supported lifecycle events.
- Best-effort assistant and tool capture limitations.

- [ ] **Step 2: Amend the source-of-truth design**

Update `docs/superpowers/specs/2026-05-10-nams-hooks-design.md` when Antigravity becomes officially supported. Add a platform note with:

- Native hook names and NAMS event mapping.
- Install or distribution path.
- Session identity strategy.
- Context injection strategy.
- Known unsupported hooks or best-effort capture areas.

- [ ] **Step 3: Add a dedicated platform design only for new decisions**

Create a new spec when Antigravity introduces a new distribution model, blocking behavior, workspace selection interaction, or payload source that does not fit existing adapter patterns. Keep routine adapter implementation details in this plan and tests.

- [ ] **Step 4: Verify docs mention only supported behavior**

Run:

```bash
rg -n "antigravity|Antigravity" README.md INSTALL.md DEVELOPMENT.md docs/superpowers/specs
```

Expected: Every mention describes implemented behavior or clearly labels deferred behavior.

Commit:

```bash
git add README.md INSTALL.md DEVELOPMENT.md docs/superpowers/specs
git commit -m "docs: document antigravity platform support" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 9: Run Full Verification

**Files:**

- No source files unless verification exposes a defect.

- [ ] **Step 1: Run targeted platform tests**

Run:

```bash
npm run build && node --import=tsx --test test/antigravity/*.test.ts test/antigravity-template.test.ts
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
- `dist-marketplace/` contains Antigravity plugin artifacts when Antigravity uses a self-contained install path.
- `dist-local/` contains Antigravity project-local config when Antigravity uses a local fallback path.

- [ ] **Step 2: Link or install into a throwaway project**

Use the Antigravity-native local install command for the chosen output tree:

- For marketplace plugin validation, run `agy plugin validate dist-marketplace/antigravity/plugins/nams-hooks`, then `agy plugin install dist-marketplace/antigravity/plugins/nams-hooks` with a disposable HOME. With `agy` 1.0.8, the install target is `$HOME/.gemini/config/plugins/nams-hooks/`.
- For project-local validation, install the npm artifact with `npm install -g ./dist`, then symlink or copy the project-shaped config from `dist-local/antigravity/` into the throwaway project.

Keep all test config under the throwaway project or temp HOME. Do not write `.nams/` artifacts into the repository root.

- [ ] **Step 3: Validate lazy session initialization**

Start or resume Antigravity and confirm:

- No native Antigravity startup/resume hook is expected.
- The first memory hook creates a session-scoped log under `~/.nams/logs/antigravity/`.
- The first memory hook creates state under `~/.nams/state/antigravity/`.
- No generated Antigravity `hooks.json` entry calls `nams-hooks run antigravity --event SessionStart`.

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

Add manual validation notes to the PR description or a design amendment. Include native Antigravity version, OS, install method, supported event list, and known gaps.

---

### Task 11: Add Live Validation Only When In Scope

**Files:**

- Modify: `live-tests/README.md` only when live Antigravity validation is added.
- Modify: `live-tests/pom.xml` only when new live-test dependencies or Maven configuration are needed.
- Create: `live-tests/docker/antigravity/Dockerfile` only when Antigravity can run in a reviewable container image.
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/antigravity/` only when adding Antigravity live scenarios.

- [ ] **Step 1: Decide whether live validation belongs in this platform PR**

Do not add live tests automatically. Add them only when:

- Antigravity can run non-interactively in Linux Docker.
- The platform credentials can be supplied through environment variables or local `live-tests/.env`.
- The scenario can consume generated `dist/` and `dist-local/` artifacts without rewriting generated hook commands.
- The test can assert real NAMS persistence without becoming part of `npm run check`.

If any condition is not true, record manual validation notes from Task 10 and leave `live-tests/` unchanged.

- [ ] **Step 2: Follow the existing live-test artifact contract**

When live validation is in scope, build generated artifacts first:

```bash
npm run dist
```

The live test must install the generated npm package from `dist/`, link or copy generated local config from `dist-local/antigravity/`, and use a disposable project plus disposable HOME inside the container.

- [ ] **Step 3: Add the smallest useful live scenario**

Mirror the current Codex live-test style:

- Preflight required Antigravity credentials and NAMS credentials.
- Print or capture the Antigravity CLI version.
- Install `nams-hooks` from `dist/`.
- Link the generated Antigravity local project config from `dist-local/`.
- Run one prompt that should trigger native `PreInvocation` and route to NAMS `BeforeAgent`.
- Assert local state/log creation and the NAMS conversation/message created by the hook runtime.

- [ ] **Step 4: Run live validation manually**

Run from the repository root:

```bash
npm run dist
cd live-tests
mvn test -Dtest=AntigravityNamsLiveTest
```

Expected: PASS when Docker, platform credentials, and NAMS credentials are configured. Live tests call real external services, may spend API credits, and remain outside `npm run check`.

Commit:

```bash
git add live-tests
git commit -m "test: add antigravity live validation" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

## Final Acceptance Checklist

- `src/cli.ts` remains a platform-agnostic gateway.
- `invocation.event` is still the only event source of truth.
- Antigravity-specific parsing is confined to `src/platforms/antigravity/`.
- The platform registry stays static.
- Runtime code uses Node built-ins only and no new `dependencies`.
- Runtime code, templates, generators, and generated artifacts do not hardcode NAMS service URLs.
- Hook runtime never fetches or reads OpenAPI artifacts.
- Tests use temp directories and mocks, not repository `.nams/` state.
- Raw hook payload logs preserve the platform payload for debugging.
- NAMS request logs and diagnostics never expose API keys.
- `npm run check` passes before claiming implementation complete.
- `npm run package:check` passes when distribution files or templates changed.
- Live tests, if added, consume generated artifacts and remain outside the default Node verification path.
