import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Platform } from "../src/interfaces.js";
import { sessionStateFiles } from "./support/runtime-home.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, ".build", "tsc", "cli.js");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RecordedRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
}

async function onlySessionStatePath(homeDir: string, platform: Platform): Promise<string> {
  const files = await sessionStateFiles(homeDir, platform);
  assert.equal(files.length, 1, `expected one ${platform} session state file, got ${files.join(", ")}`);
  return path.join(homeDir, ".nams", "state", platform, files[0]);
}

async function readOnlySessionState(homeDir: string, platform: Platform): Promise<Record<string, any>> {
  return JSON.parse(await readFile(await onlySessionStatePath(homeDir, platform), "utf8")) as Record<string, any>;
}

function runCli(
  args: string[],
  payload: Record<string, unknown>,
  env: Record<string, string | undefined>,
  cwd = repoRoot,
): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

async function withWorkspaceServer<T>(
  handler: (baseUrl: string, requests: RecordedRequest[]) => Promise<T>,
  responseBody: Record<string, unknown> = {
    workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
  },
  responseStatus = 200,
): Promise<T> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
    });
    if (request.method === "GET" && request.url === "/v1/users/me/workspaces") {
      response.writeHead(responseStatus, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody));
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

function runtimeEnv(homeDir: string, baseUrl: string): NodeJS.ProcessEnv {
  const env = childProcessEnv();
  delete env.NAMS_WORKSPACE_ID;
  return {
    ...env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    NAMS_API_KEY: "test-api-key",
    NAMS_BASE_URL: baseUrl,
  };
}

function runtimeEnvWithoutHome(baseUrl: string): NodeJS.ProcessEnv {
  const env = childProcessEnv();
  delete env.HOME;
  delete env.USERPROFILE;
  delete env.NAMS_WORKSPACE_ID;
  return {
    ...env,
    NAMS_API_KEY: "test-api-key",
    NAMS_BASE_URL: baseUrl,
  };
}

function childProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key.startsWith("NODE_TEST")) {
      delete env[key];
    }
  }
  return env;
}

