# NAMS Key Scope Workspace Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `nams-hooks` to document and test the new NAMS workspace-key/admin-key model using workspace-list cardinality only.

**Architecture:** Keep the current two-client boundary: `NamsClient` remains workspace-scoped and requires `workspaceId`, while `NamsWorkspaceClient` lists workspaces without `X-Workspace-Id`. Do not add runtime key-type concepts; infer auto-selection or selection-required behavior only from the count of valid workspaces returned by `GET /v1/users/me/workspaces`.

**Tech Stack:** TypeScript, Node built-ins, generated OpenAPI client, Node `node:test`, existing local HTTP/fetch test support, Markdown docs.

---

## Source Documents

- Approved addendum: `docs/superpowers/specs/2026-06-08-nams-key-scope-workspace-resolution-design.md`
- Existing workspace-resolution design: `docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md`
- Workspace ID design: `docs/superpowers/specs/2026-06-03-nams-workspace-id-design.md`
- Main hooks design: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- OpenAPI spec: `docs/nams-openapi.json`
- Architecture rules: `AGENTS.md`

## File Structure

- `src/runtime/workspace-resolution.ts`: should remain key-scope neutral and branch only on configured workspace, session workspace, and workspace-list cardinality. No planned change unless tests reveal a mismatch.
- `src/runtime/workspace-configuration.ts`: should continue validating explicit configure selections by listing workspaces once. No planned change unless configure tests reveal a mismatch.
- `src/generated/nams-client.ts`: generated output only. No hand edits.
- `scripts/generate-nams-client.mjs`: generator should keep `NamsWorkspaceClient` separate and keep workspace infrastructure endpoints out of `NamsClient`. No planned change.
- `test/workspace-resolution.test.ts`: rename and strengthen tests around configured workspace precedence and cardinality-only auto-selection/selection-required behavior.
- `test/cli-workspaces.test.ts`: add configure-command coverage for the workspace-key happy path where one workspace is returned and `--workspace-id` is omitted.
- `test/nams-workspace-client-generator.test.ts`: keep existing assertions that workspace listing omits `X-Workspace-Id`; no planned change unless final review finds missing coverage.
- `README.md`: explain workspace keys, admin keys, and cardinality-only behavior briefly.
- `INSTALL.md`: explain key scopes in the workspace-selection setup section and clarify Gemini/OpenCode runtime auto-resolution.
- `docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md`: add a short amendment pointer to the 2026-06-08 key-scope design so future readers do not miss the new API behavior.

## Data Contract

Do not add any of these names to runtime config, generated client options, session state, hook output, or logs:

```ts
type ForbiddenRuntimeKeyScopeNames =
  | "keyType"
  | "adminKey"
  | "workspaceKey"
  | "admin-key"
  | "workspace-key";
```

The observable runtime contract remains:

```ts
type WorkspaceListCardinalityDecision =
  | "zero-valid-workspaces-skip-memory"
  | "one-valid-workspace-auto-select"
  | "multiple-valid-workspaces-require-selection";
```

---

### Task 1: Pin Runtime Cardinality Behavior

**Files:**
- Modify: `test/workspace-resolution.test.ts`
- Inspect only: `src/runtime/workspace-resolution.ts`

- [x] **Step 1: Rename the configured-workspace test and add a preflight-validation assertion**

In `test/workspace-resolution.test.ts`, rename:

```ts
test("configured workspace skips workspace listing", async () => {
```

to:

```ts
test("configured workspace skips workspace listing and is not preflight validated", async () => {
```

Keep the existing mock that would fail if workspace listing is called:

```ts
const nams = createNamsFetchMock().workspaces({ error: "unexpected workspace listing" }, 500);
```

Add this assertion after `assert.equal(result.config.workspaceId, "configured-workspace");`:

```ts
assert.deepEqual(state.workspace, {
  id: "configured-workspace",
  source: "config",
  selectedAt: state.workspace?.selectedAt,
});
```

- [x] **Step 2: Rename the single-workspace test to describe cardinality, not key type**

In `test/workspace-resolution.test.ts`, rename:

