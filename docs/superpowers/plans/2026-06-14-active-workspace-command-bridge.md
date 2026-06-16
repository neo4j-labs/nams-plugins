# Active Workspace Command Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the active-session workspace command bridge for Gemini and Codex while keeping Claude and OpenCode on their existing direct session command path.

**Architecture:** Add a shared runtime helper that records short-lived active workspace-session markers under `~/.nams/state/<platform>/active-workspace-sessions.json`. Gemini records markers at `SessionStart` and refreshes them when workspace selection is required; Codex records markers when workspace selection is required. Their workspace adapters resolve the marker from a `CustomCommand` event and delegate to the existing session-scoped `configureWorkspaceSelection` runtime through the shared workspace-use command runner. Packaging adds a Gemini custom command and a Codex explicit skill while docs keep the explicit shell configure command as the stable fallback.

**Tech Stack:** TypeScript, Node.js built-ins only for runtime, Node `node:test`, Gemini extension command templates, Codex plugin skills, generated `dist/` checks.

---

## Source Documents

- Design: `docs/superpowers/specs/2026-06-11-slash-workspace-command-design.md`
- Existing Tier 1 plan: `docs/superpowers/plans/2026-06-11-slash-workspace-command.md`
- Session configure design: `docs/superpowers/specs/2026-06-10-session-workspace-selection-design.md`
- Research note to update: `docs/session-workspace-command-support.md`
- Architecture rules: `AGENTS.md`

## Scope Check

The design spans four platforms, but Claude and OpenCode command execution already exists on this branch. This plan focuses implementation on the shared active-session bridge plus Gemini and Codex command packaging. Claude and OpenCode changes are limited to verification and docs alignment.

## File Structure

- Create `src/runtime/active-workspace-session.ts`
  - Reads, writes, prunes, and resolves active workspace-session markers.
  - Owns TTL and newest-winner-gap constants.
  - Depends only on Node built-ins, `src/runtime/paths.ts`, `src/runtime/permissions.ts`, and shared platform types.
- Create `test/active-workspace-session.test.ts`
  - Covers marker shape, malformed files, TTL pruning, winner-gap resolution, platform/project isolation, and owner-only write behavior.
- Modify `src/interfaces.ts`
  - Adds typed workspace hook event `CustomCommand` and workspace adapter method `customCommand`.
- Modify `src/cli.ts`
  - Routes `CustomCommand` through the workspace adapter registry and updates usage text.
- Modify `src/runtime/workspace-use-command.ts`
  - Keeps direct session command behavior for Claude/OpenCode.
  - Adds bridge-backed command behavior for Gemini/Codex while reusing the existing selector parsing and configure delegation.
- Create `test/workspace-use-command.test.ts`
  - Unit-tests bridged command behavior without going through platform templates.
- Modify `src/platforms/gemini/index.ts`
  - Records active-session markers at `SessionStart` and refreshes them in the
    workspace-selection ambiguity path.
  - Adds `/nams:workspace use ...` guidance to the Gemini ambiguity notice by passing command lines into `formatWorkspaceSelectionNotice`.
- Modify `src/platforms/codex/index.ts`
  - Records active-session markers in the workspace-selection ambiguity path.
  - Adds `$nams:workspace use ...` guidance to the Codex ambiguity notice by passing command lines into `formatWorkspaceSelectionNotice`.
- Modify `test/gemini/gemini-memory-flow.test.ts`
  - Covers marker recording and Gemini notice guidance.
- Modify `test/codex/codex-memory-flow.test.ts`
  - Covers marker recording and Codex notice guidance.
- Modify `src/platforms/gemini/workspaces.ts`
  - Handles `CustomCommand` by resolving an active Gemini session and delegating to the shared runner.
- Modify `src/platforms/codex/workspaces.ts`
  - Handles `CustomCommand` by resolving an active Codex session and delegating to the shared runner.
- Modify `test/cli-workspaces.test.ts`
  - Adds end-to-end CLI tests for `workspaces run gemini --event CustomCommand` and `workspaces run codex --event CustomCommand`.
- Create `templates/gemini/commands/nams/workspace.toml`
  - Defines `/nams:workspace` and invokes bundled `bin/cli.js` through `workspaces run gemini --event CustomCommand`.
- Modify `test/gemini-template.test.ts`
  - Asserts the Gemini command asset exists and routes to `CustomCommand`.
- Modify `scripts/build-dist.mjs`
  - Copies Gemini command templates into `dist/commands/`.
- Modify `scripts/check-dist.mjs`
  - Verifies the Gemini command asset and packed files include it.
- Modify `templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json`
  - Adds `"skills": "./skills/"`.
- Create `templates/codex/plugins/codex-nams-hooks/skills/workspace/SKILL.md`
  - Defines explicit skill name `nams:workspace`.
- Create `templates/codex/plugins/codex-nams-hooks/skills/workspace/agents/openai.yaml`
  - Sets `policy.allow_implicit_invocation: false`.
- Modify `test/codex-template.test.ts`
  - Asserts Codex manifest and skill packaging.
- Modify `scripts/check-dist.mjs`
  - Verifies Codex skill files are present in `dist/` and packed output.
- Modify docs:
  - `README.md`
  - `INSTALL.md`
  - `docs/session-workspace-command-support.md`
  - `test/slash-workspace-docs.test.ts`

---

### Task 1: Shared Active Workspace Session Store

**Files:**
- Create: `src/runtime/active-workspace-session.ts`
- Create: `test/active-workspace-session.test.ts`

- [ ] **Step 1: Write the failing active-session store tests**

Create `test/active-workspace-session.test.ts` with:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ACTIVE_WORKSPACE_SESSION_TTL_MS,
  ACTIVE_WORKSPACE_SESSION_WINNER_GAP_MS,
  activeWorkspaceSessionsPath,
  recordActiveWorkspaceSession,
  resolveActiveWorkspaceSession,
} from "../src/runtime/active-workspace-session.js";

function env(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
}

async function readMarker(homeDir: string, platform: "gemini" | "codex"): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(homeDir, ".nams", "state", platform, "active-workspace-sessions.json"), "utf8"));
}

