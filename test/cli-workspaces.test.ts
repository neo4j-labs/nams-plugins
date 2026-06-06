import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

function runCli(
  args: string[],
  payload: Record<string, unknown>,
  cwd: string,
  env: Record<string, string | undefined>,
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
      response.end(
        JSON.stringify({
          workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
        }),
      );
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
  const env = { ...process.env };
  delete env.NAMS_WORKSPACE_ID;
  return {
    ...env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    NAMS_API_KEY: "test-api-key",
    NAMS_BASE_URL: baseUrl,
  };
}

test("workspaces gemini BeforeAgent lists workspaces without workspace header", async () => {
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
        projectDir,
        runtimeEnv(path.join(projectDir, "home"), baseUrl),
      );

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        continue: true,
        suppressOutput: true,
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "GET");
      assert.equal(requests[0].url, "/v1/users/me/workspaces");
      assert.equal(requests[0].headers.authorization, "Bearer test-api-key");
      assert.equal(requests[0].headers["x-workspace-id"], undefined);
    });
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
      projectDir,
      runtimeEnv(path.join(projectDir, "home"), "http://127.0.0.1:9"),
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage:/);
    assert.match(result.stderr, /workspaces <gemini\|claude\|codex\|opencode> --event <BeforeAgent\|InstallConfigure>/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
