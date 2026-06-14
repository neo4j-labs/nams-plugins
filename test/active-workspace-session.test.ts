import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

test("treats malformed marker files as empty before recording clean shape", async () => {
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

test("treats marker files with extra top-level metadata as empty before recording clean shape", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-active-session-project-"));
  const homeDir = path.join(projectDir, "home");
  const markerPath = path.join(homeDir, ".nams", "state", "gemini", "active-workspace-sessions.json");
  try {
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, `${JSON.stringify({
      version: 1,
      sessions: [
        {
          sessionId: "metadata-session",
          sessionKey: "metadata-session",
          projectDirectory: path.resolve(projectDir),
          touchedAt: "2026-06-14T10:00:00.000Z",
        },
      ],
    })}\n`, { encoding: "utf8", mode: 0o600 });

    const missing = await resolveActiveWorkspaceSession({
      platform: "gemini",
      projectDirectory: projectDir,
      now: new Date("2026-06-14T10:00:30.000Z"),
      environment: env(homeDir),
    });
    assert.deepEqual(missing, { status: "missing" });

    await recordActiveWorkspaceSession({
      platform: "gemini",
      sessionId: "clean-session",
      sessionKey: "clean-session",
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T10:00:31.000Z"),
      environment: env(homeDir),
    });
    const marker = await readMarker(homeDir, "gemini");
    assert.deepEqual(Object.keys(marker).sort(), ["sessions"]);
    assert.deepEqual(marker.sessions.map((session: Record<string, unknown>) => session.sessionId), ["clean-session"]);
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

test("resolves fresh sessions even when stale-prune cleanup cannot write", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-active-session-project-"));
  const homeDir = path.join(projectDir, "home");
  const markerPath = path.join(homeDir, ".nams", "state", "gemini", "active-workspace-sessions.json");
  const now = new Date("2026-06-14T10:00:30.000Z");
  try {
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, `${JSON.stringify({
      sessions: [
        {
          sessionId: "stale-session",
          sessionKey: "stale-session",
          projectDirectory: path.resolve(projectDir),
          touchedAt: new Date(now.getTime() - ACTIVE_WORKSPACE_SESSION_TTL_MS - 1).toISOString(),
        },
        {
          sessionId: "fresh-session",
          sessionKey: "fresh-session",
          projectDirectory: path.resolve(projectDir),
          touchedAt: "2026-06-14T10:00:00.000Z",
        },
      ],
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(markerPath, 0o400);

    const resolved = await resolveActiveWorkspaceSession({
      platform: "gemini",
      projectDirectory: projectDir,
      now,
      environment: env(homeDir),
    });

    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.status === "resolved" ? resolved.sessionId : "", "fresh-session");
  } finally {
    await chmod(markerPath, 0o600).catch(() => {});
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

test("concurrent records preserve distinct fresh sessions for the same platform and project", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-active-session-project-"));
  const homeDir = path.join(projectDir, "home");
  const sessionIds = Array.from({ length: 8 }, (_, index) => `concurrent-session-${index + 1}`);
  try {
    await Promise.all(sessionIds.map((sessionId) => recordActiveWorkspaceSession({
      platform: "gemini",
      sessionId,
      sessionKey: sessionId,
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T10:00:00.000Z"),
      environment: env(homeDir),
    })));

    const marker = await readMarker(homeDir, "gemini");
    assert.deepEqual(
      marker.sessions.map((session: Record<string, unknown>) => session.sessionId).sort(),
      sessionIds,
    );

    const resolved = await resolveActiveWorkspaceSession({
      platform: "gemini",
      projectDirectory: projectDir,
      now: new Date("2026-06-14T10:00:30.000Z"),
      environment: env(homeDir),
    });
    assert.equal(resolved.status, "ambiguous");
    assert.equal(resolved.status === "ambiguous" ? resolved.candidates.length : 0, sessionIds.length);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("resolving one project preserves fresh same-platform records for other projects", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-active-session-project-"));
  const otherProjectDir = await mkdtemp(path.join(tmpdir(), "nams-active-session-other-"));
  const homeDir = path.join(projectDir, "home");
  try {
    await recordActiveWorkspaceSession({
      platform: "gemini",
      sessionId: "project-session",
      sessionKey: "project-session",
      projectDirectory: projectDir,
      touchedAt: new Date("2026-06-14T10:00:00.000Z"),
      environment: env(homeDir),
    });
    await recordActiveWorkspaceSession({
      platform: "gemini",
      sessionId: "other-project-session",
      sessionKey: "other-project-session",
      projectDirectory: otherProjectDir,
      touchedAt: new Date("2026-06-14T10:00:00.000Z"),
      environment: env(homeDir),
    });

    assert.equal((await resolveActiveWorkspaceSession({
      platform: "gemini",
      projectDirectory: projectDir,
      now: new Date("2026-06-14T10:00:30.000Z"),
      environment: env(homeDir),
    })).status, "resolved");

    const otherResolved = await resolveActiveWorkspaceSession({
      platform: "gemini",
      projectDirectory: otherProjectDir,
      now: new Date("2026-06-14T10:00:30.000Z"),
      environment: env(homeDir),
    });
    assert.equal(otherResolved.status, "resolved");
    assert.equal(otherResolved.status === "resolved" ? otherResolved.sessionId : "", "other-project-session");

    const marker = await readMarker(homeDir, "gemini");
    assert.deepEqual(
      marker.sessions.map((session: Record<string, unknown>) => session.sessionId).sort(),
      ["other-project-session", "project-session"],
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(otherProjectDir, { recursive: true, force: true });
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
