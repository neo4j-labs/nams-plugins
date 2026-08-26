import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  completedItem,
  jsonl,
  responseItem,
  sessionMeta,
  taskComplete,
} from "./support/codex-rollout-fixture.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, ".build", "tsc", "cli.js");

interface CliResult { code: number | null; stdout: string; stderr: string }
interface CapturedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

async function withNamsServer<T>(
  handler: (baseUrl: string, requests: CapturedRequest[]) => Promise<T>,
): Promise<T> {
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
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    );
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
  requests.push({
    path: pathname,
    headers: request.headers,
    body: text === "" ? undefined : JSON.parse(text),
  });
  if (request.method === "POST" && pathname === "/v1/conversations") {
    return json(response, 201, { id: "conversation-1" });
  }
  if (
    request.method === "POST"
    && pathname === "/v1/conversations/conversation-1/messages"
  ) {
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

test("replay codex groups root and subagent files without reading stdin", async () => {
  await withNamsServer(async (baseUrl, requests) => {
    const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-replay-"));
    try {
      const project = path.join(fixture, "project");
      const home = path.join(fixture, "home");
      const codexHome = path.join(fixture, "codex");
      const rootPath = path.join(codexHome, "sessions", "root.jsonl");
      const childPath = path.join(codexHome, "sessions", "subagents", "child.jsonl");
      const outsidePath = path.join(codexHome, "sessions", "outside.jsonl");
      await mkdir(project, { recursive: true });
      await mkdir(path.dirname(childPath), { recursive: true });
      await writeFile(rootPath, jsonl([
        sessionMeta({ sessionId: "session-1", cwd: project, threadSource: "user" }),
        completedItem(1, "thread-root", "turn-1", {
          type: "UserMessage",
          content: [{ type: "text", text: "Remember replay." }],
        }),
        responseItem(2, "turn-1", {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          encrypted_content: "do-not-store",
        }),
        responseItem(3, "turn-1", {
          type: "custom_tool_call",
          call_id: "call-1",
          name: "exec",
          input: "pwd",
        }),
        responseItem(4, "turn-1", {
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: [
            { type: "input_text", text: "Script completed\nOutput:\n" },
            { type: "input_text", text: project },
          ],
        }),
        taskComplete(5, "thread-root", "turn-1"),
      ]), "utf8");
      await writeFile(childPath, jsonl([
        sessionMeta({
          sessionId: "session-1",
          threadId: "thread-child",
          cwd: project,
          threadSource: "subagent",
        }),
      ]), "utf8");
      await writeFile(outsidePath, jsonl([
        sessionMeta({
          sessionId: "outside-session",
          cwd: path.join(fixture, "outside-project"),
          threadSource: "user",
        }),
      ]), "utf8");

      const result = await runCli(
        ["replay", "codex", "--working-dir", project],
        project,
        {
          HOME: home,
          CODEX_HOME: codexHome,
          NAMS_API_KEY: "key",
          NAMS_WORKSPACE_ID: "workspace-1",
          NAMS_BASE_URL: baseUrl,
        },
        "{not-json",
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stdout,
        /Replay codex: discovered files 3, matched files 2, skipped files 1, sessions 1/,
      );
      assert.deepEqual(requests.map((request) => request.path), [
        "/v1/conversations",
        "/v1/conversations/conversation-1/messages",
        "/v1/reasoning/steps",
        "/v1/reasoning/tool-calls",
      ]);
      assert.equal(requests[0].headers["x-nams-hooks-harness"], "codex");
      assert.equal(requests[0].headers["x-nams-hooks-command"], "replay");
      assert.equal(requests[0].headers["x-nams-hooks-event"], undefined);
      assert.equal(result.stderr.includes(`Codex replay file imported: ${rootPath}\n`), true);
      assert.equal(result.stderr.includes(`Codex replay file imported: ${childPath}\n`), true);
      assert.equal(result.stderr.includes(`Codex replay file skipped: ${outsidePath}\n`), true);
      assert.match(
        result.stderr,
        /Codex replay outbox: .*nams-hooks-codex-replay-.*[\\/]outbox\.jsonl/,
      );
      await assert.rejects(access(path.join(home, ".nams", "state")), { code: "ENOENT" });
      await assert.rejects(access(path.join(home, ".nams", "logs")), { code: "ENOENT" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

test("replay defaults the import root to the child cwd", async () => {
  await withNamsServer(async (baseUrl) => {
    const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "nams-cli-replay-")));
    try {
      const codexHome = path.join(fixture, "codex");
      const rolloutPath = path.join(codexHome, "sessions", "rollout.jsonl");
      await mkdir(path.dirname(rolloutPath), { recursive: true });
      await writeFile(rolloutPath, jsonl([
        sessionMeta({ sessionId: "session-1", cwd: fixture, threadSource: "user" }),
      ]), "utf8");
      const result = await runCli(["replay", "codex"], fixture, {
        HOME: path.join(fixture, "home"),
        CODEX_HOME: codexHome,
        NAMS_API_KEY: "key",
        NAMS_WORKSPACE_ID: "workspace-1",
        NAMS_BASE_URL: baseUrl,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /matched files 1, skipped files 0, sessions 1/);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

test("replay rejects Claude and malformed arguments", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-cli-replay-"));
  try {
    for (const args of [
      ["replay", "claude"],
      ["replay", "gemini"],
      ["replay", "codex", "--working-dir"],
      ["replay", "codex", "--working-dir", ""],
      ["replay", "codex", `--working-dir=${fixture}`],
      ["replay", "codex", "--working-dir", fixture, "extra"],
    ]) {
      const result = await runCli(args, fixture, {});
      assert.equal(result.code, 1);
      assert.match(result.stderr, /nams-hooks replay codex \[--working-dir PATH\]/);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a missing Codex transcript root is a successful zero import", async () => {
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
      assert.match(result.stdout, /discovered files 0, matched files 0, skipped files 0, sessions 0/);
      const outboxPrefix = "Codex replay outbox: ";
      const outboxLine = result.stderr
        .split("\n")
        .find((line) => line.startsWith(outboxPrefix));
      assert.ok(outboxLine);
      await assert.rejects(access(outboxLine.slice(outboxPrefix.length)), { code: "ENOENT" });
      assert.deepEqual(requests, []);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
