# Session Workspace Configure Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `nams-hooks workspaces configure opencode --scope session --session-id <current-session-id> --workspace <workspace-id-or-name>` as a shared session-scoped workspace selection command.

**Architecture:** Extend the existing `workspaces configure` command instead of adding a parallel command. The CLI parses `--scope session`, `--session-id`, and `--workspace`, then delegates to the existing workspace adapter; shared runtime validates the workspace selector against `GET /v1/users/me/workspaces` and writes only session state. Runtime memory resolution treats `source: "session-selection"` as the highest-priority workspace source, while older auto-selected session state remains weaker than explicit config.

**Tech Stack:** TypeScript, Node built-ins, generated NAMS clients, local JSON session state under `~/.nams/state/`, Node `node:test`, existing HTTP/fetch test helpers.

---

## Source Documents

- Design: `docs/superpowers/specs/2026-06-10-session-workspace-selection-design.md`
- Existing inline resolver design: `docs/superpowers/specs/2026-06-09-inline-workspace-resolution-design.md`
- Key-scope design: `docs/superpowers/specs/2026-06-08-nams-key-scope-workspace-resolution-design.md`
- Workspace hook design: `docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md`
- Architecture rules: `AGENTS.md`

## Out Of Scope

- Do not implement platform slash-command handling in this plan.
- Do not create a cross-platform picker.
- Do not change generated NAMS client endpoint coverage.
- Do not add runtime npm dependencies.

## File Structure

- `src/cli.ts`: parse `--scope session`, `--session-id`, and `--workspace`; preserve existing `project`/`user` `--workspace-id` behavior.
- `src/runtime/session-state.ts`: add `session-selection` to the session workspace source union.
- `src/runtime/workspace-configuration.ts`: validate session-scope input, resolve workspace by exact ID or exact name, write session state, and keep project/user JSON config behavior intact.
- `src/runtime/workspace-resolution.ts`: treat `state.workspace.source === "session-selection"` as the strongest memory workspace source; leave `runtime-single-workspace` state behind config.
- `src/platforms/workspace-selection.ts`: update multi-workspace notice to show the session-scope configure command, not the durable project command.
- `test/cli-workspaces.test.ts`: add command-level tests for session-scope configuration, selector matching, ambiguous names, and no-write failures.
- `test/workspace-resolution.test.ts`: add memory resolver precedence tests for session selection versus env/config and for legacy runtime auto-selection state.
- `test/*memory-flow.test.ts` and `test/opencode/opencode-template.test.ts`: update string assertions for the new session-scope notice.
- `README.md` and `INSTALL.md`: document `session` as a third workspace selection lifetime.

---

### Task 1: Add Failing CLI Tests For Session Configure

**Files:**
- Modify: `test/cli-workspaces.test.ts`

- [ ] **Step 1: Add helpers for reading session state written by the child CLI**

In `test/cli-workspaces.test.ts`, add this import beside the existing imports:

```ts
import { sessionStateFiles } from "./support/runtime-home.js";
```

Add these helpers after `childProcessEnv()`:

```ts
async function onlySessionStatePath(homeDir: string, platform: "gemini" | "claude" | "codex" | "opencode"): Promise<string> {
  const files = await sessionStateFiles(homeDir, platform);
  assert.equal(files.length, 1, `expected one ${platform} session state file, got ${files.join(", ")}`);
  return path.join(homeDir, ".nams", "state", platform, files[0]);
}

async function readOnlySessionState(homeDir: string, platform: "gemini" | "claude" | "codex" | "opencode"): Promise<Record<string, any>> {
  return JSON.parse(await readFile(await onlySessionStatePath(homeDir, platform), "utf8")) as Record<string, any>;
}
```

- [ ] **Step 2: Add failing test for writing a session workspace by ID**

Add this test after `workspaces configure codex writes project config for explicit workspace`:

