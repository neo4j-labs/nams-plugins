import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
      runtimeEnv(path.join(projectDir, "home"), "http://127.0.0.1:9"),
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage:/);
    assert.match(result.stderr, /workspaces <gemini\|claude\|codex\|opencode> --event <BeforeAgent\|InstallConfigure>/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspaces configure codex writes project config for explicit workspace", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const result = await runCli(
          ["workspaces", "configure", "codex", "--scope", "project", "--workspace-id", "workspace-2"],
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
        ["workspaces", "configure", "codex", "--scope", "project", "--workspace-id", "workspace-1"],
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
        ["workspaces", "configure", "codex", "--scope", "project", "--workspace-id", "workspace-1"],
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
        ["workspaces", "configure", "codex", "--scope", "user", "--workspace-id", "workspace-1"],
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

test("workspaces configure failure reports sanitized stderr and writes no config", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const result = await runCli(
          ["workspaces", "configure", "codex", "--scope", "project", "--workspace-id", "workspace-2"],
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

test("workspaces configure reports requested workspace ID not found", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-cli-workspaces-"));
  try {
    await withWorkspaceServer(
      async (baseUrl) => {
        const result = await runCli(
          ["workspaces", "configure", "codex", "--scope", "project", "--workspace-id", "workspace-missing"],
          {},
          runtimeEnv(path.join(projectDir, "home"), baseUrl),
          projectDir,
        );

        assert.equal(result.code, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Requested NAMS workspace ID was not found: workspace-missing/);
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