```ts
test("single returned workspace stores session workspace and returns ready config", async () => {
```

to:

```ts
test("single listed workspace auto-selects by cardinality", async () => {
```

Keep the workspace-list response exactly key-neutral:

```ts
workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
```

Do not add test fixture fields such as `keyType`, `adminKey`, `workspaceKey`, `admin-key`, or `workspace-key`.

- [x] **Step 3: Rename the multi-workspace tests to describe cardinality**

In `test/workspace-resolution.test.ts`, rename:

```ts
test("multiple workspaces return Gemini deny output before memory can continue", async () => {
```

to:

```ts
test("multiple listed workspaces require Gemini selection before memory can continue", async () => {
```

Rename:

```ts
test("multiple workspaces return OpenCode configuration-required output without memory readiness", async () => {
```

to:

```ts
test("multiple listed workspaces require OpenCode configuration before memory readiness", async () => {
```

- [x] **Step 4: Run the targeted workspace-resolution tests**

Run:

```bash
node --import=tsx --test test/workspace-resolution.test.ts
```

Expected: all tests pass. If any test fails because workspace-resolution logic branches on key type or calls the workspace list when `workspaceId` is configured, inspect `src/runtime/workspace-resolution.ts` and restore this branch order:

```ts
if (config.workspaceId !== undefined) {
  input.state.workspace = {
    id: config.workspaceId,
    source: "config",
    selectedAt: new Date().toISOString(),
  };
  await appendWorkspaceDiagnostic(input.invocation, input.state, {
    message: workspaceDiagnosticMessages.loadedFromConfig,
    configSources: connectionResult.sources,
  });
  return {
    status: "ready",
    config: runtimeConfig(config.apiKey, config.workspaceId, config.baseUrl),
  };
}

if (input.state.workspace !== undefined) {
  return {
    status: "ready",
    config: runtimeConfig(config.apiKey, input.state.workspace.id, config.baseUrl),
  };
}

const client = new NamsWorkspaceClient({
  apiKey: config.apiKey,
  baseUrl: config.baseUrl,
  defaultHeaders: namsProvenanceHeaders(input.invocation),
  onRequest: (event) => appendNamsRequestLog(input.invocation, input.state, event),
});
```

- [x] **Step 5: Commit runtime test hardening**

Run:

```bash
git add test/workspace-resolution.test.ts src/runtime/workspace-resolution.ts
git commit -m "test: clarify cardinality workspace resolution" -m "Co-authored-by: Codex <codex@openai.com>"
```

Expected: commit succeeds. If `src/runtime/workspace-resolution.ts` was unchanged, `git add` should still succeed and the commit should contain only the test rename/assertion changes.

---

### Task 2: Add Configure Command Workspace-Key Happy Path

**Files:**
- Modify: `test/cli-workspaces.test.ts`
- Inspect only: `src/runtime/workspace-configuration.ts`

- [x] **Step 1: Add a configure test for omitted `--workspace-id` with one listed workspace**

In `test/cli-workspaces.test.ts`, add this test after `workspaces configure codex writes project config for explicit workspace`:

```ts
test("workspaces configure auto-writes the only returned workspace when workspace id is omitted", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const result = await runCli(
          ["workspaces", "configure", "codex", "--scope", "project"],
          {},
          runtimeEnv(path.join(projectDir, "home"), baseUrl),
          projectDir,
        );

        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /workspace-only/);
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(await readFile(path.join(projectDir, ".nams", "config.json"), "utf8")), {
          workspaceId: "workspace-only",
        });
      },
      {
        workspaces: [{ id: "workspace-only", name: "Engineering", role: "owner", status: "active" }],
      },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

This test documents the workspace-key setup path without introducing a key-type fixture.

- [x] **Step 2: Run the targeted CLI workspace tests**

Run:

```bash
npm run build && node --import=tsx --test test/cli-workspaces.test.ts
```

Expected: all CLI workspace tests pass. If the new test fails because omitted `--workspace-id` is not auto-selected, update `src/runtime/workspace-configuration.ts` so `selectWorkspace` keeps this exact behavior:

```ts
function selectWorkspace(
  workspaces: Array<WorkspaceSummary & { id: string }>,
  workspaceId: string | undefined,
): (WorkspaceSummary & { id: string }) | undefined {
  if (workspaceId !== undefined) {
    return workspaces.find((workspace) => workspace.id === workspaceId);
  }
  return workspaces.length === 1 ? workspaces[0] : undefined;
}
```

- [x] **Step 3: Commit configure test hardening**

Run:

```bash
git add test/cli-workspaces.test.ts src/runtime/workspace-configuration.ts
git commit -m "test: cover single-workspace configure selection" -m "Co-authored-by: Codex <codex@openai.com>"
```

Expected: commit succeeds. If `src/runtime/workspace-configuration.ts` was unchanged, the commit should contain only the new test.

---

### Task 3: Update User And Design Documentation

**Files:**
- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md`

