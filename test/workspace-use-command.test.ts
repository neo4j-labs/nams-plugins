import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Platform, WorkspaceHookInvocation } from "../src/interfaces.js";
import { recordActiveWorkspaceSession } from "../src/runtime/active-workspace-session.js";
import { runActiveSessionWorkspaceUseCommand, slashWorkspaceCommandUsage } from "../src/runtime/workspace-use-command.js";
import { sessionStateFiles } from "./support/runtime-home.js";

interface RecordedRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
}

async function withWorkspaceServer<T>(
  handler: (baseUrl: string, requests: RecordedRequest[]) => Promise<T>,
): Promise<T> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
    });
    if (request.method === "GET" && request.url === "/v1/users/me/workspaces") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        workspaces: [
          { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
          { id: "workspace-2", name: "Research", role: "member", status: "active" },
        ],
      }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    return await handler(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function writeProjectConfig(projectDirectory: string, baseUrl: string): Promise<void> {
  const configPath = path.join(projectDirectory, ".nams", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ apiKey: "test-api-key", baseUrl }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function withRuntimeEnvironment(homeDir: string): () => void {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousApiKey = process.env.NAMS_API_KEY;
  const previousBaseUrl = process.env.NAMS_BASE_URL;
  const previousWorkspaceId = process.env.NAMS_WORKSPACE_ID;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  delete process.env.NAMS_API_KEY;
  delete process.env.NAMS_BASE_URL;
  delete process.env.NAMS_WORKSPACE_ID;
  return () => {
    restoreEnvValue("HOME", previousHome);
    restoreEnvValue("USERPROFILE", previousUserProfile);
    restoreEnvValue("NAMS_API_KEY", previousApiKey);
    restoreEnvValue("NAMS_BASE_URL", previousBaseUrl);
    restoreEnvValue("NAMS_WORKSPACE_ID", previousWorkspaceId);
  };
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function invocation(platform: Platform, projectDirectory: string): WorkspaceHookInvocation<"CustomCommand"> {
  return {
    platform,
    event: "CustomCommand",
    rawPayload: {},
    processCwd: projectDirectory,
  };
}

async function readOnlySessionState(homeDir: string, platform: Platform): Promise<Record<string, any>> {
  const files = (await sessionStateFiles(homeDir, platform)).filter((file) => file !== "active-workspace-sessions.json");
  assert.equal(files.length, 1, `expected one ${platform} session state file, got ${files.join(", ")}`);
  return JSON.parse(await readFile(path.join(homeDir, ".nams", "state", platform, files[0]), "utf8")) as Record<string, any>;
}

test("bridged workspace command configures resolved active session", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-workspace-use-")));
  const homeDir = path.join(projectDir, "home");
  const restoreEnv = withRuntimeEnvironment(homeDir);
  try {
    await withWorkspaceServer(async (baseUrl, requests) => {
      await writeProjectConfig(projectDir, baseUrl);
      await recordActiveWorkspaceSession({
        platform: "gemini",
        sessionId: "gemini-session-1",
        sessionKey: "gemini-session-1",
        projectDirectory: projectDir,
        touchedAt: new Date(),
      });

      const result = await runActiveSessionWorkspaceUseCommand(invocation("gemini", projectDir), {
        commandName: "nams:workspace",
        arguments: "use Research",
        projectDirectory: projectDir,
        sessionLabel: "Gemini",
        usage: slashWorkspaceCommandUsage,
      });

      assert.equal(result.status, "completed");
      assert.equal(result.status === "completed" ? result.code : -1, 0);
      assert.match(result.status === "completed" ? result.stdout : "", /gemini session gemini-session-1: workspace-2/);
      assert.equal(result.status === "completed" ? result.stderr : "", "");
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.url, "/v1/users/me/workspaces");

      const state = await readOnlySessionState(homeDir, "gemini");
      assert.equal(state.harness, "gemini");
      assert.equal(state.harnessSessionId, "gemini-session-1");
      assert.equal(state.workspace.id, "workspace-2");
      assert.equal(state.workspace.source, "session-selection");
    });
  } finally {
    restoreEnv();
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("bridged workspace command fails closed when active session is missing", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-workspace-use-")));
  const homeDir = path.join(projectDir, "home");
  const restoreEnv = withRuntimeEnvironment(homeDir);
  try {
    const result = await runActiveSessionWorkspaceUseCommand(invocation("gemini", projectDir), {
      commandName: "nams:workspace",
      arguments: "use Engineering",
      projectDirectory: projectDir,
      sessionLabel: "Gemini",
      usage: slashWorkspaceCommandUsage,
    });

    assert.deepEqual(result, {
      status: "completed",
      code: 1,
      stdout: "",
      stderr: [
        "Gemini session id is unavailable; no recent active NAMS workspace session matched this project.",
        "Run manually: nams-hooks workspaces configure gemini --scope session --session-id <session-id> --workspace Engineering",
      ].join("\n"),
    });
  } finally {
    restoreEnv();
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("bridged workspace command fails closed when active session is ambiguous", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-workspace-use-")));
  const homeDir = path.join(projectDir, "home");
  const restoreEnv = withRuntimeEnvironment(homeDir);
  try {
    const now = new Date();
    await recordActiveWorkspaceSession({
      platform: "codex",
      sessionId: "codex-session-1",
      sessionKey: "codex-session-1",
      projectDirectory: projectDir,
      touchedAt: new Date(now.getTime() - 1_000),
    });
    await recordActiveWorkspaceSession({
      platform: "codex",
      sessionId: "codex-session-2",
      sessionKey: "codex-session-2",
      projectDirectory: projectDir,
      touchedAt: now,
    });

    const result = await runActiveSessionWorkspaceUseCommand(invocation("codex", projectDir), {
      commandName: "nams:workspace",
      arguments: ["use", "Engineering Team"],
      projectDirectory: projectDir,
      sessionLabel: "Codex",
      usage: slashWorkspaceCommandUsage,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.status === "completed" ? result.code : -1, 1);
    assert.equal(result.status === "completed" ? result.stdout : "", "");
    assert.match(
      result.status === "completed" ? result.stderr : "",
      /multiple recent active NAMS workspace sessions matched this project/,
    );
    assert.match(
      result.status === "completed" ? result.stderr : "",
      /Run manually: nams-hooks workspaces configure codex --scope session --session-id <session-id> --workspace 'Engineering Team'/,
    );
  } finally {
    restoreEnv();
    await rm(projectDir, { recursive: true, force: true });
  }
});
