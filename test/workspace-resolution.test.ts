import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HookInvocation } from "../src/interfaces.js";
import { createInitialSessionState } from "../src/runtime/session-state.js";
import { resolveWorkspaceForMemory } from "../src/runtime/workspace-resolution.js";
import { createNamsFetchMock } from "./support/nams-fetch-mock.js";

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

function invocation(projectDir: string): HookInvocation<"BeforeAgent"> {
  return {
    platform: "gemini",
    event: "BeforeAgent",
    processCwd: projectDir,
    rawPayload: {
      session_id: "session-1",
      cwd: projectDir,
      prompt: "hello",
    },
  };
}

test("configured workspace skips workspace listing", async () => {
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
    assert.equal(nams.calls("listMyWorkspaces").length, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("single returned workspace stores session workspace and returns ready config", async () => {
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

test("multiple workspaces return Gemini deny output before memory can continue", async () => {
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