```ts
test("workspaces configure session writes selected workspace by id", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl, requests) => {
        const homeDir = path.join(projectDir, "home");
        const result = await runCli(
          [
            "workspaces",
            "configure",
            "opencode",
            "--scope",
            "session",
            "--session-id",
            "session-1",
            "--workspace",
            "workspace-2",
          ],
          {},
          runtimeEnv(homeDir, baseUrl),
          projectDir,
        );

        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /opencode/);
        assert.match(result.stdout, /session-1/);
        assert.match(result.stdout, /workspace-2/);
        assert.equal(result.stderr, "");
        await assert.rejects(readFile(path.join(projectDir, ".nams", "config.json"), "utf8"), {
          code: "ENOENT",
        });

        const state = await readOnlySessionState(homeDir, "opencode");
        assert.equal(state.harness, "opencode");
        assert.equal(state.harnessSessionId, "session-1");
        assert.equal(state.sessionKey, "session-1");
        assert.equal(state.projectDirectory, projectDir);
        assert.deepEqual(state.workspace, {
          id: "workspace-2",
          source: "session-selection",
          selectedAt: state.workspace.selectedAt,
        });

        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, "/v1/users/me/workspaces");
        assert.equal(requests[0].headers["x-workspace-id"], undefined);
      },
      {
        workspaces: [
          { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
          { id: "workspace-2", name: "Research", role: "member", status: "active" },
        ],
      },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Add failing test for preserving existing session state**

Add this test after the ID test:

```ts
test("workspaces configure session preserves existing session fields", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const homeDir = path.join(projectDir, "home");
        const env = runtimeEnv(homeDir, baseUrl);

        const firstResult = await runCli(
          [
            "workspaces",
            "configure",
            "opencode",
            "--scope",
            "session",
            "--session-id",
            "session-1",
            "--workspace",
            "workspace-1",
          ],
          {},
          env,
          projectDir,
        );
        assert.equal(firstResult.code, 0, firstResult.stderr);

        const statePath = await onlySessionStatePath(homeDir, "opencode");
        const existingState = JSON.parse(await readFile(statePath, "utf8")) as Record<string, any>;
        existingState.conversationId = "conversation-1";
        existingState.pendingMemoryContext = {
          content: "remembered context",
          createdAt: "2026-06-10T10:00:00.000Z",
        };
        existingState.seenToolCallIds = ["tool-1"];
        await writeFile(statePath, `${JSON.stringify(existingState, null, 2)}\n`, "utf8");

        const secondResult = await runCli(
          [
            "workspaces",
            "configure",
            "opencode",
            "--scope",
            "session",
            "--session-id",
            "session-1",
            "--workspace",
            "workspace-2",
          ],
          {},
          env,
          projectDir,
        );
        assert.equal(secondResult.code, 0, secondResult.stderr);

        const state = await readOnlySessionState(homeDir, "opencode");
        assert.equal(state.conversationId, "conversation-1");
        assert.deepEqual(state.pendingMemoryContext, {
          content: "remembered context",
          createdAt: "2026-06-10T10:00:00.000Z",
        });
        assert.deepEqual(state.seenToolCallIds, ["tool-1"]);
        assert.deepEqual(state.workspace, {
          id: "workspace-2",
          source: "session-selection",
          selectedAt: state.workspace.selectedAt,
        });
      },
      {
        workspaces: [
          { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
          { id: "workspace-2", name: "Research", role: "member", status: "active" },
        ],
      },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Add failing test for exact workspace name selection**

Add this test after the preservation test:

```ts
test("workspaces configure session accepts an exact workspace name", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const homeDir = path.join(projectDir, "home");
        const result = await runCli(
          [
            "workspaces",
            "configure",
            "opencode",
            "--scope",
            "session",
            "--session-id",
            "session-1",
            "--workspace",
            "Research",
          ],
          {},
          runtimeEnv(homeDir, baseUrl),
          projectDir,
        );

        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /workspace-2/);

        const state = await readOnlySessionState(homeDir, "opencode");
        assert.equal(state.workspace.id, "workspace-2");
        assert.equal(state.workspace.source, "session-selection");
      },
      {
        workspaces: [
          { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
          { id: "workspace-2", name: "Research", role: "member", status: "active" },
        ],
      },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Add failing tests for missing session ID, unknown selector, and ambiguous name**

Add these tests after the exact-name test:

```ts
test("workspaces configure session requires session id before listing workspaces", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(async (baseUrl, requests) => {
      const homeDir = path.join(projectDir, "home");
      const result = await runCli(
        ["workspaces", "configure", "opencode", "--scope", "session", "--workspace", "workspace-1"],
        {},
        runtimeEnv(homeDir, baseUrl),
        projectDir,
      );

      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /requires --session-id/);
      assert.equal(requests.length, 0);
      assert.deepEqual(await sessionStateFiles(homeDir, "opencode"), []);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure session reports unknown workspace selector without writing state", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const homeDir = path.join(projectDir, "home");
        const result = await runCli(
          [
            "workspaces",
            "configure",
            "opencode",
            "--scope",
            "session",
            "--session-id",
            "session-1",
            "--workspace",
            "Missing Workspace",
          ],
          {},
          runtimeEnv(homeDir, baseUrl),
          projectDir,
        );

        assert.equal(result.code, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Requested NAMS workspace was not found: Missing Workspace/);
        assert.match(result.stderr, /workspace-1/);
        assert.deepEqual(await sessionStateFiles(homeDir, "opencode"), []);
      },
      {
        workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
      },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure session rejects ambiguous workspace names without writing state", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const homeDir = path.join(projectDir, "home");
        const result = await runCli(
          [
            "workspaces",
            "configure",
            "opencode",
            "--scope",
            "session",
            "--session-id",
            "session-1",
            "--workspace",
            "Engineering",
          ],
          {},
          runtimeEnv(homeDir, baseUrl),
          projectDir,
        );

        assert.equal(result.code, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /ambiguous/i);
        assert.match(result.stderr, /workspace-1/);
        assert.match(result.stderr, /workspace-2/);
        assert.deepEqual(await sessionStateFiles(homeDir, "opencode"), []);
      },
      {
        workspaces: [
          { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
          { id: "workspace-2", name: "Engineering", role: "member", status: "active" },
        ],
      },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: Run tests to verify failure**

Run:

```bash
npm run build && node --import=tsx --test test/cli-workspaces.test.ts
```

Expected: FAIL. The parser currently rejects `--scope session`, so at least the new session tests should fail with usage output or missing session behavior.

---

### Task 2: Implement Session Configure CLI And Runtime Write

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/runtime/session-state.ts`
- Modify: `src/runtime/workspace-configuration.ts`
- Test: `test/cli-workspaces.test.ts`

- [ ] **Step 1: Add `session-selection` to session state sources**

In `src/runtime/session-state.ts`, replace the `SessionWorkspaceSource` type with:

```ts
export type SessionWorkspaceSource =
  | "config"
  | "runtime-single-workspace"
  | "install-selection"
  | "session-selection";
```

- [ ] **Step 2: Extend CLI args and usage**

In `src/cli.ts`, replace the `workspace-configure` union member with:

```ts
| {
    command: "workspace-configure";
    platform: Platform;
    scope: "project" | "user" | "session";
    workspaceId?: string;
    workspace?: string;
    sessionId?: string;
  };
```

In the `args.command === "workspace-configure"` branch, replace the `rawPayload` object with:

```ts
rawPayload: {
  scope: args.scope,
  ...(args.workspaceId !== undefined ? { workspaceId: args.workspaceId } : {}),
  ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
  ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
},
```

In `parseArgs`, replace the `workspaces configure` block with:

```ts
if (command === "workspaces" && platformArg === "configure") {
  const platform = argv[2];
  const scopeFlagIndex = argv.indexOf("--scope");
  const workspaceIdFlagIndex = argv.indexOf("--workspace-id");
  const workspaceFlagIndex = argv.indexOf("--workspace");
  const sessionFlagIndex = argv.indexOf("--session-id");
  const scope = scopeFlagIndex >= 0 ? argv[scopeFlagIndex + 1] : undefined;
  const workspaceId = workspaceIdFlagIndex >= 0 ? argv[workspaceIdFlagIndex + 1] : undefined;
  const workspace = workspaceFlagIndex >= 0 ? argv[workspaceFlagIndex + 1] : undefined;
  const sessionId = sessionFlagIndex >= 0 ? argv[sessionFlagIndex + 1] : undefined;
  if (isPlatform(platform) && (scope === "project" || scope === "user" || scope === "session")) {
    return {
      command: "workspace-configure",
      platform,
      scope,
      ...(workspaceId !== undefined && workspaceId.trim() !== "" ? { workspaceId } : {}),
      ...(workspace !== undefined && workspace.trim() !== "" ? { workspace } : {}),
      ...(sessionId !== undefined && sessionId.trim() !== "" ? { sessionId } : {}),
    };
  }
}
```

In `usage()`, replace the configure line with:

```ts
"       nams-hooks workspaces configure <gemini|claude|codex|opencode> --scope <project|user|session> [--workspace-id ID] [--session-id ID] [--workspace ID_OR_NAME]",
```

- [ ] **Step 3: Extend workspace configuration input parsing**

In `src/runtime/workspace-configuration.ts`, add these imports:

```ts
import {
  createInitialSessionState,
  loadSessionState,
  saveSessionState,
} from "./session-state.js";
```

Replace the local `ConfigureInput` interface with:

```ts
type WorkspaceConfigureScope = NamsConfigWriteScope | "session";

interface ConfigureInput {
  scope: WorkspaceConfigureScope;
  workspaceId?: string;
  workspace?: string;
  sessionId?: string;
}
```

Replace `parseConfigureInput` with:

```ts
function parseConfigureInput(rawPayload: Record<string, unknown>): ConfigureInput | undefined {
  const scope = rawPayload.scope;
  if (scope !== "project" && scope !== "user" && scope !== "session") {
    return undefined;
  }

  const workspaceId = nonBlankString(rawPayload.workspaceId);
  const workspace = nonBlankString(rawPayload.workspace);
  const sessionId = nonBlankString(rawPayload.sessionId);
  return {
    scope,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}
```

Add this helper near the bottom of the file:

```ts
function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
```

- [ ] **Step 4: Implement selector resolution and session state writing**

In `src/runtime/workspace-configuration.ts`, add these types below `ConfigureInput`:

```ts
type WorkspaceSelection =
  | { status: "selected"; workspace: WorkspaceSummary & { id: string } }
  | { status: "missing-selector" }
  | { status: "not-found"; selector: string }
  | { status: "ambiguous-name"; selector: string; matches: Array<WorkspaceSummary & { id: string }> };

interface SessionConfigureInput extends ConfigureInput {
  scope: "session";
  sessionId: string;
}
```

Add these helper functions above `validWorkspaces`:

```ts
function selectWorkspaceById(
  workspaces: Array<WorkspaceSummary & { id: string }>,
  workspaceId: string | undefined,
): (WorkspaceSummary & { id: string }) | undefined {
  if (workspaceId !== undefined) {
    return workspaces.find((workspace) => workspace.id === workspaceId);
  }
  return workspaces.length === 1 ? workspaces[0] : undefined;
}

function selectWorkspaceBySelector(
  workspaces: Array<WorkspaceSummary & { id: string }>,
  selector: string | undefined,
): WorkspaceSelection {
  if (selector === undefined) {
    return workspaces.length === 1
      ? { status: "selected", workspace: workspaces[0] }
      : { status: "missing-selector" };
  }

  const idMatch = workspaces.find((workspace) => workspace.id === selector);
  if (idMatch !== undefined) {
    return { status: "selected", workspace: idMatch };
  }

  const nameMatches = workspaces.filter((workspace) => workspace.name?.trim() === selector);
  if (nameMatches.length === 1) {
    return { status: "selected", workspace: nameMatches[0] };
  }
  if (nameMatches.length > 1) {
    return { status: "ambiguous-name", selector, matches: nameMatches };
  }
  return { status: "not-found", selector };
}

async function writeSessionWorkspaceSelection(
  invocation: WorkspaceHookInvocation<"InstallConfigure">,
  input: SessionConfigureInput,
  projectDirectory: string,
  selectedWorkspace: WorkspaceSummary & { id: string },
): Promise<WorkspaceHookResult> {
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    sessionId: input.sessionId,
    projectDirectory,
  });
  const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ?? initialState;
  state.workspace = {
    id: selectedWorkspace.id,
    source: "session-selection",
    selectedAt: new Date().toISOString(),
  };
  await saveSessionState(invocation.platform, state.sessionKey, state);
  return configureOutput(
    0,
    `NAMS workspace configured for ${invocation.platform} session ${input.sessionId}: ${selectedWorkspace.id}`,
  );
}

function isSessionConfigureInput(input: ConfigureInput): input is SessionConfigureInput {
  return input.scope === "session" && input.sessionId !== undefined;
}
```

- [ ] **Step 5: Route session scope separately from JSON config writing**

In `configureWorkspaceSelection`, after parsing `configureInput`, replace the existing project/user-only validation and selection block with this structure:

```ts
if (configureInput.scope === "session" && configureInput.sessionId === undefined) {
  return configureOutput(1, "NAMS workspace configure --scope session requires --session-id.");
}

const projectDirectory = invocation.processCwd;
if (configureInput.scope !== "session") {
  const preflightResult = await preflightConfigurePaths(projectDirectory, configureInput.scope);
  if (preflightResult !== undefined) {
    return preflightResult;
  }
}
const connectionResult = await loadNamsConnectionConfig(projectDirectory);
if (!connectionResult.ok) {
  return configureOutput(1, String(configDiagnosticPayload(connectionResult).message));
}

const client = new NamsWorkspaceClient({
  apiKey: connectionResult.config.apiKey,
  baseUrl: connectionResult.config.baseUrl,
});

let workspaces: Array<WorkspaceSummary & { id: string }>;
try {
  const response = await client.listMyWorkspaces();
  workspaces = validWorkspaces(response.workspaces);
} catch {
  return configureOutput(
    2,
    "NAMS workspace request failed. Check NAMS_API_KEY and NAMS_BASE_URL, then try again.",
  );
}

if (configureInput.scope === "session") {
  if (!isSessionConfigureInput(configureInput)) {
    return configureOutput(1, "NAMS workspace configure --scope session requires --session-id.");
  }
  const selection = selectWorkspaceBySelector(workspaces, configureInput.workspace ?? configureInput.workspaceId);
  if (selection.status !== "selected") {
    return configureOutput(2, sessionWorkspaceSelectionFailureMessage(workspaces, selection));
  }
  return writeSessionWorkspaceSelection(invocation, configureInput, projectDirectory, selection.workspace);
}

const selectedWorkspace = selectWorkspaceById(workspaces, configureInput.workspaceId);
if (selectedWorkspace === undefined) {
  return configureOutput(2, workspaceSelectionFailureMessage(workspaces, configureInput.workspaceId));
}

const result = await writeNamsJsonConfig({
  projectDirectory,
  scope: configureInput.scope,
  workspaceId: selectedWorkspace.id,
});

return configureOutput(
  0,
  `NAMS workspace configured for ${invocation.platform}: ${selectedWorkspace.id}\nUpdated ${result.path}`,
);
```

Add this failure-message helper next to `workspaceSelectionFailureMessage`:

```ts
function sessionWorkspaceSelectionFailureMessage(
  workspaces: Array<WorkspaceSummary & { id: string }>,
  selection: Exclude<WorkspaceSelection, { status: "selected" }>,
): string {
  if (selection.status === "ambiguous-name") {
    return [
      `Requested NAMS workspace name is ambiguous: ${selection.selector}`,
      "Matching workspaces:",
      ...workspaceChoices(selection.matches),
    ].join("\n");
  }
  if (selection.status === "not-found") {
    return [
      `Requested NAMS workspace was not found: ${selection.selector}`,
      ...(workspaces.length > 0 ? ["Available workspaces:", ...workspaceChoices(workspaces)] : []),
    ].join("\n");
  }
  if (workspaces.length === 0) {
    return "No NAMS workspaces were returned. Check that your NAMS account has access to at least one workspace.";
  }
  return [
    "NAMS workspace selection required. Re-run with --workspace and one of these IDs or names:",
    ...workspaceChoices(workspaces),
  ].join("\n");
}
```

Delete or stop using the old `selectWorkspace` helper after `selectWorkspaceById` is in place.

- [ ] **Step 6: Run targeted CLI tests**

Run:

```bash
npm run build && node --import=tsx --test test/cli-workspaces.test.ts
```

Expected: PASS for `test/cli-workspaces.test.ts`.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/cli.ts src/runtime/session-state.ts src/runtime/workspace-configuration.ts test/cli-workspaces.test.ts
git commit -m "feat: configure session workspace selection" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Implement Session-Selection Precedence For Memory Resolution

**Files:**
- Modify: `src/runtime/workspace-resolution.ts`
- Modify: `test/workspace-resolution.test.ts`

- [ ] **Step 1: Add failing precedence tests**

In `test/workspace-resolution.test.ts`, add this test after `configured workspace skips workspace listing and is not preflight validated`:

```ts
test("session-selected workspace overrides NAMS_WORKSPACE_ID", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    const nams = createNamsFetchMock().all({ error: "unexpected workspace listing" }, 500);
    useEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "env-workspace",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const state = createInitialSessionState({
      platform: "gemini",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });
    state.workspace = {
      id: "session-workspace",
      source: "session-selection",
      selectedAt: "2026-06-10T10:00:00.000Z",
    };

    const result = await resolveWorkspaceForMemory({
      invocation: invocation(projectDir),
      state,
      projectDirectory: projectDir,
    });

    assert.equal(result.status, "ready");
    assert.equal(result.config.workspaceId, "session-workspace");
    assert.equal(state.workspace.id, "session-workspace");
    assert.equal(state.workspace.source, "session-selection");
    assert.equal(nams.calls("listMyWorkspaces").length, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

Add this test after it:

```ts
test("configured workspace overrides runtime auto-selected session state", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    const nams = createNamsFetchMock().all({ error: "unexpected workspace listing" }, 500);
    useEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "env-workspace",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const state = createInitialSessionState({
      platform: "gemini",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });
    state.workspace = {
      id: "old-auto-workspace",
      source: "runtime-single-workspace",
      selectedAt: "2026-06-10T10:00:00.000Z",
    };

    const result = await resolveWorkspaceForMemory({
      invocation: invocation(projectDir),
      state,
      projectDirectory: projectDir,
    });

    assert.equal(result.status, "ready");
    assert.equal(result.config.workspaceId, "env-workspace");
    assert.equal(state.workspace.id, "env-workspace");
    assert.equal(state.workspace.source, "config");
    assert.equal(nams.calls("listMyWorkspaces").length, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import=tsx --test test/workspace-resolution.test.ts
```

Expected: FAIL before implementation. The first new test should currently return `env-workspace` instead of `session-workspace`.

- [ ] **Step 3: Reorder resolver precedence by session workspace source**

In `src/runtime/workspace-resolution.ts`, inside `resolveWorkspaceForMemory`, insert this block immediately after `const config = connectionResult.config;` and before the existing `if (config.workspaceId !== undefined)` block:

```ts
if (input.state.workspace?.source === "session-selection") {
  await appendWorkspaceDiagnostic(input.invocation, input.state, {
    message: workspaceDiagnosticMessages.loadedFromSessionState,
    workspace: {
      id: input.state.workspace.id,
      source: input.state.workspace.source,
    },
  });
  return {
    status: "ready",
    config: runtimeConfig(config.apiKey, input.state.workspace.id, config.baseUrl),
  };
}
```

Leave the existing configured-workspace branch below this new block. Leave the existing later `if (input.state.workspace !== undefined)` branch in place so non-session state such as `runtime-single-workspace` is reused only when no configured workspace exists.

- [ ] **Step 4: Run targeted resolver tests**

Run:

```bash
node --import=tsx --test test/workspace-resolution.test.ts
```

Expected: PASS for `test/workspace-resolution.test.ts`.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/runtime/workspace-resolution.ts test/workspace-resolution.test.ts
git commit -m "fix: prefer session workspace selections" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Update Selection Notices And Documentation

**Files:**
- Modify: `src/platforms/workspace-selection.ts`
- Modify: `test/opencode/opencode-template.test.ts`
- Modify: `test/claude/claude-memory-flow.test.ts`
- Modify: `test/codex/codex-memory-flow.test.ts`
- Modify if failing: `test/gemini/gemini-memory-flow.test.ts`
- Modify: `README.md`
- Modify: `INSTALL.md`

- [ ] **Step 1: Update the shared multi-workspace notice**

In `src/platforms/workspace-selection.ts`, replace the configure line with:

```ts
`Configure a session workspace before memory can resume: nams-hooks workspaces configure ${platform} --scope session --session-id <session-id> --workspace <workspace-id-or-name>`,
```

Do not add slash-command text in this task. Slash-command implementation and related notices are postponed.

- [ ] **Step 2: Update tests that assert the old project-scope command**

Run:

```bash
rg -n -- "workspaces configure .*--scope project --workspace-id|--workspace-id <workspace-id>" test src README.md INSTALL.md docs
```

Update the matching test expectations to look for the session command. In tests that use regex, use this pattern:

```ts
/nams-hooks workspaces configure .* --scope session --session-id <session-id> --workspace <workspace-id-or-name>/
```

In `test/opencode/opencode-template.test.ts`, replace any legacy project-scope
notice expectation with:

```ts
"Configure a session workspace before memory can resume: nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>",
```

- [ ] **Step 3: Update README runtime configuration summary**

In `README.md`, update the runtime configuration paragraph so the multi-workspace sentence says:

```md
If multiple valid workspaces are returned, choose one for the active session with `nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>`, or write a durable project/user default with `nams-hooks workspaces configure ... --scope project|user`.
```

Keep the surrounding paragraph intact unless line wrapping requires small edits.

- [ ] **Step 4: Update INSTALL workspace selection section**

In `INSTALL.md`, add this paragraph under "Workspace Selection" after the explanation of multiple valid workspaces:

````md
For a temporary selection in the active agent session, use session scope:

```bash
nams-hooks workspaces configure opencode --scope session --session-id session-1 --workspace Engineering
```

`--workspace` accepts either an exact workspace ID or an exact workspace name. If more than one workspace has the same name, use the workspace ID.
````

Keep the existing project-scope example as the durable project default example.

- [ ] **Step 5: Run targeted notice/docs tests**

Run:

```bash
npm run build && node --import=tsx --test test/opencode/opencode-template.test.ts test/claude/claude-memory-flow.test.ts test/codex/codex-memory-flow.test.ts test/gemini/gemini-memory-flow.test.ts
```

Expected: PASS for the listed tests.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/platforms/workspace-selection.ts test/opencode/opencode-template.test.ts test/claude/claude-memory-flow.test.ts test/codex/codex-memory-flow.test.ts test/gemini/gemini-memory-flow.test.ts README.md INSTALL.md
git commit -m "docs: describe session workspace selection" -m "Co-authored-by: Codex <codex@openai.com>"
```

If `test/gemini/gemini-memory-flow.test.ts` did not change, omit it from `git add`.

---

### Task 5: Final Verification

**Files:**
- No new source files.
- Verify all files changed by Tasks 1-4.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run check
```

Expected: PASS. This runs OpenAPI freshness checks, TypeScript build, and the full test suite.

- [ ] **Step 2: Inspect changed files**

Run:

```bash
git status --short
git diff --stat HEAD~3..HEAD
```

Expected: worktree clean after the task commits. Diff stat should include only the files listed in this plan.

- [ ] **Step 3: Final branch status**

Run:

```bash
git log --oneline --max-count=5
git status --short
```

Expected: commits from Tasks 2-4 are present after the design/plan commits, and `git status --short` is empty.