test("workspaces BeforeAgent command allows without resolving workspace", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(async (baseUrl, requests) => {
      const result = await runCli(
        ["workspaces", "gemini", "--event", "BeforeAgent"],
        {
          session_id: "session-1",
          cwd: projectDir,
          prompt: "hello",
        },
        runtimeEnv(path.join(projectDir, "home"), baseUrl),
      );

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        continue: true,
        suppressOutput: true,
      });
      assert.equal(requests.length, 0);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces run claude UserPromptExpansion configures the session workspace", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const result = await runCli(
          ["workspaces", "run", "claude", "--event", "UserPromptExpansion"],
          {
            hook_event_name: "UserPromptExpansion",
            command_name: "nams:workspace",
            command_args: "use Engineering Team; $(echo unsafe) \"quoted\"",
            session_id: "claude-session-1",
          },
          runtimeEnv(homeDir, baseUrl),
          projectDir,
        );

        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, "");
        const stdout = JSON.parse(result.stdout);
        assert.equal(stdout.decision, "block");
        assert.match(stdout.reason, /NAMS workspace configured for claude session claude-session-1: workspace-2/);

        const state = await readOnlySessionState(homeDir, "claude");
        assert.equal(state.harness, "claude");
        assert.equal(state.harnessSessionId, "claude-session-1");
        assert.equal(state.workspace.id, "workspace-2");
        assert.equal(state.workspace.source, "session-selection");
      },
      {
        workspaces: [
          { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
          { id: "workspace-2", name: "Engineering Team; $(echo unsafe) \"quoted\"", role: "member", status: "active" },
        ],
      },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces run claude UserPromptExpansion blocks missing selector and session id", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  try {
    await withWorkspaceServer(async (baseUrl) => {
      const missingSelector = await runCli(
        ["workspaces", "run", "claude", "--event", "UserPromptExpansion"],
        {
          hook_event_name: "UserPromptExpansion",
          command_name: "nams:workspace",
          command_args: "use",
          session_id: "claude-session-1",
        },
        runtimeEnv(path.join(projectDir, "home"), baseUrl),
        projectDir,
      );

      assert.equal(missingSelector.code, 0, missingSelector.stderr);
      assert.equal(JSON.parse(missingSelector.stdout).decision, "block");
      assert.match(JSON.parse(missingSelector.stdout).reason, /Usage: \/nams:workspace use <workspace-id-or-name>/);

      const missingSession = await runCli(
        ["workspaces", "run", "claude", "--event", "UserPromptExpansion"],
        {
          hook_event_name: "UserPromptExpansion",
          command_name: "nams:workspace",
          command_args: "use Engineering Team; $(echo unsafe)",
          session_id: "",
        },
        runtimeEnv(path.join(projectDir, "home"), baseUrl),
        projectDir,
      );

      assert.equal(missingSession.code, 0, missingSession.stderr);
      assert.equal(JSON.parse(missingSession.stdout).decision, "block");
      assert.match(JSON.parse(missingSession.stdout).reason, /Claude session id is unavailable/);
      assert.match(
        JSON.parse(missingSession.stdout).reason,
        /--session-id <session-id> --workspace 'Engineering Team; \$\(echo unsafe\)'/,
      );
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces run opencode CommandExecuteBefore configures the session workspace", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const result = await runCli(
          ["workspaces", "run", "opencode", "--event", "CommandExecuteBefore"],
          {
            command: "nams:workspace",
            arguments: ["use", "Engineering Team"],
            sessionID: "opencode-session-1",
          },
          runtimeEnv(homeDir, baseUrl),
          projectDir,
        );

        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, "");
        const stdout = JSON.parse(result.stdout);
        assert.equal(stdout.stop, true);
        assert.equal(stdout.code, 0);
        assert.match(stdout.stdout, /NAMS workspace configured for opencode session opencode-session-1: workspace-2/);
        assert.equal(stdout.stderr, "");

        const state = await readOnlySessionState(homeDir, "opencode");
        assert.equal(state.harness, "opencode");
        assert.equal(state.harnessSessionId, "opencode-session-1");
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

test("workspaces rejects unsupported workspace events with usage", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    const result = await runCli(
      ["workspaces", "gemini", "--event", "AfterAgent"],
      { session_id: "session-1", cwd: projectDir },
      runtimeEnv(path.join(projectDir, "home"), "http://127.0.0.1:9"),
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage:/);
    assert.match(
      result.stderr,
      /workspaces run <gemini\|claude\|codex\|opencode> --event <BeforeAgent\|InstallConfigure\|UserPromptExpansion\|CommandExecuteBefore\|CustomCommand>/,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure codex writes project config for explicit workspace selector", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const result = await runCli(
          ["workspaces", "configure", "codex", "--scope", "project", "--workspace", "Research"],
          {},
          runtimeEnv(path.join(projectDir, "home"), baseUrl),
          projectDir,
        );

        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /workspace-2/);
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(await readFile(path.join(projectDir, ".nams", "config.json"), "utf8")), {
          workspaceId: "workspace-2",
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

test("workspaces configure user scope writes config for explicit workspace selector", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  const homeDir = path.join(projectDir, "home");
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const result = await runCli(
          ["workspaces", "configure", "codex", "--scope", "user", "--workspace", "workspace-2"],
          {},
          runtimeEnv(homeDir, baseUrl),
          projectDir,
        );

        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /workspace-2/);
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(await readFile(path.join(homeDir, ".nams", "config.json"), "utf8")), {
          workspaceId: "workspace-2",
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

test("workspaces configure rejects legacy workspace-id flag before dispatch", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl, requests) => {
        const result = await runCli(
          ["workspaces", "configure", "codex", "--scope", "project", "--workspace-id", "workspace-only"],
          {},
          runtimeEnv(path.join(projectDir, "home"), baseUrl),
          projectDir,
        );

        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Usage:/);
        assert.doesNotMatch(result.stderr, /--workspace-id/);
        assert.match(result.stderr, /--workspace WORKSPACE_NAME_OR_ID/);
        assert.equal(requests.length, 0);
        await assert.rejects(readFile(path.join(projectDir, ".nams", "config.json"), "utf8"), {
          code: "ENOENT",
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

test("workspaces configure rejects legacy workspace-id equals flag before dispatch", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl, requests) => {
        const result = await runCli(
          ["workspaces", "configure", "codex", "--scope", "project", "--workspace-id=workspace-only"],
          {},
          runtimeEnv(path.join(projectDir, "home"), baseUrl),
          projectDir,
        );

        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Usage:/);
        assert.doesNotMatch(result.stderr, /--workspace-id/);
        assert.equal(requests.length, 0);
        await assert.rejects(readFile(path.join(projectDir, ".nams", "config.json"), "utf8"), {
          code: "ENOENT",
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

test("workspaces configure opencode session scope writes selected workspace by exact id", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    await withWorkspaceServer(
      async (baseUrl, requests) => {
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
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.method, "GET");
        assert.equal(requests[0]?.url, "/v1/users/me/workspaces");
        assert.equal(requests[0]?.headers.authorization, "Bearer test-api-key");
        assert.equal(requests[0]?.headers["x-workspace-id"], undefined);
        await assert.rejects(readFile(path.join(projectDir, ".nams", "config.json"), "utf8"), {
          code: "ENOENT",
        });

        const state = await readOnlySessionState(homeDir, "opencode");
        assert.equal(state.harness, "opencode");
        assert.equal(state.harnessSessionId, "session-1");
        assert.equal(state.sessionKey, "session-1");
        assert.equal(state.projectDirectory, projectDir);
        assert.deepEqual(
          {
            ...state.workspace,
            selectedAt: typeof state.workspace?.selectedAt,
          },
          {
            id: "workspace-2",
            source: "session-selection",
            selectedAt: "string",
          },
        );
        assert.doesNotThrow(() => new Date(String(state.workspace?.selectedAt)).toISOString());
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

test("workspaces configure opencode session scope preserves existing session fields while replacing only workspace", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  const existingState = {
    harness: "opencode",
    harnessSessionId: "session-1",
    sessionKey: "session-1",
    projectDirectory: projectDir,
    conversationId: "conversation-1",
    createdAt: "2026-05-11T12:00:00.000Z",
    lastRecallAt: "2026-05-11T12:01:00.000Z",
    pendingMemoryContext: {
      messageId: "message-1",
      content: "remember this",
      createdAt: "2026-05-11T12:02:00.000Z",
    },
    lastUserMessageHash: "user-hash",
    lastAssistantMessageHash: "assistant-hash",
    seenUserMessageIds: ["message-1"],
    seenAssistantPartIds: ["part-1"],
    seenAssistantMessageHashes: ["assistant-message-hash"],
    seenTranscriptEntryIds: ["entry-1"],
    seenReasoningStepHashes: ["reasoning-hash"],
    seenToolCallIds: ["tool-call-1"],
    reasoningStepIdsByHash: { "reasoning-hash": "reasoning-step-1" },
    workspace: {
      id: "workspace-1",
      source: "runtime-single-workspace",
      selectedAt: "2026-05-11T12:03:00.000Z",
    },
  };
  try {
    const statePath = path.join(
      homeDir,
      ".nams",
      "state",
      "opencode",
      `session-2026-05-11T120000.000Z--${sha256("session-1")}.json`,
    );
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(existingState, null, 2)}\n`);

    await withWorkspaceServer(
      async (baseUrl) => {
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
        const state = await readOnlySessionState(homeDir, "opencode");
        assert.deepEqual(
          {
            ...state,
            workspace: {
              ...state.workspace,
              selectedAt: typeof state.workspace?.selectedAt,
            },
          },
          {
            ...existingState,
            workspace: {
              id: "workspace-2",
              source: "session-selection",
              selectedAt: "string",
            },
          },
        );
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

test("workspaces configure opencode session scope accepts exact workspace name and stores matching id", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
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
        const state = await readOnlySessionState(homeDir, "opencode");
        assert.equal(state.workspace?.id, "workspace-2");
        assert.equal(state.workspace?.source, "session-selection");
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

test("workspaces configure opencode session scope requires session id before listing workspaces", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    await withWorkspaceServer(async (baseUrl, requests) => {
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

test("workspaces configure opencode session scope rejects missing session id value before dispatch", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    await withWorkspaceServer(async (baseUrl, requests) => {
      const result = await runCli(
        [
          "workspaces",
          "configure",
          "opencode",
          "--scope",
          "session",
          "--session-id",
          "--workspace",
          "workspace-1",
        ],
        {},
        runtimeEnv(homeDir, baseUrl),
        projectDir,
      );

      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Usage:/);
      assert.equal(requests.length, 0);
      assert.deepEqual(await sessionStateFiles(homeDir, "opencode"), []);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure opencode session scope requires home before listing workspaces", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  try {
    await withWorkspaceServer(async (baseUrl, requests) => {
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
          "workspace-1",
        ],
        {},
        runtimeEnvWithoutHome(baseUrl),
        projectDir,
      );

      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /HOME|USERPROFILE|home/i);
      assert.equal(requests.length, 0);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure opencode session scope rejects symlinked state parent before listing workspaces", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  const stateTarget = path.join(projectDir, "state-target");
  try {
    await mkdir(path.join(homeDir, ".nams"), { recursive: true });
    await mkdir(stateTarget, { recursive: true });
    await symlink(stateTarget, path.join(homeDir, ".nams", "state"));

    await withWorkspaceServer(async (baseUrl, requests) => {
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
          "workspace-1",
        ],
        {},
        runtimeEnv(homeDir, baseUrl),
        projectDir,
      );

      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /symbolic link|session state path/i);
      assert.equal(requests.length, 0);
      await assert.rejects(stat(path.join(stateTarget, "opencode")), { code: "ENOENT" });
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure opencode session scope rejects unsafe existing state file before listing workspaces", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    const stateDir = path.join(homeDir, ".nams", "state", "opencode");
    const statePath = path.join(
      stateDir,
      `session-2026-05-11T120000.000Z--${sha256("session-1")}.json`,
    );
    const targetPath = path.join(projectDir, "target-state.json");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      targetPath,
      `${JSON.stringify(
        {
          harness: "opencode",
          harnessSessionId: "session-1",
          sessionKey: "session-1",
          projectDirectory: projectDir,
          createdAt: "2026-05-11T12:00:00.000Z",
          seenAssistantMessageHashes: [],
          seenTranscriptEntryIds: [],
          seenReasoningStepHashes: [],
          seenToolCallIds: [],
          reasoningStepIdsByHash: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await symlink(targetPath, statePath);

    await withWorkspaceServer(async (baseUrl, requests) => {
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
          "workspace-1",
        ],
        {},
        runtimeEnv(homeDir, baseUrl),
        projectDir,
      );

      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /symbolic link|unsafe session state/i);
      assert.equal(requests.length, 0);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure opencode session scope rejects symlinked project config before loading config", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    const configDir = path.join(projectDir, ".nams");
    const configPath = path.join(configDir, "config.json");
    const targetPath = path.join(projectDir, "target-config.json");
    const targetContent = `${JSON.stringify({ apiKey: "target-key" }, null, 2)}\n`;
    await mkdir(configDir, { recursive: true });
    await writeFile(targetPath, targetContent, { mode: 0o644 });
    await chmod(targetPath, 0o644);
    await symlink(targetPath, configPath);

    await withWorkspaceServer(async (baseUrl, requests) => {
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
          "workspace-1",
        ],
        {},
        runtimeEnv(homeDir, baseUrl),
        projectDir,
      );

      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /symbolic link/);
      assert.equal(await readFile(targetPath, "utf8"), targetContent);
      assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
      assert.equal(requests.length, 0);
      assert.deepEqual(await sessionStateFiles(homeDir, "opencode"), []);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure opencode session scope rejects hard-linked project config before loading config", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    const configDir = path.join(projectDir, ".nams");
    const configPath = path.join(configDir, "config.json");
    const targetPath = path.join(projectDir, "target-config.json");
    const targetContent = `${JSON.stringify({ apiKey: "target-key" }, null, 2)}\n`;
    await mkdir(configDir, { recursive: true });
    await writeFile(targetPath, targetContent, { mode: 0o644 });
    await chmod(targetPath, 0o644);
    await link(targetPath, configPath);

    await withWorkspaceServer(async (baseUrl, requests) => {
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
          "workspace-1",
        ],
        {},
        runtimeEnv(homeDir, baseUrl),
        projectDir,
      );

      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /hard link|unsafe config path/);
      assert.equal(await readFile(targetPath, "utf8"), targetContent);
      assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
      assert.equal(requests.length, 0);
      assert.deepEqual(await sessionStateFiles(homeDir, "opencode"), []);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure opencode session scope reports unknown workspace selector without writing state", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
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
            "workspace-missing",
          ],
          {},
          runtimeEnv(homeDir, baseUrl),
          projectDir,
        );

        assert.equal(result.code, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /workspace-missing/);
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

test("workspaces configure opencode session scope reports no valid workspaces for explicit selector", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
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
            "workspace-1",
          ],
          {},
          runtimeEnv(homeDir, baseUrl),
          projectDir,
        );

        assert.equal(result.code, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /No NAMS workspaces were returned/);
        assert.doesNotMatch(result.stderr, /was not found/);
        assert.deepEqual(await sessionStateFiles(homeDir, "opencode"), []);
      },
      { workspaces: [] },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure opencode session scope reports ambiguous exact workspace name without writing state", async () => {
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-")));
  const homeDir = path.join(projectDir, "home");
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("workspaces configure rejects symlinked project config before loading config", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    const configDir = path.join(projectDir, ".nams");
    const configPath = path.join(configDir, "config.json");
    const targetPath = path.join(projectDir, "target-config.json");
    const targetContent = `${JSON.stringify({ apiKey: "target-key" }, null, 2)}\n`;
    await mkdir(configDir, { recursive: true });
    await writeFile(targetPath, targetContent, { mode: 0o644 });
    await chmod(targetPath, 0o644);
    await symlink(targetPath, configPath);

    await withWorkspaceServer(async (baseUrl, requests) => {
      const result = await runCli(
        ["workspaces", "configure", "codex", "--scope", "project", "--workspace", "workspace-1"],
        {},
        runtimeEnv(path.join(projectDir, "home"), baseUrl),
        projectDir,
      );

      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /symbolic link/);
      assert.equal(await readFile(targetPath, "utf8"), targetContent);
      assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
      assert.equal(requests.length, 0);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure rejects hard-linked project config before loading config", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    const configDir = path.join(projectDir, ".nams");
    const configPath = path.join(configDir, "config.json");
    const targetPath = path.join(projectDir, "target-config.json");
    const targetContent = `${JSON.stringify({ apiKey: "target-key" }, null, 2)}\n`;
    await mkdir(configDir, { recursive: true });
    await writeFile(targetPath, targetContent, { mode: 0o644 });
    await chmod(targetPath, 0o644);
    await link(targetPath, configPath);

    await withWorkspaceServer(async (baseUrl, requests) => {
      const result = await runCli(
        ["workspaces", "configure", "codex", "--scope", "project", "--workspace", "workspace-1"],
        {},
        runtimeEnv(path.join(projectDir, "home"), baseUrl),
        projectDir,
      );

      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /hard link|unsafe config path/);
      assert.equal(await readFile(targetPath, "utf8"), targetContent);
      assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
      assert.equal(requests.length, 0);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure user scope rejects unsafe project config before loading config", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    const configDir = path.join(projectDir, ".nams");
    const configPath = path.join(configDir, "config.json");
    const targetPath = path.join(projectDir, "target-config.json");
    const targetContent = `${JSON.stringify({ baseUrl: "https://project.example" }, null, 2)}\n`;
    await mkdir(configDir, { recursive: true });
    await writeFile(targetPath, targetContent, { mode: 0o644 });
    await chmod(targetPath, 0o644);
    await link(targetPath, configPath);

    await withWorkspaceServer(async (baseUrl, requests) => {
      const result = await runCli(
        ["workspaces", "configure", "codex", "--scope", "user", "--workspace", "workspace-1"],
        {},
        runtimeEnv(path.join(projectDir, "home"), baseUrl),
        projectDir,
      );

      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /hard link|unsafe config path/);
      assert.equal(await readFile(targetPath, "utf8"), targetContent);
      assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
      assert.equal(requests.length, 0);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure user scope requires home before listing workspaces", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(async (baseUrl, requests) => {
      const result = await runCli(
        ["workspaces", "configure", "codex", "--scope", "user", "--workspace", "workspace-1"],
        {},
        runtimeEnvWithoutHome(baseUrl),
        projectDir,
      );

      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /HOME|USERPROFILE|home/i);
      assert.equal(requests.length, 0);
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure failure reports sanitized stderr and writes no config", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const result = await runCli(
          ["workspaces", "configure", "codex", "--scope", "project", "--workspace", "workspace-2"],
          {},
          runtimeEnv(path.join(projectDir, "home"), baseUrl),
          projectDir,
        );

        assert.equal(result.code, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /NAMS workspace request failed/);
        assert.doesNotMatch(result.stderr, /backend exploded/);
        assert.doesNotMatch(result.stderr, /test-api-key/);
        await assert.rejects(readFile(path.join(projectDir, ".nams", "config.json"), "utf8"), {
          code: "ENOENT",
        });
      },
      { error: "backend exploded", apiKey: "test-api-key" },
      500,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure reports when no valid workspaces are returned", async () => {
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

        assert.equal(result.code, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /No NAMS workspaces were returned/);
        assert.doesNotMatch(result.stderr, /Re-run with --workspace-id/);
      },
      { workspaces: [] },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure reports requested workspace selector not found", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const result = await runCli(
          ["workspaces", "configure", "codex", "--scope", "project", "--workspace", "workspace-missing"],
          {},
          runtimeEnv(path.join(projectDir, "home"), baseUrl),
          projectDir,
        );

        assert.equal(result.code, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Requested NAMS workspace was not found: workspace-missing/);
        assert.match(result.stderr, /workspace-1/);
      },
      {
        workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
      },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure reports ambiguous workspace names for durable scopes", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const result = await runCli(
          ["workspaces", "configure", "codex", "--scope", "project", "--workspace", "Engineering"],
          {},
          runtimeEnv(path.join(projectDir, "home"), baseUrl),
          projectDir,
        );

        assert.equal(result.code, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Requested NAMS workspace name is ambiguous: Engineering/);
        assert.match(result.stderr, /workspace-1/);
        assert.match(result.stderr, /workspace-2/);
        await assert.rejects(readFile(path.join(projectDir, ".nams", "config.json"), "utf8"), {
          code: "ENOENT",
        });
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

test("workspaces configure requires selection when multiple valid workspaces are returned", async () => {
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

        assert.equal(result.code, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /NAMS workspace selection required/);
        assert.match(result.stderr, /workspace-1/);
        assert.match(result.stderr, /workspace-2/);
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
