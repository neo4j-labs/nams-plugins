import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HookInvocation } from "../src/interfaces.js";
import { createInitialSessionState } from "../src/runtime/session-state.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
} from "../src/runtime/workspace-resolution.js";
import { createNamsFetchMock } from "./support/nams-fetch-mock.js";
import { readSingleSessionLog } from "./support/runtime-home.js";

function useEnv(projectDir: string, overrides: Record<string, string | undefined> = {}): void {
  for (const key of ["HOME", "USERPROFILE", "NAMS_API_KEY", "NAMS_WORKSPACE_ID", "NAMS_BASE_URL"]) {
    delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: path.join(projectDir, "home"),
    USERPROFILE: path.join(projectDir, "home"),
    ...overrides,
  });
}

function invocation(
  projectDir: string,
  platform: HookInvocation<"BeforeAgent">["platform"] = "gemini",
): HookInvocation<"BeforeAgent"> {
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

test("configured workspace skips workspace listing and is not preflight validated", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    const nams = createNamsFetchMock().workspaces({ error: "unexpected workspace listing" }, 500);
    useEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "configured-workspace",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const state = createInitialSessionState({
      platform: "gemini",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });

    const result = await resolveWorkspaceForMemory({
      invocation: invocation(projectDir),
      state,
      projectDirectory: projectDir,
      interaction: "gemini-blocking",
    });

    assert.equal(result.status, "ready");
    assert.equal(result.config.workspaceId, "configured-workspace");
    assert.deepEqual(state.workspace, {
      id: "configured-workspace",
      source: "config",
      selectedAt: state.workspace?.selectedAt,
    });
    assert.equal(nams.calls("listMyWorkspaces").length, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("single listed workspace auto-selects by cardinality", async () => {
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
      platform: "gemini",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });

    const result = await resolveWorkspaceForMemory({
      invocation: invocation(projectDir),
      state,
      projectDirectory: projectDir,
      interaction: "gemini-blocking",
    });

    assert.equal(result.status, "ready");
    assert.equal(result.config.workspaceId, "workspace-1");
    assert.deepEqual(state.workspace, {
      id: "workspace-1",
      source: "runtime-single-workspace",
      selectedAt: state.workspace?.selectedAt,
    });
    const headers = nams.calls("listMyWorkspaces")[0].options.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer key");
    assert.equal(headers["x-workspace-id"], undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

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

test("workspace request failure skips memory with fixed diagnostic", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    const nams = createNamsFetchMock().throws(new Error("network secret should stay local"));
    useEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const state = createInitialSessionState({
      platform: "gemini",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });

    const result = await resolveWorkspaceForMemory({
      invocation: invocation(projectDir),
      state,
      projectDirectory: projectDir,
      interaction: "gemini-blocking",
    });

    assert.equal(result.status, "skip-memory");
    assert.deepEqual(result.output.stdout, { continue: true, suppressOutput: true });
    assert.equal(state.workspace, undefined);
    assert.equal(nams.calls().length, 1);

    const { lines } = await readSingleSessionLog(path.join(projectDir, "home"), "gemini");
    const diagnostics = lines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS workspace request failed",
    );
    assert.equal(diagnostics.length, 1);
    assert.doesNotMatch(JSON.stringify(diagnostics), /network secret/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("empty workspace list skips memory with fixed diagnostic", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    const nams = createNamsFetchMock().workspaces({ workspaces: [] }).createConversation();
    useEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const state = createInitialSessionState({
      platform: "gemini",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });

    const result = await resolveWorkspaceForMemory({
      invocation: invocation(projectDir),
      state,
      projectDirectory: projectDir,
      interaction: "gemini-blocking",
    });

    assert.equal(result.status, "skip-memory");
    assert.deepEqual(result.output.stdout, { continue: true, suppressOutput: true });
    assert.equal(state.workspace, undefined);
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 0);

    const { lines } = await readSingleSessionLog(path.join(projectDir, "home"), "gemini");
    assert.ok(
      lines.some(
        (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS workspace list empty",
      ),
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("multiple listed workspaces require Gemini selection before memory can continue", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    createNamsFetchMock().workspaces({
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
      platform: "gemini",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });

    const result = await resolveWorkspaceForMemory({
      invocation: invocation(projectDir),
      state,
      projectDirectory: projectDir,
      interaction: "gemini-blocking",
    });

    assert.equal(result.status, "block");
    assert.equal(state.workspace, undefined);
    assert.deepEqual(result.output.stdout.continue, undefined);
    assert.equal(result.output.stdout.decision, "deny");
    assert.match(String(result.output.stdout.reason), /NAMS workspace selection required/);
    assert.match(String(result.output.stdout.reason), /Engineering/);
    assert.match(String(result.output.stdout.reason), /workspace-2/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("multiple listed workspaces require OpenCode configuration before memory readiness", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    createNamsFetchMock().workspaces({
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
      platform: "opencode",
      sessionId: "session-1",
      projectDirectory: projectDir,
    });

    const result = await resolveWorkspaceForMemory({
      invocation: { ...invocation(projectDir), platform: "opencode" },
      state,
      projectDirectory: projectDir,
      interaction: "single-only",
    });

    assert.equal(result.status, "skip-memory");
    assert.equal(result.output.stdout.namsMemoryReady, undefined);
    assert.equal(result.output.stdout.namsWorkspaceSelectionRequired, true);
    assert.match(String(result.output.stdout.reason), /NAMS workspace selection required/);
    assert.match(String(result.output.stdout.reason), /workspace-2/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("multiple listed workspaces return Claude additionalContext selection notice", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-workspace-resolution-"));
  try {
    createNamsFetchMock().workspaces({
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

    const result = await resolveWorkspaceForMemory({
      invocation: { ...invocation(projectDir), platform: "claude" },
      state,
      projectDirectory: projectDir,
      interaction: "single-only",
    });

    assert.equal(result.status, "skip-memory");
    assert.equal(result.output.stdout.continue, true);
    assert.equal(result.output.stdout.suppressOutput, false);
    assert.match(String(result.output.stdout.systemMessage), /NAMS memory is inactive for this turn/);
    assert.match(String(result.output.stdout.systemMessage), /nams-hooks workspaces configure claude --scope project --workspace-id/);
    assert.equal(Object.hasOwn(result.output.stdout, "additionalContext"), false);
    const hookOutput = result.output.stdout.hookSpecificOutput as Record<string, unknown>;
    assert.equal(hookOutput.hookEventName, "UserPromptSubmit");
    assert.match(String(hookOutput.additionalContext), /NAMS memory is inactive for this turn/);
    assert.match(String(hookOutput.additionalContext), /No memory messages were stored/);
    assert.match(String(hookOutput.additionalContext), /Multiple NAMS workspaces are available/);
    assert.match(String(hookOutput.additionalContext), /nams-hooks workspaces configure claude --scope project --workspace-id/);
    assert.match(String(hookOutput.additionalContext), /workspace-2/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