- [x] **Step 1: Update `INSTALL.md` workspace selection wording**

In `INSTALL.md`, replace the `### Workspace Selection` introductory paragraphs with:

```md
### Workspace Selection

NAMS supports workspace keys and admin keys. Both key scopes can list available
workspaces through NAMS. Workspace keys return exactly one workspace from that
list; admin keys may return multiple workspaces.

Gemini CLI and OpenCode can auto-select a workspace before memory starts when
NAMS returns exactly one valid workspace. Claude Code and Codex require a
configured workspace ID before memory requests run.
```

Replace:

```md
If you omit `--workspace-id`, the configure command writes the workspace
automatically only when NAMS returns a single valid workspace. When NAMS returns
multiple valid workspaces, the command prints the available choices and exits
without changing config.
```

with:

```md
If you omit `--workspace-id`, the configure command writes the workspace
automatically only when NAMS returns a single valid workspace. This is the
normal path for workspace keys. When NAMS returns multiple valid workspaces,
which is common for admin keys, the command prints the available choices and
exits without changing config until you pass one ID explicitly.
```

In the Gemini settings list, replace:

```md
- `NAMS_WORKSPACE_ID`: required for NAMS requests.
```

with:

```md
- `NAMS_WORKSPACE_ID`: optional for Gemini runtime auto-resolution when NAMS
  returns exactly one valid workspace; required when the key can see multiple
  workspaces.
```

- [x] **Step 2: Update `README.md` runtime paragraph**

In `README.md`, replace the runtime configuration paragraph under `### Runtime Configuration And Storage` with:

```md
Runtime configuration is JSON-first: `~/.nams/config.json`, optional project `.nams/config.json`, optional platform discovery such as Claude plugin user configuration, then final `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides. `apiKey` and a resolved `baseUrl` are required for NAMS requests; the standard service URL can be supplied by JSON config or platform configuration templates. NAMS supports workspace keys and admin keys. `nams-hooks` does not configure a key type; it uses the number of workspaces returned by NAMS to decide whether a workspace can be auto-selected. `workspaceId` is required unless the harness path supports workspace auto-resolution and NAMS returns exactly one valid workspace. Runtime state and logs are user-local under per-platform directories in `~/.nams/state/` and `~/.nams/logs/`.
```

- [x] **Step 3: Add an amendment note to the existing workspace-resolution spec**

In `docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md`, add this paragraph after the opening summary section that ends with "they do not negotiate workspace selection.":

```md
2026-06-08 amendment: NAMS now has workspace keys and admin keys. Both can call
`GET /v1/users/me/workspaces`; workspace keys always return one workspace and
admin keys may return multiple workspaces. `nams-hooks` intentionally does not
model key type. It infers behavior only from the count of valid workspace IDs
returned by the workspace list endpoint. See
`docs/superpowers/specs/2026-06-08-nams-key-scope-workspace-resolution-design.md`.
```

In the `## Workspace Resolution Flow` section, replace:

```md
4. If exactly one workspace is returned, store that workspace ID in local state and allow memory to proceed.
5. If multiple workspaces are returned and runtime interaction is supported for the harness, stop or block the first prompt with a user-visible list of workspace names, roles, statuses, and IDs.
6. If multiple workspaces are returned and runtime interaction is not supported, report a sanitized diagnostic and require install-time or config-time workspace selection.
```

