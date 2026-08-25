import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, ".build", "tsc", "cli.js");

interface CliResult { code: number | null; stdout: string; stderr: string }
interface CapturedRequest { path: string; headers: Record<string, string | string[] | undefined>; body: unknown }

async function withNamsServer<T>(handler: (baseUrl: string, requests: CapturedRequest[]) => Promise<T>): Promise<T> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void handleRequest(request, response, requests);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    return await handler(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: CapturedRequest[],
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  requests.push({ path: pathname, headers: request.headers, body: text === "" ? undefined : JSON.parse(text) });
  if (request.method === "POST" && pathname === "/v1/conversations") return json(response, 201, { id: "conversation-1" });
  if (request.method === "POST" && pathname === "/v1/conversations/conversation-1/messages/bulk") return json(response, 201, { messages: [] });
  if (request.method === "POST" && pathname === "/v1/reasoning/steps") return json(response, 201, { id: "step-1" });
  if (request.method === "POST" && pathname === "/v1/reasoning/tool-calls") return json(response, 201, { id: "tool-1" });
  json(response, 404, { error: "unexpected endpoint" });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin = "",
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test("replay claude imports without reading stdin and writes no replay state or logs", async () => {
  await withNamsServer(async (baseUrl, requests) => {
    const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-replay-"));
    try {
      const project = path.join(fixture, "project");
      const home = path.join(fixture, "home");
      const transcriptDir = path.join(fixture, "claude", "projects", "encoded");
      await mkdir(project, { recursive: true });
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(path.join(transcriptDir, "session-1.jsonl"), [
        JSON.stringify({ type: "user", sessionId: "session-1", cwd: project, message: { role: "user", content: "Remember replay." } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Imported." } }),
      ].join("\n"), "utf8");

      const result = await runCli(["replay", "claude", "--working-dir", project], project, {
        HOME: home,
        CLAUDE_CONFIG_DIR: path.join(fixture, "claude"),
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: baseUrl,
      }, "{not-json");

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Replay claude: discovered 1, matched 1, imported 1, skipped 0, failed 0/);
      assert.match(result.stderr, /claude session-1: imported/);
      assert.deepEqual(requests.map((request) => request.path), [
        "/v1/conversations",
        "/v1/conversations/conversation-1/messages/bulk",
      ]);
      assert.equal(requests[0].headers["x-nams-hooks-command"], "replay");
      assert.equal(requests[0].headers["x-nams-hooks-event"], undefined);
      const createBody = requests[0].body as { metadata: Record<string, string> };
      assert.equal(Object.hasOwn(createBody.metadata, "title"), false);
      await assert.rejects(access(path.join(home, ".nams", "state")));
      await assert.rejects(access(path.join(home, ".nams", "logs")));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

test("replay defaults the import root to the child cwd", async () => {
  await withNamsServer(async (baseUrl) => {
    const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-replay-")));
    try {
      const transcriptDir = path.join(fixture, "codex", "sessions", "2026", "08");
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(path.join(transcriptDir, "rollout.jsonl"), [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-1", cwd: fixture } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "default cwd" } }),
      ].join("\n"), "utf8");
      const result = await runCli(["replay", "codex"], fixture, {
        HOME: path.join(fixture, "home"),
        CODEX_HOME: path.join(fixture, "codex"),
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: baseUrl,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /matched 1, imported 1/);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

test("replay rejects unsupported platforms malformed flags and extra arguments", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-replay-"));
  try {
    for (const args of [
      ["replay", "gemini"],
      ["replay", "claude", "--working-dir"],
      ["replay", "claude", "--working-dir", ""],
      ["replay", "claude", `--working-dir=${fixture}`],
      ["replay", "claude", "--working-dir", fixture, "extra"],
    ]) {
      const result = await runCli(args, fixture, {});
      assert.equal(result.code, 1);
      assert.match(result.stderr, /nams-hooks replay <claude\|codex>/);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a missing transcript root is a successful zero import", async () => {
  await withNamsServer(async (baseUrl, requests) => {
    const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-replay-"));
    try {
      const result = await runCli(["replay", "codex"], fixture, {
        HOME: path.join(fixture, "home"),
        CODEX_HOME: path.join(fixture, "missing-codex-home"),
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: baseUrl,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /discovered 0, matched 0, imported 0/);
      assert.deepEqual(requests, []);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