test("records active workspace session markers without version metadata", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-active-session-project-"));
  const homeDir = path.join(projectDir, "home");
  try {
    await recordActiveWorkspaceSession({
      platform: "gemini",
      sessionId: "gemini-session-1",
      sessionKey: "gemini-session-1",
      projectDirectory: projectDir,
      statePath: path.join(homeDir, ".nams", "state", "gemini", "session-file.json"),
      touchedAt: new Date("2026-06-14T10:00:00.000Z"),
      environment: env(homeDir),
    });

    const marker = await readMarker(homeDir, "gemini");
    assert.deepEqual(Object.keys(marker).sort(), ["sessions"]);
    assert.equal(marker.sessions.length, 1);
    assert.deepEqual(marker.sessions[0], {
      sessionId: "gemini-session-1",
      sessionKey: "gemini-session-1",
      projectDirectory: path.resolve(projectDir),
      statePath: path.join(homeDir, ".nams", "state", "gemini", "session-file.json"),
      touchedAt: "2026-06-14T10:00:00.000Z",
    });

    const fileMode = (await stat(activeWorkspaceSessionsPath("gemini", env(homeDir)))).mode & 0o777;
    assert.equal(fileMode, 0o600);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("treats malformed marker files as empty and rewrites clean shape", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-active-session-project-"));
  const homeDir = path.join(projectDir, "home");
  const markerPath = path.join(homeDir, ".nams", "state", "gemini", "active-workspace-sessions.json");
  try {
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, "{\"sessions\":", { encoding: "utf8", mode: 0o600 });

    const missing = await resolveActiveWorkspaceSession({
      platform: "gemini",
      projectDirectory: projectDir,
      now: new Date("2026-06-14T10:00:30.000Z"),
      environment: env(homeDir),
    });
    assert.deepEqual(missing, { status: "missing" });

    await recordActiveWorkspaceSession({
      platform: "gemini",
      sessionId: "gemini-session-1",
      sessionKey: "gemini-session-1",
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T10:00:31.000Z"),
      environment: env(homeDir),
    });
    const marker = await readMarker(homeDir, "gemini");
    assert.equal(marker.sessions.length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("resolves exactly one fresh active session and prunes stale records", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-active-session-project-"));
  const homeDir = path.join(projectDir, "home");
  try {
    await recordActiveWorkspaceSession({
      platform: "gemini",
      sessionId: "old-session",
      sessionKey: "old-session",
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T09:58:00.000Z"),
      environment: env(homeDir),
    });
    await recordActiveWorkspaceSession({
      platform: "gemini",
      sessionId: "fresh-session",
      sessionKey: "fresh-session",
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T10:00:00.000Z"),
      environment: env(homeDir),
    });

    const resolved = await resolveActiveWorkspaceSession({
      platform: "gemini",
      projectDirectory: projectDir,
      now: new Date("2026-06-14T10:00:30.000Z"),
      environment: env(homeDir),
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.status === "resolved" ? resolved.sessionId : "", "fresh-session");

    const marker = await readMarker(homeDir, "gemini");
    assert.deepEqual(marker.sessions.map((session: Record<string, unknown>) => session.sessionId), ["fresh-session"]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("resolves newest fresh session only when it clears the winner gap", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-active-session-project-"));
  const homeDir = path.join(projectDir, "home");
  try {
    await recordActiveWorkspaceSession({
      platform: "codex",
      sessionId: "runner-up",
      sessionKey: "runner-up",
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T10:00:00.000Z"),
      environment: env(homeDir),
    });
    await recordActiveWorkspaceSession({
      platform: "codex",
      sessionId: "winner",
      sessionKey: "winner",
      projectDirectory: projectDir,
      touchedAt: new Date(+(new Date("2026-06-14T10:00:00.000Z")) + ACTIVE_WORKSPACE_SESSION_WINNER_GAP_MS),
      environment: env(homeDir),
    });

    const resolved = await resolveActiveWorkspaceSession({
      platform: "codex",
      projectDirectory: projectDir,
      now: new Date("2026-06-14T10:00:30.000Z"),
      environment: env(homeDir),
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.status === "resolved" ? resolved.sessionId : "", "winner");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("fails closed for fresh sessions that do not clear the winner gap", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-active-session-project-"));
  const homeDir = path.join(projectDir, "home");
  try {
    await recordActiveWorkspaceSession({
      platform: "codex",
      sessionId: "first",
      sessionKey: "first",
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T10:00:00.000Z"),
      environment: env(homeDir),
    });
    await recordActiveWorkspaceSession({
      platform: "codex",
      sessionId: "second",
      sessionKey: "second",
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T10:00:14.999Z"),
      environment: env(homeDir),
    });

    const resolved = await resolveActiveWorkspaceSession({
      platform: "codex",
      projectDirectory: projectDir,
      now: new Date("2026-06-14T10:00:30.000Z"),
      environment: env(homeDir),
    });
    assert.equal(resolved.status, "ambiguous");
    assert.equal(resolved.status === "ambiguous" ? resolved.candidates.length : 0, 2);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("keeps platform and project markers isolated", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-active-session-project-"));
  const otherProjectDir = await mkdtemp(path.join(tmpdir(), "nams-active-session-other-"));
  const homeDir = path.join(projectDir, "home");
  try {
    await recordActiveWorkspaceSession({
      platform: "gemini",
      sessionId: "gemini-session",
      sessionKey: "gemini-session",
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T10:00:00.000Z"),
      environment: env(homeDir),
    });
    await recordActiveWorkspaceSession({
      platform: "codex",
      sessionId: "codex-session",
      sessionKey: "codex-session",
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T10:00:00.000Z"),
      environment: env(homeDir),
    });

    assert.equal((await resolveActiveWorkspaceSession({
      platform: "gemini",
      projectDirectory: projectDir,
      now: new Date("2026-06-14T10:00:30.000Z"),
      environment: env(homeDir),
    })).status, "resolved");
    assert.equal((await resolveActiveWorkspaceSession({
      platform: "gemini",
      projectDirectory: otherProjectDir,
      now: new Date("2026-06-14T10:00:30.000Z"),
      environment: env(homeDir),
    })).status, "missing");
    assert.equal((await resolveActiveWorkspaceSession({
      platform: "codex",
      projectDirectory: projectDir,
      now: new Date("2026-06-14T10:00:30.000Z"),
      environment: env(homeDir),
    })).status, "resolved");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(otherProjectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
node --import=tsx --test test/active-workspace-session.test.ts
```

Expected: FAIL because `src/runtime/active-workspace-session.ts` does not exist.

- [ ] **Step 3: Implement the active-session helper**

Create `src/runtime/active-workspace-session.ts` with:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../interfaces.js";
import { RuntimeEnvironment, type RuntimeEnvironmentInput } from "./paths.js";
import { writePrivateFile } from "./permissions.js";

export const ACTIVE_WORKSPACE_SESSION_TTL_MS = 60_000;
export const ACTIVE_WORKSPACE_SESSION_WINNER_GAP_MS = 15_000;

export interface ActiveWorkspaceSessionRecord {
  sessionId: string;
  sessionKey: string;
  projectDirectory: string;
  statePath?: string;
  touchedAt: string;
}

export interface RecordActiveWorkspaceSessionInput {
  platform: Platform;
  sessionId?: string;
  sessionKey: string;
  projectDirectory: string;
  statePath?: string;
  touchedAt?: Date;
  environment?: RuntimeEnvironmentInput;
}

export interface ResolveActiveWorkspaceSessionInput {
  platform: Platform;
  projectDirectory: string;
  now?: Date;
  ttlMs?: number;
  winnerGapMs?: number;
  environment?: RuntimeEnvironmentInput;
}

export type ActiveWorkspaceSessionResolution =
  | { status: "resolved"; sessionId: string; sessionKey: string; projectDirectory: string; statePath?: string }
  | { status: "missing" }
  | { status: "ambiguous"; candidates: ActiveWorkspaceSessionRecord[] };

interface ActiveWorkspaceSessionMarker {
  sessions: ActiveWorkspaceSessionRecord[];
}

export function activeWorkspaceSessionsPath(
  platform: Platform,
  environment: RuntimeEnvironmentInput = process.env,
): string {
  return path.join(RuntimeEnvironment.from(environment).sessionStateDirectory(platform), "active-workspace-sessions.json");
}

export async function recordActiveWorkspaceSession(input: RecordActiveWorkspaceSessionInput): Promise<void> {
  const sessionId = input.sessionId?.trim() ?? "";
  const sessionKey = input.sessionKey.trim();
  if (sessionId === "" || sessionKey === "") {
    return;
  }

  const now = input.touchedAt ?? new Date();
  const markerPath = activeWorkspaceSessionsPath(input.platform, input.environment);
  const existing = await readMarker(markerPath);
  const cutoff = now.getTime() - ACTIVE_WORKSPACE_SESSION_TTL_MS;
  const projectDirectory = normalizeProjectDirectory(input.projectDirectory);
  const record: ActiveWorkspaceSessionRecord = {
    sessionId,
    sessionKey,
    projectDirectory,
    ...(input.statePath !== undefined && input.statePath.trim() !== "" ? { statePath: input.statePath } : {}),
    touchedAt: now.toISOString(),
  };

  const sessions = existing.sessions.filter((session) => {
    const touchedAt = Date.parse(session.touchedAt);
    if (!Number.isFinite(touchedAt) || touchedAt < cutoff) {
      return false;
    }
    return !(session.sessionKey === sessionKey && session.projectDirectory === projectDirectory);
  });
  sessions.push(record);

  await writeMarker(markerPath, { sessions });
}

export async function resolveActiveWorkspaceSession(
  input: ResolveActiveWorkspaceSessionInput,
): Promise<ActiveWorkspaceSessionResolution> {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? ACTIVE_WORKSPACE_SESSION_TTL_MS;
  const winnerGapMs = input.winnerGapMs ?? ACTIVE_WORKSPACE_SESSION_WINNER_GAP_MS;
  const markerPath = activeWorkspaceSessionsPath(input.platform, input.environment);
  const marker = await readMarker(markerPath);
  const projectDirectory = normalizeProjectDirectory(input.projectDirectory);
  const cutoff = now.getTime() - ttlMs;
  const fresh = marker.sessions
    .filter((session) => {
      const touchedAt = Date.parse(session.touchedAt);
      return Number.isFinite(touchedAt) && touchedAt >= cutoff && session.projectDirectory === projectDirectory;
    })
    .sort((left, right) => Date.parse(right.touchedAt) - Date.parse(left.touchedAt));

  if (fresh.length !== marker.sessions.length) {
    await writeMarker(markerPath, { sessions: fresh });
  }

  if (fresh.length === 0) {
    return { status: "missing" };
  }
  if (fresh.length === 1) {
    return resolvedSession(fresh[0]);
  }

  const newest = fresh[0];
  const runnerUp = fresh[1];
  if (Date.parse(newest.touchedAt) - Date.parse(runnerUp.touchedAt) >= winnerGapMs) {
    return resolvedSession(newest);
  }

  return { status: "ambiguous", candidates: fresh };
}

async function readMarker(markerPath: string): Promise<ActiveWorkspaceSessionMarker> {
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as { sessions?: unknown };
    if (!Array.isArray(parsed.sessions)) {
      return { sessions: [] };
    }
    return {
      sessions: parsed.sessions.flatMap((value) => {
        const record = validRecord(value);
        return record === undefined ? [] : [record];
      }),
    };
  } catch {
    return { sessions: [] };
  }
}

async function writeMarker(markerPath: string, marker: ActiveWorkspaceSessionMarker): Promise<void> {
  await writePrivateFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}

function validRecord(value: unknown): ActiveWorkspaceSessionRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim() === "" ||
    typeof record.sessionKey !== "string" ||
    record.sessionKey.trim() === "" ||
    typeof record.projectDirectory !== "string" ||
    record.projectDirectory.trim() === "" ||
    typeof record.touchedAt !== "string" ||
    !Number.isFinite(Date.parse(record.touchedAt))
  ) {
    return undefined;
  }
  return {
    sessionId: record.sessionId.trim(),
    sessionKey: record.sessionKey.trim(),
    projectDirectory: normalizeProjectDirectory(record.projectDirectory),
    ...(typeof record.statePath === "string" && record.statePath.trim() !== "" ? { statePath: record.statePath } : {}),
    touchedAt: new Date(record.touchedAt).toISOString(),
  };
}

function resolvedSession(record: ActiveWorkspaceSessionRecord): ActiveWorkspaceSessionResolution {
  return {
    status: "resolved",
    sessionId: record.sessionId,
    sessionKey: record.sessionKey,
    projectDirectory: record.projectDirectory,
    ...(record.statePath !== undefined ? { statePath: record.statePath } : {}),
  };
}

function normalizeProjectDirectory(projectDirectory: string): string {
  return path.resolve(projectDirectory);
}
```

- [ ] **Step 4: Run the active-session tests**

Run:

```bash
node --import=tsx --test test/active-workspace-session.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the shared bridge helper**

Run:

```bash
git add src/runtime/active-workspace-session.ts test/active-workspace-session.test.ts
git commit -m "feat: add active workspace session bridge" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Typed CustomCommand Event And Bridged Runner

**Files:**
- Modify: `src/interfaces.ts`
- Modify: `src/cli.ts`
- Modify: `src/runtime/workspace-use-command.ts`
- Create: `test/workspace-use-command.test.ts`
- Modify: `test/cli-workspaces.test.ts`

- [ ] **Step 1: Write failing unit tests for bridge-backed command execution**

Create `test/workspace-use-command.test.ts` with:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { WorkspaceHookInvocation } from "../src/interfaces.js";
import { recordActiveWorkspaceSession } from "../src/runtime/active-workspace-session.js";
import { runActiveSessionWorkspaceUseCommand } from "../src/runtime/workspace-use-command.js";

async function withWorkspaceServer<T>(handler: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/v1/users/me/workspaces") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        workspaces: [
          { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
          { id: "workspace-2", name: "Research Team", role: "member", status: "active" },
        ],
      }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    return await handler(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function invocation(projectDir: string): WorkspaceHookInvocation<"CustomCommand"> {
  return {
    platform: "gemini",
    event: "CustomCommand",
    rawPayload: {},
    processCwd: projectDir,
  };
}

test("bridged workspace command configures resolved active session", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-use-"));
  const homeDir = path.join(projectDir, "home");
  try {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await withWorkspaceServer(async (baseUrl) => {
      await writeFile(path.join(projectDir, ".nams", "config.json"), JSON.stringify({
        apiKey: "test-api-key",
        baseUrl,
      }), "utf8");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;

      await recordActiveWorkspaceSession({
        platform: "gemini",
        sessionId: "gemini-session-1",
        sessionKey: "gemini-session-1",
        projectDirectory: projectDir,
        touchedAt: new Date("2026-06-14T10:00:00.000Z"),
      });

      const result = await runActiveSessionWorkspaceUseCommand(invocation(projectDir), {
        commandName: "nams:workspace",
        arguments: "use Research Team",
        projectDirectory: projectDir,
        sessionLabel: "Gemini",
      });

      assert.equal(result.status, "completed");
      assert.equal(result.status === "completed" ? result.code : 1, 0);
      assert.match(result.status === "completed" ? result.stdout : "", /NAMS workspace configured for gemini session gemini-session-1: workspace-2/);
      const stateDir = path.join(homeDir, ".nams", "state", "gemini");
      const stateFiles = (await import("node:fs/promises")).readdir(stateDir);
      assert.equal((await stateFiles).filter((file) => file.startsWith("session-")).length, 1);
      const stateFile = (await stateFiles).find((file) => file.startsWith("session-"))!;
      const state = JSON.parse(await readFile(path.join(stateDir, stateFile), "utf8"));
      assert.equal(state.workspace.id, "workspace-2");
      assert.equal(state.workspace.source, "session-selection");
    });
  } finally {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("bridged workspace command fails closed when active session is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-use-"));
  const homeDir = path.join(projectDir, "home");
  try {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const result = await runActiveSessionWorkspaceUseCommand(invocation(projectDir), {
      commandName: "nams:workspace",
      arguments: "use Engineering",
      projectDirectory: projectDir,
      sessionLabel: "Gemini",
    });

    assert.deepEqual(result, {
      status: "completed",
      code: 1,
      stdout: "",
      stderr: "Gemini session id is unavailable; no recent active NAMS workspace session matched this project.\nRun manually: nams-hooks workspaces configure gemini --scope session --session-id <session-id> --workspace Engineering",
    });
  } finally {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("bridged workspace command fails closed when active session is ambiguous", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-use-"));
  const homeDir = path.join(projectDir, "home");
  try {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    await recordActiveWorkspaceSession({
      platform: "gemini",
      sessionId: "first-session",
      sessionKey: "first-session",
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T10:00:00.000Z"),
    });
    await recordActiveWorkspaceSession({
      platform: "gemini",
      sessionId: "second-session",
      sessionKey: "second-session",
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T10:00:14.999Z"),
    });

    const result = await runActiveSessionWorkspaceUseCommand(invocation(projectDir), {
      commandName: "nams:workspace",
      arguments: "use Engineering",
      projectDirectory: projectDir,
      sessionLabel: "Gemini",
    });

    assert.equal(result.status, "completed");
    assert.equal(result.status === "completed" ? result.code : 0, 1);
    assert.match(result.status === "completed" ? result.stderr : "", /multiple recent active NAMS workspace sessions matched this project/);
    assert.match(result.status === "completed" ? result.stderr : "", /--session-id <session-id> --workspace Engineering/);
  } finally {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Add failing CLI usage expectations**

In `test/cli-workspaces.test.ts`, update the unsupported event test to expect `CustomCommand` in usage:

```ts
assert.match(
  result.stderr,
  /workspaces run <gemini\|claude\|codex\|opencode> --event <BeforeAgent\|InstallConfigure\|UserPromptExpansion\|CommandExecuteBefore\|CustomCommand>/,
);
```

- [ ] **Step 3: Run the targeted tests to verify they fail**

Run:

```bash
node --import=tsx --test test/workspace-use-command.test.ts test/cli-workspaces.test.ts
```

Expected: FAIL because `CustomCommand` and `runActiveSessionWorkspaceUseCommand` do not exist yet.

- [ ] **Step 4: Add the typed CustomCommand contract**

In `src/interfaces.ts`, replace the workspace event declaration and adapter interface with:

```ts
export const workspaceHookEvents = [
  "BeforeAgent",
  "InstallConfigure",
  "UserPromptExpansion",
  "CommandExecuteBefore",
  "CustomCommand",
] as const;
export type WorkspaceHookEvent = (typeof workspaceHookEvents)[number];

export interface WorkspacePlatformAdapter {
  beforeAgent?(invocation: WorkspaceHookInvocation<"BeforeAgent">): Promise<WorkspaceHookResult>;
  installConfigure?(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<WorkspaceHookResult>;
  userPromptExpansion?(invocation: WorkspaceHookInvocation<"UserPromptExpansion">): Promise<WorkspaceHookResult>;
  commandExecuteBefore?(invocation: WorkspaceHookInvocation<"CommandExecuteBefore">): Promise<WorkspaceHookResult>;
  customCommand?(invocation: WorkspaceHookInvocation<"CustomCommand">): Promise<WorkspaceHookResult>;
}
```

In `src/cli.ts`, add a route branch:

```ts
    case "CustomCommand":
      return adapter.customCommand?.({ ...invocation, event: "CustomCommand" }) ?? allowHook();
```

Also update the workspace usage line in `src/cli.ts` to:

```ts
"       nams-hooks workspaces run <gemini|claude|codex|opencode> --event <BeforeAgent|InstallConfigure|UserPromptExpansion|CommandExecuteBefore|CustomCommand>",
```

- [ ] **Step 5: Add the bridged command runner**

Modify `src/runtime/workspace-use-command.ts` so selector parsing and configure delegation are shared by both direct and bridge-backed commands:

```ts
import type { WorkspaceHookInvocation } from "../interfaces.js";
import { resolveActiveWorkspaceSession } from "./active-workspace-session.js";
import { configureWorkspaceSelection } from "./workspace-configuration.js";

const workspaceCommandName = "nams:workspace";
const workspaceCommandUsage = "Usage: /nams:workspace use <workspace-id-or-name>";

export type WorkspaceUseCommandResult =
  | { status: "ignored" }
  | { status: "completed"; code: number; stdout: string; stderr: string };

export interface WorkspaceUseCommandInput {
  commandName?: string;
  arguments: unknown;
  sessionId?: string;
  invalidSubcommandMode: "ignore" | "usage";
  sessionLabel: string;
}

export interface ActiveSessionWorkspaceUseCommandInput {
  commandName?: string;
  arguments: unknown;
  projectDirectory: string;
  sessionLabel: string;
}

export async function runSessionWorkspaceUseCommand(
  invocation: WorkspaceHookInvocation,
  input: WorkspaceUseCommandInput,
): Promise<WorkspaceUseCommandResult> {
  const parsed = parseWorkspaceUseCommand(input.commandName, input.arguments, input.invalidSubcommandMode);
  if (parsed.status !== "ok") {
    return parsed.status === "ignored" ? parsed : commandFailure(workspaceCommandUsage);
  }

  const sessionId = input.sessionId?.trim() ?? "";
  if (sessionId === "") {
    return commandFailure([
      `${input.sessionLabel} session id is unavailable; cannot configure a session workspace automatically.`,
      `Run manually: nams-hooks workspaces configure ${invocation.platform} --scope session --session-id <session-id> --workspace ${shellQuote(parsed.selector)}`,
    ].join("\n"));
  }

  return configureSessionWorkspace(invocation, sessionId, parsed.selector);
}

export async function runActiveSessionWorkspaceUseCommand(
  invocation: WorkspaceHookInvocation,
  input: ActiveSessionWorkspaceUseCommandInput,
): Promise<WorkspaceUseCommandResult> {
  const parsed = parseWorkspaceUseCommand(input.commandName, input.arguments, "usage");
  if (parsed.status !== "ok") {
    return parsed.status === "ignored" ? parsed : commandFailure(workspaceCommandUsage);
  }

  const resolution = await resolveActiveWorkspaceSession({
    platform: invocation.platform,
    projectDirectory: input.projectDirectory,
  });
  if (resolution.status !== "resolved") {
    const reason = resolution.status === "ambiguous"
      ? "multiple recent active NAMS workspace sessions matched this project"
      : "no recent active NAMS workspace session matched this project";
    return commandFailure([
      `${input.sessionLabel} session id is unavailable; ${reason}.`,
      `Run manually: nams-hooks workspaces configure ${invocation.platform} --scope session --session-id <session-id> --workspace ${shellQuote(parsed.selector)}`,
    ].join("\n"));
  }

  return configureSessionWorkspace(invocation, resolution.sessionId, parsed.selector);
}

async function configureSessionWorkspace(
  invocation: WorkspaceHookInvocation,
  sessionId: string,
  selector: string,
): Promise<WorkspaceUseCommandResult> {
  const configureResult = await configureWorkspaceSelection({
    ...invocation,
    event: "InstallConfigure",
    rawPayload: {
      scope: "session",
      sessionId,
      workspace: selector,
    },
  });
  const code = typeof configureResult.stdout.exitCode === "number" ? configureResult.stdout.exitCode : 0;
  const message = typeof configureResult.stdout.message === "string"
    ? configureResult.stdout.message
    : JSON.stringify(configureResult.stdout);

  return {
    status: "completed",
    code,
    stdout: code === 0 ? message : "",
    stderr: code === 0 ? "" : message,
  };
}

function parseWorkspaceUseCommand(
  commandName: string | undefined,
  argumentValue: unknown,
  invalidSubcommandMode: "ignore" | "usage",
): { status: "ok"; selector: string } | { status: "ignored" } | { status: "invalid" } {
  if (commandName !== workspaceCommandName) {
    return { status: "ignored" };
  }

  const selectorResult = workspaceSelectorFromArguments(argumentValue);
  if (selectorResult.status === "invalid") {
    return invalidSubcommandMode === "ignore" ? { status: "ignored" } : { status: "invalid" };
  }
  if (selectorResult.selector === "") {
    return { status: "invalid" };
  }
  return selectorResult;
}
```

Keep the existing `workspaceSelectorFromArguments`, `commandFailure`, and `shellQuote` helpers in the same file. If TypeScript reports duplicate code from the old `runSessionWorkspaceUseCommand`, remove the old body and use the replacement above.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
node --import=tsx --test test/workspace-use-command.test.ts test/cli-workspaces.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit event and runner changes**

Run:

```bash
git add src/interfaces.ts src/cli.ts src/runtime/workspace-use-command.ts test/workspace-use-command.test.ts test/cli-workspaces.test.ts
git commit -m "feat: add custom workspace command runner" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Record Gemini And Codex Ambiguity Markers

**Files:**
- Modify: `src/platforms/gemini/index.ts`
- Modify: `src/platforms/codex/index.ts`
- Modify: `test/gemini/gemini-memory-flow.test.ts`
- Modify: `test/codex/codex-memory-flow.test.ts`

- [ ] **Step 1: Add failing Gemini marker and notice expectations**

In `test/gemini/gemini-memory-flow.test.ts`, update `Gemini BeforeAgent notifies and continues when multiple workspaces are available` with these assertions before the `finally` block:

```ts
assert.match(String(result.stdout.systemMessage), /\/nams:workspace use <workspace-id-or-name>/);
const markerPath = path.join(namsHome(projectDir), "state", "gemini", "active-workspace-sessions.json");
const marker = JSON.parse(await readFile(markerPath, "utf8"));
assert.equal(marker.sessions.length, 1);
assert.equal(marker.sessions[0].sessionId, "session-1");
assert.equal(marker.sessions[0].sessionKey, "session-1");
assert.equal(marker.sessions[0].projectDirectory, path.resolve(projectDir));
assert.equal(typeof marker.sessions[0].touchedAt, "string");
assert.equal(Object.hasOwn(marker, "version"), false);
```

- [ ] **Step 2: Add failing Codex marker and notice expectations**

In `test/codex/codex-memory-flow.test.ts`, update `Codex beforeAgent skips memory when multiple listed workspaces require selection`:

Replace the existing negative `/nams:workspace` assertion with:

```ts
assert.match(hookSpecificOutput(result).additionalContext, /\$nams:workspace use <workspace-id-or-name>/);
```

Add marker assertions before the `finally` block:

```ts
const markerPath = path.join(namsHome(projectDir), "state", "codex", "active-workspace-sessions.json");
const marker = JSON.parse(await readFile(markerPath, "utf8"));
assert.equal(marker.sessions.length, 1);
assert.equal(marker.sessions[0].sessionId, "session-1");
assert.equal(marker.sessions[0].sessionKey, "session-1");
assert.equal(marker.sessions[0].projectDirectory, path.resolve(projectDir));
assert.equal(typeof marker.sessions[0].touchedAt, "string");
assert.equal(Object.hasOwn(marker, "version"), false);
```

- [ ] **Step 3: Run memory-flow tests to verify they fail**

Run:

```bash
node --import=tsx --test test/gemini/gemini-memory-flow.test.ts test/codex/codex-memory-flow.test.ts
```

Expected: FAIL because marker files and new command notice lines are not written yet.

- [ ] **Step 4: Implement Gemini marker recording**

In `src/platforms/gemini/index.ts`, add imports:

```ts
import { recordActiveWorkspaceSession } from "../../runtime/active-workspace-session.js";
import { sessionStatePath } from "../../runtime/paths.js";
```

In `beforeAgent`, replace the not-ready block with:

```ts
    if (workspaceResult.status !== "ready") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      if (workspaceResult.reason === "selection-required") {
        await recordSelectionRequiredWorkspaceSession(invocation, state, payloadInfo.projectDirectory, payloadInfo.sessionId);
      }
      return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
    }
```

Replace `workspaceResultOutput` with:

```ts
function workspaceResultOutput(
  result: Exclude<WorkspaceResolutionResult, { status: "ready" }>,
  sessionId?: string,
): HookResult {
  if (result.reason === "selection-required") {
    const message = formatWorkspaceSelectionNotice("gemini", result.workspaces, sessionId, [
      "Select a session workspace with: /nams:workspace use <workspace-id-or-name>",
    ]);
    return {
      stdout: {
        continue: true,
        suppressOutput: false,
        systemMessage: message,
        hookSpecificOutput: {
          additionalContext: message,
        },
      },
    };
  }
  return allowOutput();
}
```

Add this helper near `workspaceResultOutput`:

```ts
async function recordSelectionRequiredWorkspaceSession(
  invocation: HookInvocation,
  state: SessionState,
  projectDirectory: string,
  sessionId?: string,
): Promise<void> {
  try {
    await recordActiveWorkspaceSession({
      platform: invocation.platform,
      sessionId,
      sessionKey: state.sessionKey,
      projectDirectory,
      statePath: sessionStatePath(invocation.platform, state.sessionKey, state.createdAt),
    });
  } catch {
    return;
  }
}
```

- [ ] **Step 5: Implement Codex marker recording**

In `src/platforms/codex/index.ts`, add imports:

```ts
import { recordActiveWorkspaceSession } from "../../runtime/active-workspace-session.js";
import { sessionStatePath } from "../../runtime/paths.js";
```

In `beforeAgent`, replace the not-ready block with:

```ts
    if (workspaceResult.status !== "ready") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      if (workspaceResult.reason === "selection-required") {
        await recordSelectionRequiredWorkspaceSession(invocation, state, payloadInfo.projectDirectory, payloadInfo.sessionId);
      }
      return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
    }
```

Replace `workspaceResultOutput` with:

```ts
function workspaceResultOutput(
  result: Exclude<WorkspaceResolutionResult, { status: "ready" }>,
  sessionId?: string,
): HookResult {
  if (result.reason === "selection-required") {
    return allowOutput(formatWorkspaceSelectionNotice("codex", result.workspaces, sessionId, [
      "Select a session workspace with: $nams:workspace use <workspace-id-or-name>",
    ]));
  }
  return allowOutput();
}
```

Add this helper near `workspaceResultOutput`:

```ts
async function recordSelectionRequiredWorkspaceSession(
  invocation: HookInvocation,
  state: SessionState,
  projectDirectory: string,
  sessionId?: string,
): Promise<void> {
  try {
    await recordActiveWorkspaceSession({
      platform: invocation.platform,
      sessionId,
      sessionKey: state.sessionKey,
      projectDirectory,
      statePath: sessionStatePath(invocation.platform, state.sessionKey, state.createdAt),
    });
  } catch {
    return;
  }
}
```

- [ ] **Step 6: Run memory-flow tests**

Run:

```bash
node --import=tsx --test test/gemini/gemini-memory-flow.test.ts test/codex/codex-memory-flow.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run architecture tests**

Run:

```bash
node --import=tsx --test test/architecture.test.ts
```

Expected: PASS. In particular, `src/platforms/workspace-selection.ts` must still avoid branching by platform.

- [ ] **Step 8: Commit marker recording**

Run:

```bash
git add src/platforms/gemini/index.ts src/platforms/codex/index.ts test/gemini/gemini-memory-flow.test.ts test/codex/codex-memory-flow.test.ts
git commit -m "feat: record active workspace sessions" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Gemini CustomCommand Adapter And CLI Flow

**Files:**
- Modify: `src/platforms/gemini/workspaces.ts`
- Modify: `test/cli-workspaces.test.ts`

- [ ] **Step 1: Add failing Gemini CustomCommand CLI test**

In `test/cli-workspaces.test.ts`, add this test after the OpenCode command test:

```ts
test("workspaces run gemini CustomCommand configures the resolved active session workspace", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        await mkdir(path.join(projectDir, ".nams"), { recursive: true });
        await mkdir(path.join(homeDir, ".nams", "state", "gemini"), { recursive: true });
        await writeFile(path.join(projectDir, ".nams", "config.json"), JSON.stringify({
          apiKey: "test-api-key",
          baseUrl,
        }), "utf8");
        await writeFile(
          path.join(homeDir, ".nams", "state", "gemini", "active-workspace-sessions.json"),
          `${JSON.stringify({
            sessions: [{
              sessionId: "gemini-session-1",
              sessionKey: "gemini-session-1",
              projectDirectory: projectDir,
              touchedAt: new Date().toISOString(),
            }],
          }, null, 2)}\n`,
          "utf8",
        );

        const result = await runCli(
          ["workspaces", "run", "gemini", "--event", "CustomCommand"],
          {
            command_name: "nams:workspace",
            command_args: "use Engineering Team",
          },
          runtimeEnv(homeDir, baseUrl),
          projectDir,
        );

        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, "");
        const stdout = JSON.parse(result.stdout);
        assert.equal(stdout.continue, true);
        assert.equal(stdout.suppressOutput, false);
        assert.equal(stdout.exitCode, 0);
        assert.match(stdout.message, /NAMS workspace configured for gemini session gemini-session-1: workspace-2/);

        const state = await readOnlySessionState(homeDir, "gemini");
        assert.equal(state.harness, "gemini");
        assert.equal(state.harnessSessionId, "gemini-session-1");
        assert.equal(state.workspace.id, "workspace-2");
        assert.equal(state.workspace.source, "session-selection");
      },
      {
        workspaces: [
          { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
          { id: "workspace-2", name: "Engineering Team", role: "member", status: "active" },
        ],
      },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Add failing Gemini missing-session CLI test**

Add:

```ts
test("workspaces run gemini CustomCommand fails closed without an active session", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  try {
    const result = await runCli(
      ["workspaces", "run", "gemini", "--event", "CustomCommand"],
      {
        command_name: "nams:workspace",
        command_args: "use Engineering",
      },
      runtimeEnv(path.join(projectDir, "home"), "http://127.0.0.1:9"),
      projectDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.continue, false);
    assert.equal(stdout.exitCode, 1);
    assert.match(stdout.message, /Gemini session id is unavailable/);
    assert.match(stdout.message, /--session-id <session-id> --workspace Engineering/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run Gemini CLI tests to verify they fail**

Run:

```bash
npm run build
node --import=tsx --test test/cli-workspaces.test.ts
```

Expected: FAIL because `GeminiWorkspaceAdapter.customCommand` is not implemented.

- [ ] **Step 4: Implement Gemini CustomCommand**

Replace `src/platforms/gemini/workspaces.ts` with:

```ts
import type { WorkspaceHookInvocation, WorkspaceHookResult, WorkspacePlatformAdapter } from "../../interfaces.js";
import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
import { runActiveSessionWorkspaceUseCommand } from "../../runtime/workspace-use-command.js";

export class GeminiWorkspaceAdapter implements WorkspacePlatformAdapter {
  async installConfigure(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<WorkspaceHookResult> {
    return configureWorkspaceSelection(invocation);
  }

  async customCommand(invocation: WorkspaceHookInvocation<"CustomCommand">): Promise<WorkspaceHookResult> {
    const result = await runActiveSessionWorkspaceUseCommand(invocation, {
      commandName: stringValue(invocation.rawPayload.command_name),
      arguments: invocation.rawPayload.command_args,
      projectDirectory: invocation.processCwd,
      sessionLabel: "Gemini",
    });

    if (result.status === "ignored") {
      return { stdout: { continue: true, suppressOutput: true } };
    }

    const message = result.code === 0 ? result.stdout : result.stderr;
    return {
      stdout: {
        continue: result.code === 0,
        suppressOutput: false,
        exitCode: result.code,
        message,
      },
    };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
```

- [ ] **Step 5: Run Gemini CLI tests**

Run:

```bash
npm run build
node --import=tsx --test test/cli-workspaces.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Gemini command adapter**

Run:

```bash
git add src/platforms/gemini/workspaces.ts test/cli-workspaces.test.ts
git commit -m "feat: handle gemini workspace custom command" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Codex CustomCommand Adapter And CLI Flow

**Files:**
- Modify: `src/platforms/codex/workspaces.ts`
- Modify: `test/cli-workspaces.test.ts`

- [ ] **Step 1: Add failing Codex CustomCommand CLI test**

In `test/cli-workspaces.test.ts`, add:

```ts
test("workspaces run codex CustomCommand configures the resolved active session workspace", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        await mkdir(path.join(projectDir, ".nams"), { recursive: true });
        await mkdir(path.join(homeDir, ".nams", "state", "codex"), { recursive: true });
        await writeFile(path.join(projectDir, ".nams", "config.json"), JSON.stringify({
          apiKey: "test-api-key",
          baseUrl,
        }), "utf8");
        await writeFile(
          path.join(homeDir, ".nams", "state", "codex", "active-workspace-sessions.json"),
          `${JSON.stringify({
            sessions: [{
              sessionId: "codex-session-1",
              sessionKey: "codex-session-1",
              projectDirectory: projectDir,
              touchedAt: new Date().toISOString(),
            }],
          }, null, 2)}\n`,
          "utf8",
        );

        const result = await runCli(
          ["workspaces", "run", "codex", "--event", "CustomCommand"],
          {
            command_name: "nams:workspace",
            command_args: "use Research Team",
          },
          runtimeEnv(homeDir, baseUrl),
          projectDir,
        );

        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, "");
        const stdout = JSON.parse(result.stdout);
        assert.equal(stdout.continue, true);
        assert.equal(stdout.suppressOutput, false);
        assert.equal(stdout.exitCode, 0);
        assert.match(stdout.message, /NAMS workspace configured for codex session codex-session-1: workspace-2/);

        const state = await readOnlySessionState(homeDir, "codex");
        assert.equal(state.harness, "codex");
        assert.equal(state.harnessSessionId, "codex-session-1");
        assert.equal(state.workspace.id, "workspace-2");
        assert.equal(state.workspace.source, "session-selection");
      },
      {
        workspaces: [
          { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
          { id: "workspace-2", name: "Research Team", role: "member", status: "active" },
        ],
      },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Add failing Codex missing-session CLI test**

Add:

```ts
test("workspaces run codex CustomCommand fails closed without an active session", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  try {
    const result = await runCli(
      ["workspaces", "run", "codex", "--event", "CustomCommand"],
      {
        command_name: "nams:workspace",
        command_args: "use Research",
      },
      runtimeEnv(path.join(projectDir, "home"), "http://127.0.0.1:9"),
      projectDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const stdout = JSON.parse(result.stdout);
    assert.equal(stdout.continue, false);
    assert.equal(stdout.exitCode, 1);
    assert.match(stdout.message, /Codex session id is unavailable/);
    assert.match(stdout.message, /--session-id <session-id> --workspace Research/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run Codex CLI tests to verify they fail**

Run:

```bash
npm run build
node --import=tsx --test test/cli-workspaces.test.ts
```

Expected: FAIL because `CodexWorkspaceAdapter.customCommand` is not implemented.

- [ ] **Step 4: Implement Codex CustomCommand**

Replace `src/platforms/codex/workspaces.ts` with:

```ts
import type { WorkspaceHookInvocation, WorkspaceHookResult, WorkspacePlatformAdapter } from "../../interfaces.js";
import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
import { runActiveSessionWorkspaceUseCommand } from "../../runtime/workspace-use-command.js";

export class CodexWorkspaceAdapter implements WorkspacePlatformAdapter {
  async installConfigure(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<WorkspaceHookResult> {
    return configureWorkspaceSelection(invocation);
  }

  async customCommand(invocation: WorkspaceHookInvocation<"CustomCommand">): Promise<WorkspaceHookResult> {
    const result = await runActiveSessionWorkspaceUseCommand(invocation, {
      commandName: stringValue(invocation.rawPayload.command_name),
      arguments: invocation.rawPayload.command_args,
      projectDirectory: invocation.processCwd,
      sessionLabel: "Codex",
    });

    if (result.status === "ignored") {
      return { stdout: { continue: true, suppressOutput: true } };
    }

    const message = result.code === 0 ? result.stdout : result.stderr;
    return {
      stdout: {
        continue: result.code === 0,
        suppressOutput: false,
        exitCode: result.code,
        message,
      },
    };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
```

- [ ] **Step 5: Run Codex CLI tests**

Run:

```bash
npm run build
node --import=tsx --test test/cli-workspaces.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Codex command adapter**

Run:

```bash
git add src/platforms/codex/workspaces.ts test/cli-workspaces.test.ts
git commit -m "feat: handle codex workspace custom command" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 6: Gemini Command Packaging

**Files:**
- Create: `templates/gemini/commands/nams/workspace.toml`
- Modify: `test/gemini-template.test.ts`
- Modify: `scripts/build-dist.mjs`
- Modify: `scripts/check-dist.mjs`

- [ ] **Step 1: Add failing Gemini command template test**

In `test/gemini-template.test.ts`, add:

```ts
test("Gemini extension template packages nams workspace custom command", async () => {
  const command = await readFile(path.join(repoRoot, "templates", "gemini", "commands", "nams", "workspace.toml"), "utf8");

  assert.match(command, /description\s*=\s*"Select the NAMS workspace for this Gemini session\."/);
  assert.match(command, /prompt\s*=/);
  assert.match(command, /nams:workspace/);
  assert.match(command, /workspaces run gemini --event CustomCommand/);
  assert.match(command, /\{\{args\}\}/);
  assert.doesNotMatch(command, /workspaces configure/);
});
```

- [ ] **Step 2: Add failing dist check for Gemini command**

In `scripts/check-dist.mjs`, add this constant near `geminiExtensionPath`:

```js
const geminiCommandPath = path.join(root, "dist", "commands", "nams", "workspace.toml");
```

After `await access(geminiExtensionPath);`, add:

```js
await access(geminiCommandPath);
```

In `checkPackedPackage`, add `geminiPackedFiles(packageDir)` to the expected plugin file loop:

```js
for (const expectedFile of [...geminiPackedFiles(packageDir), ...claudePackedFiles(packageDir), ...codexPackedFiles(packageDir)]) {
  if (!packedFiles.includes(expectedFile)) {
    throw new Error(`packed package is missing plugin file: ${expectedFile}`);
  }
}
```

Add this helper near `claudePackedFiles`:

```js
function geminiPackedFiles(packageDir) {
  const prefix = packageDir === root ? "dist/" : "";
  return [
    `${prefix}commands/nams/workspace.toml`,
  ];
}
```

- [ ] **Step 3: Run Gemini template and dist checks to verify they fail**

Run:

```bash
node --import=tsx --test test/gemini-template.test.ts
npm run dist
npm run dist:check
```

Expected: the template test fails because the command file does not exist. `dist:check` fails until `build-dist.mjs` copies the command tree.

- [ ] **Step 4: Create Gemini command template**

Create `templates/gemini/commands/nams/workspace.toml` with:

```toml
description = "Select the NAMS workspace for this Gemini session."

prompt = """
NAMS workspace command result:
!{node -e 'const raw = process.argv[1] ?? ""; const selector = raw.replace(/^use(?:\\s+|$)/i, "").trim(); process.stdout.write(JSON.stringify({ command_name: "nams:workspace", command_args: `use ${selector}`.trim() }) + "\\n");' {{args}} | node "${extensionPath}/plugins/gemini-nams-hooks/bin/cli.js" workspaces run gemini --event CustomCommand}

Report the command output to the user. Do not run additional shell commands. Reply with this result only.
"""
```

If a manual smoke test shows Gemini passes `{{args}}` including the leading `use`, change the inline Node expression to use `command_args: args` and update the test to assert that shape. Keep the final committed template consistent with the smoke-tested Gemini behavior.

- [ ] **Step 5: Copy Gemini commands into dist**

In `scripts/build-dist.mjs`, after copying Gemini hooks, add:

```js
  await cp(path.join(root, "templates", "gemini", "commands"), path.join(distDir, "commands"), { recursive: true });
```

The beginning of `main()` should read:

```js
  await cp(path.join(compileDir), path.join(distDir, "bin"), { recursive: true });
  await chmod(path.join(distDir, "bin", "cli.js"), 0o755);
  await cp(path.join(root, "templates", "gemini", "gemini-extension.json"), path.join(distDir, "gemini-extension.json"));
  await cp(path.join(root, "templates", "gemini", "hooks"), path.join(distDir, "hooks"), { recursive: true });
  await cp(path.join(root, "templates", "gemini", "commands"), path.join(distDir, "commands"), { recursive: true });
```

- [ ] **Step 6: Run Gemini packaging checks**

Run:

```bash
node --import=tsx --test test/gemini-template.test.ts
npm run dist
npm run dist:check
```

Expected: PASS.

- [ ] **Step 7: Commit Gemini packaging**

Run:

```bash
git add templates/gemini/commands/nams/workspace.toml test/gemini-template.test.ts scripts/build-dist.mjs scripts/check-dist.mjs
git commit -m "feat: package gemini workspace command" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 7: Codex Skill Packaging

**Files:**
- Modify: `templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json`
- Create: `templates/codex/plugins/codex-nams-hooks/skills/workspace/SKILL.md`
- Create: `templates/codex/plugins/codex-nams-hooks/skills/workspace/agents/openai.yaml`
- Modify: `test/codex-template.test.ts`
- Modify: `scripts/check-dist.mjs`

- [ ] **Step 1: Add failing Codex skill template tests**

In `test/codex-template.test.ts`, add constants near the existing template paths:

```ts
const pluginSkillPath = "templates/codex/plugins/codex-nams-hooks/skills/workspace/SKILL.md";
const pluginSkillPolicyPath = "templates/codex/plugins/codex-nams-hooks/skills/workspace/agents/openai.yaml";
```

In `Codex plugin manifest template declares metadata without credential prompts`, add:

```ts
assert.equal(template.skills, "./skills/");
```

Add this test:

```ts
test("Codex plugin template packages explicit nams workspace skill", async () => {
  const skill = await readFile(pluginSkillPath, "utf8");
  const policy = await readFile(pluginSkillPolicyPath, "utf8");

  assert.match(skill, /name: nams:workspace/);
  assert.match(skill, /description: Explicitly use \$nams:workspace use/);
assert.match(skill, /workspaces run codex --event CustomCommand/);
assert.match(skill, /command_name/);
assert.match(skill, /command_args/);
assert.match(skill, /node bin\/cli\.js workspaces run codex --event CustomCommand/);
assert.match(skill, /nams-hooks workspaces run codex --event CustomCommand/);
  assert.doesNotMatch(skill, /workspaces configure/);
  assert.match(policy, /allow_implicit_invocation: false/);
});
```

- [ ] **Step 2: Add failing dist checks for Codex skill files**

In `scripts/check-dist.mjs`, add constants:

```js
const codexPluginSkillPath = path.join(root, "dist", "plugins", "codex-nams-hooks", "skills", "workspace", "SKILL.md");
const codexPluginSkillPolicyPath = path.join(root, "dist", "plugins", "codex-nams-hooks", "skills", "workspace", "agents", "openai.yaml");
```

In `verifyCodexPluginFiles`, after reading the plugin manifest:

```js
  await access(codexPluginSkillPath);
  await access(codexPluginSkillPolicyPath);
```

After checking plugin metadata, add:

```js
  if (plugin.skills !== "./skills/") {
    throw new Error("Codex plugin manifest must expose bundled skills from ./skills/.");
  }
```

In `codexPackedFiles`, add:

```js
    `${prefix}plugins/codex-nams-hooks/skills/workspace/SKILL.md`,
    `${prefix}plugins/codex-nams-hooks/skills/workspace/agents/openai.yaml`,
```

- [ ] **Step 3: Run Codex template and dist checks to verify they fail**

Run:

```bash
node --import=tsx --test test/codex-template.test.ts
npm run dist
npm run dist:check
```

Expected: FAIL because the manifest has no `skills` field and the skill files do not exist.

- [ ] **Step 4: Update Codex plugin manifest**

Modify `templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json` so the final object includes `"skills": "./skills/"` after `description`:

```json
{
  "name": "nams-hooks",
  "version": "__PACKAGE_VERSION__",
  "description": "Persistent Neo4j Agent Memory Service hooks for Codex.",
  "skills": "./skills/",
  "author": {
    "name": "Neo4j Labs"
  },
  "repository": "https://github.com/neo4j-labs/nams-plugins",
  "license": "__PACKAGE_LICENSE__",
  "keywords": [
    "memory",
    "context",
    "persistence",
    "neo4j",
    "nams"
  ]
}
```

- [ ] **Step 5: Create the Codex skill**

Create `templates/codex/plugins/codex-nams-hooks/skills/workspace/SKILL.md` with:

````md
---
name: nams:workspace
description: Explicitly use $nams:workspace use <workspace-id-or-name> to select the NAMS workspace for the current Codex session after a NAMS workspace ambiguity notice.
---

# NAMS Workspace Selection

Use this skill only when the user explicitly invokes `$nams:workspace use <workspace-id-or-name>`.

Extract the selector as the full text after `use`. Preserve spaces inside the selector.

Run the NAMS workspace command through the bundled plugin CLI when the loaded skill path reveals the plugin root. The plugin root is the ancestor directory containing `.codex-plugin/plugin.json`. From that plugin root, run:

```bash
node bin/cli.js workspaces run codex --event CustomCommand
```

Pass this JSON object on stdin:

```json
{
  "command_name": "nams:workspace",
  "command_args": "use <workspace-id-or-name>"
}
```

If the plugin root is not discoverable from the skill context, run the installed executable instead:

```bash
nams-hooks workspaces run codex --event CustomCommand
```

Pass the same JSON object on stdin.

Report the command output to the user. If the command asks for the explicit shell fallback with `<session-id>`, show that fallback exactly.
````

- [ ] **Step 6: Create the Codex skill policy**

Create `templates/codex/plugins/codex-nams-hooks/skills/workspace/agents/openai.yaml` with:

```yaml
policy:
  allow_implicit_invocation: false
```

- [ ] **Step 7: Run Codex packaging checks**

Run:

```bash
node --import=tsx --test test/codex-template.test.ts
npm run dist
npm run dist:check
```

Expected: PASS.

- [ ] **Step 8: Commit Codex skill packaging**

Run:

```bash
git add templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json \
  templates/codex/plugins/codex-nams-hooks/skills/workspace/SKILL.md \
  templates/codex/plugins/codex-nams-hooks/skills/workspace/agents/openai.yaml \
  test/codex-template.test.ts \
  scripts/check-dist.mjs
git commit -m "feat: package codex workspace skill" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 8: Documentation And User-Facing Guidance

**Files:**
- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `docs/session-workspace-command-support.md`
- Modify: `test/slash-workspace-docs.test.ts`

- [ ] **Step 1: Update failing documentation tests**

In `test/slash-workspace-docs.test.ts`, add:

```ts
const codexSkillCommand = "$nams:workspace use <workspace-id-or-name>";
```

Update `README documents Tier 1 workspace selection and the portable shell command` to:

```ts
assertMentionsPlatformCommand(content, "Gemini", workspaceSlash);
assertMentionsPlatformCommand(content, "Codex", codexSkillCommand);
```

Update the workspace selection test to assert Gemini and Codex no longer appear as shell-only:

```ts
assertMentionsPlatformCommand(workspaceSelection, "Gemini", workspaceSlash);
assertMentionsPlatformCommand(workspaceSelection, "Codex", codexSkillCommand);
assert.doesNotMatch(workspaceSelection, /Keep using the shell command for Gemini, Codex/);
```

Update `INSTALL platform notes keep platform-specific workspace command guidance`:

```ts
assert.match(codex, /explicit skill/i);
assertIncludesCommand(codex, codexSkillCommand);
assert.doesNotMatch(codex, /does not currently expose deterministic/);

assert.match(gemini, /custom command/i);
assertIncludesCommand(gemini, workspaceSlash);
assert.doesNotMatch(gemini, /deferred/i);
```

Update the research-note test:

```ts
assert.match(remainingUxWork, /Gemini CLI[\s\S]{0,240}active-session bridge/i);
assert.match(remainingUxWork, /Codex[\s\S]{0,240}\$nams:workspace/i);
assert.doesNotMatch(remainingUxWork, /Gemini CLI[\s\S]{0,160}deferred/i);
assert.doesNotMatch(remainingUxWork, /Codex[\s\S]{0,160}explicit shell configuration/i);
```

- [ ] **Step 2: Run docs tests to verify they fail**

Run:

```bash
node --import=tsx --test test/slash-workspace-docs.test.ts
```

Expected: FAIL because docs still describe Gemini and Codex as deferred or shell-only.

- [ ] **Step 3: Update README guidance**

In `README.md`, replace the workspace-selection paragraph under `Runtime Configuration And Storage` with this text:

```md
Runtime configuration is JSON-first: `~/.nams/config.json`, optional project `.nams/config.json`, optional platform discovery such as Claude plugin user configuration, then final `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides. `apiKey` and a resolved `baseUrl` are required for NAMS requests; the standard service URL can be supplied by JSON config or platform configuration templates. NAMS supports workspace keys and admin keys. `nams-hooks` does not configure a key type; it uses the number of workspaces returned by NAMS to decide whether a workspace can be auto-selected. When `workspaceId` is omitted, nams-hooks calls `GET /v1/users/me/workspaces` before memory creation. If exactly one valid workspace is returned, that workspace is stored in session state and reused by later memory hooks. If multiple valid workspaces are returned, memory stays inactive for that turn until you select one explicitly. The quickest deterministic fix is a session-scoped selection. Claude Code, OpenCode, and Gemini installs expose `/nams:workspace use <workspace-id-or-name>`. Codex plugin installs expose the explicit skill `$nams:workspace use <workspace-id-or-name>`. For all platforms, scripts, and troubleshooting, use the explicit shell command from the hook notice: `nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>`. Hook notices include the current session ID when the harness exposes it, so usually only `--workspace <workspace-id-or-name>` needs editing. Durable project and user defaults use the same selector, for example `nams-hooks workspaces configure <platform> --scope project --workspace <workspace-id-or-name>`. Runtime state and logs are user-local under per-platform directories in `~/.nams/state/` and `~/.nams/logs/`.
```

- [ ] **Step 4: Update INSTALL workspace selection and platform notes**

In `INSTALL.md`, replace the generic workspace command guidance with:

````md
When the platform command is installed, Claude Code, OpenCode, and Gemini expose
the direct command:

```text
# Claude Code, OpenCode, and Gemini CLI
/nams:workspace use <workspace-id-or-name>
```

Codex exposes the same namespace as an explicit skill:

```text
$nams:workspace use <workspace-id-or-name>
```

These command surfaces wrap the explicit shell command. Keep using the shell
command for scripts, troubleshooting, and any session where the platform command
cannot resolve the current session:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```
````

In the Codex section, replace the shell-only paragraph with:

````md
Codex exposes workspace selection as an explicit skill:

```text
$nams:workspace use <workspace-id-or-name>
```

The skill asks Codex to run the bundled workspace command. If Codex cannot
resolve the current active NAMS session, use the explicit shell command from the
hook notice:

```bash
nams-hooks workspaces configure codex --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```
````

In the Gemini section, replace the deferred paragraph with:

````md
Gemini exposes workspace selection through the extension custom command:

```text
/nams:workspace use <workspace-id-or-name>
```

The command resolves the recent active Gemini session recorded at Gemini session
start and refreshed by workspace ambiguity hooks. If the active session is
missing or ambiguous, use the explicit shell command from the hook notice:

```bash
nams-hooks workspaces configure gemini --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```
````

- [ ] **Step 5: Update the research note**

In `docs/session-workspace-command-support.md`, replace the `Remaining UX Work` section with:

````md
## Remaining UX Work

Claude Code project-template and plugin installs expose the direct command:

```text
/nams:workspace use <workspace-id-or-name>
```

OpenCode exposes the direct plugin shim command:

```text
/nams:workspace use <workspace-id-or-name>
```

Gemini CLI uses the same slash command through the extension custom-command
surface. The command resolves the current session through the active-session
bridge recorded at Gemini session start and refreshed when the workspace
ambiguity hook fires:

```text
/nams:workspace use <workspace-id-or-name>
```

Codex exposes the namespace as an explicit skill invocation:

```text
$nams:workspace use <workspace-id-or-name>
```

The explicit configure command remains documented for all platforms, scripts,
and troubleshooting:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

The runtime notices emitted by supported adapters now point users at the
platform command and keep the session configure fallback. When the adapter can
parse the current session ID, the fallback includes the concrete session ID.
Otherwise it keeps the `<session-id>` placeholder.
````

- [ ] **Step 6: Run docs tests**

Run:

```bash
node --import=tsx --test test/slash-workspace-docs.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit docs**

Run:

```bash
git add README.md INSTALL.md docs/session-workspace-command-support.md test/slash-workspace-docs.test.ts
git commit -m "docs: describe workspace command bridge" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 9: Full Verification And Manual Smoke Notes

**Files:**
- Modify only if verification exposes an issue in files already touched by Tasks 1-8.

- [ ] **Step 1: Run full project check**

Run:

```bash
npm run check
```

Expected: PASS. This runs OpenAPI generation, TypeScript build, test typecheck, local build, and the full Node test suite.

- [ ] **Step 2: Run distribution build and checks**

Run:

```bash
npm run dist
npm run dist:check
```

Expected: PASS. `dist/commands/nams/workspace.toml` and `dist/plugins/codex-nams-hooks/skills/workspace/SKILL.md` must exist.

- [ ] **Step 3: Inspect generated assets**

Run:

```bash
test -f dist/commands/nams/workspace.toml
test -f dist/plugins/codex-nams-hooks/skills/workspace/SKILL.md
test -f dist/plugins/codex-nams-hooks/skills/workspace/agents/openai.yaml
node -e 'const fs=require("fs"); const manifest=JSON.parse(fs.readFileSync("dist/plugins/codex-nams-hooks/.codex-plugin/plugin.json","utf8")); if (manifest.skills !== "./skills/") throw new Error("missing codex skills field"); console.log("generated workspace command assets verified");'
```

Expected stdout:

```text
generated workspace command assets verified
```

- [ ] **Step 4: Record manual smoke commands in the PR description**

Use these manual smoke commands after the release tree is built:

```bash
npm run dist
gemini extensions link ./dist
codex plugin marketplace add ./dist
```

Manual Gemini check:

```text
/nams:workspace use Engineering
```

Expected: the command calls `workspaces run gemini --event CustomCommand`; if no active marker exists, it prints the manual configure fallback with `<session-id>`.

Manual Codex check:

```text
$nams:workspace use Engineering
```

Expected: the skill instructs Codex to run `workspaces run codex --event CustomCommand`; if no active marker exists, it reports the manual configure fallback with `<session-id>`.

- [ ] **Step 5: Commit verification fixes if needed**

If any verification step required changes, commit only the files changed by those fixes. For example, if `npm run dist:check` required a correction to `scripts/check-dist.mjs`, run:

```bash
git add scripts/check-dist.mjs
git commit -m "fix: complete workspace command bridge verification" -m "Co-authored-by: Codex <codex@openai.com>"
```

Expected: no commit is needed if Tasks 1-8 passed cleanly.