with:

```md
4. If exactly one valid workspace is returned, store that workspace ID in local state and allow memory to proceed. This covers workspace keys and admin keys that can see one workspace.
5. If multiple valid workspaces are returned, require explicit workspace selection/configuration. This commonly covers admin keys with access to multiple workspaces.
6. If runtime interaction is supported for the harness, stop or block the first prompt with a user-visible list of workspace names, roles, statuses, and IDs.
7. If runtime interaction is not supported, report a sanitized diagnostic and require install-time or config-time workspace selection.
```

Then renumber the existing zero-workspace and request-failure items so the sequence remains ordered:

```md
8. If zero workspaces are returned, report a sanitized diagnostic and skip NAMS memory work.
9. If the workspace listing request fails, fail open for the agent harness and skip NAMS memory work for that turn.
```

- [x] **Step 4: Verify documentation contains the key-scope language**

Run:

```bash
rg -n "workspace keys|admin keys|key type|exactly one valid workspace|multiple valid workspaces|2026-06-08" README.md INSTALL.md docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md docs/superpowers/specs/2026-06-08-nams-key-scope-workspace-resolution-design.md
```

Expected: matches appear in README, INSTALL, both workspace specs, and no wording says users must configure a key type inside `nams-hooks`.

- [x] **Step 5: Commit documentation updates**

Run:

```bash
git add README.md INSTALL.md docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md
git commit -m "docs: explain key-scope workspace cardinality" -m "Co-authored-by: Codex <codex@openai.com>"
```

Expected: commit succeeds.

---

### Task 4: Final Integration Verification

**Files:**
- Verify only unless tests reveal missed updates.

- [x] **Step 1: Run full verification**

Run:

```bash
npm run check
```

Expected: OpenAPI generation is stable, TypeScript builds, test typecheck passes, and the full Node test suite passes.

- [x] **Step 2: Verify distribution artifacts still package correctly**

Run:

```bash
npm run dist
npm run dist:check
```

Expected: distribution build and packaged template checks pass.

- [x] **Step 3: Verify runtime source has no key-type model**

Run:

```bash
rg -n "keyType|adminKey|workspaceKey|admin-key|workspace-key" src scripts/generate-nams-client.mjs
```

Expected: no matches. The command exits `1` when no matches are found.

- [x] **Step 4: Verify workspace-list header behavior remains separated**

Run:

```bash
node --import=tsx --test test/nams-workspace-client-generator.test.ts
```

Expected: workspace client generator tests pass, including the assertion that `listMyWorkspaces` omits `X-Workspace-Id`.

- [x] **Step 5: Check for whitespace errors**

Run:

```bash
git diff --check
```

Expected: no output and exit code `0`.

- [x] **Step 6: Commit any final fixes**

If any verification step required a small correction, commit it:

```bash
git add README.md INSTALL.md docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md test/workspace-resolution.test.ts test/cli-workspaces.test.ts src/runtime/workspace-resolution.ts src/runtime/workspace-configuration.ts
git commit -m "fix: finalize key-scope workspace resolution" -m "Co-authored-by: Codex <codex@openai.com>"
```

If no files changed, skip this commit.

---

## Self-Review Checklist

- Spec coverage: the plan covers cardinality-only runtime behavior, configured workspace precedence without preflight validation, configure-command validation, key-scope-neutral diagnostics, docs, and final verification.
- Placeholder scan: the plan contains no placeholder markers or unspecified implementation steps.
- Type consistency: the plan keeps `NamsClient`, `NamsWorkspaceClient`, `workspaceId`, `WorkspaceSummary`, `resolveWorkspaceForMemory`, and `configureWorkspaceSelection` aligned with existing source names.
- Runtime dependency check: the plan does not add runtime npm dependencies.
- Safety check: the plan does not log API keys, bearer tokens, raw config contents, arbitrary exception text, or key-type labels.
