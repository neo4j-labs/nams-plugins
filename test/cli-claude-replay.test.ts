import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assistantBlock,
  humanMessage,
  jsonl,
  toolResult,
} from "./support/claude-rollout-fixture.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, ".build", "tsc", "cli.js");

interface CapturedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

async function withClaudeNamsServer<T>(
  callback: (baseUrl: string, requests: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void respond(request, response, requests);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    return await callback(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    );
  }
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  requests: CapturedRequest[],
): Promise<void> {
  for await (const _chunk of request) {
    // Drain request bodies so the local HTTP connection can be reused.
  }
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  requests.push({ path: pathname, headers: request.headers });
  if (request.method === "POST" && pathname === "/v1/conversations") {
    return json(response, 201, { id: "conversation-1" });
  }
  if (request.method === "POST" && pathname === "/v1/conversations/conversation-1/messages") {
    return json(response, 201, { id: "message-1" });
  }
  if (request.method === "POST" && pathname === "/v1/reasoning/steps") {
    return json(response, 201, { id: "step-1" });
  }
  if (request.method === "POST" && pathname === "/v1/reasoning/tool-calls") {
    return json(response, 201, { id: "tool-1" });
  }
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
): Promise<{ code: number | null; stdout: string; stderr: string }> {
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

test("replay claude imports a session without stdin or live session state", async () => {
  await withClaudeNamsServer(async (baseUrl, requests) => {
    const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-claude-replay-"));
    try {
      const project = path.join(fixture, "project");
      const home = path.join(fixture, "home");
      const claudeRoot = path.join(fixture, "claude");
      const rootPath = path.join(claudeRoot, "projects", "encoded", "session-1.jsonl");
      await mkdir(path.dirname(rootPath), { recursive: true });
      await mkdir(project, { recursive: true });
      await writeFile(rootPath, jsonl([
        humanMessage({
          sessionId: "session-1", cwd: project, uuid: "user", parentUuid: "root",
          content: "Remember Claude replay.", timestamp: "2026-08-26T12:00:01.000Z",
        }),
        assistantBlock({
          sessionId: "session-1", cwd: project, uuid: "text", parentUuid: "user",
          messageId: "message-1", block: { type: "text", text: "I will inspect." },
          timestamp: "2026-08-26T12:00:02.000Z",
        }),
        assistantBlock({
          sessionId: "session-1", cwd: project, uuid: "call", parentUuid: "text",
          messageId: "message-1", block: {
            type: "tool_use", id: "call-1", name: "Read", input: { file_path: "src/a.ts" },
          }, timestamp: "2026-08-26T12:00:02.100Z",
        }),
        toolResult({
          sessionId: "session-1", cwd: project, uuid: "result", parentUuid: "call",
          toolUseId: "call-1", content: "contents", timestamp: "2026-08-26T12:00:03.000Z",
        }),
      ]), "utf8");

      const result = await runCli(
        ["replay", "claude", "--working-dir", project],
        project,
        {
          HOME: home,
          CLAUDE_CONFIG_DIR: claudeRoot,
          NAMS_API_KEY: "key",
          NAMS_WORKSPACE_ID: "workspace-1",
          NAMS_BASE_URL: baseUrl,
        },
        "{not-json",
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stdout,
        /Replay claude: discovered files 1, matched files 1, skipped files 0, sessions 1/,
      );
      assert.deepEqual(requests.map((request) => request.path), [
        "/v1/conversations",
        "/v1/conversations/conversation-1/messages",
        "/v1/conversations/conversation-1/messages",
        "/v1/reasoning/steps",
        "/v1/reasoning/tool-calls",
      ]);
      assert.equal(requests[0].headers["x-nams-hooks-harness"], "claude");
      assert.equal(requests[0].headers["x-nams-hooks-command"], "replay");
      assert.equal(result.stderr.includes(`Claude replay file imported: ${rootPath}\n`), true);
      const prefix = "Claude replay outbox: ";
      const outboxLine = result.stderr.split("\n").find((line) => line.startsWith(prefix));
      assert.ok(outboxLine);
      await assert.rejects(access(outboxLine.slice(prefix.length)), { code: "ENOENT" });
      await assert.rejects(access(path.join(home, ".nams", "state")), { code: "ENOENT" });
      await assert.rejects(access(path.join(home, ".nams", "logs")), { code: "ENOENT" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
