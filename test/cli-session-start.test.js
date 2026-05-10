import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, ".build", "tsc", "cli.js");

function runCli(harness, payload, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "run", harness, "--event", "SessionStart"], {
      cwd,
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

function runCliWithoutEvent(harness, payload, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "run", harness], {
      cwd,
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

for (const harness of ["gemini", "claude", "codex"]) {
  test(`logs ${harness} session-start JSON payload`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const payload = {
        session_id: `${harness}-session-1`,
        hook_event_name: "SessionStart",
        cwd: projectDir,
        timestamp: "2026-05-10T09:00:00.000Z",
      };

      const result = await runCli(harness, payload, projectDir);

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        continue: true,
        suppressOutput: true,
      });

      const logPath = path.join(projectDir, ".nams", "logs", `${harness}-session-start.jsonl`);
      const lines = (await readFile(logPath, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.harness, harness);
      assert.equal(entry.event, "SessionStart");
      assert.deepEqual(entry.payload, payload);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
}

test("requires explicit typed hook event", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
  try {
    const result = await runCliWithoutEvent("gemini", { cwd: projectDir }, projectDir);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--event <SessionStart>/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("writes fallback logs under child process cwd when payload omits cwd", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
  try {
    const payload = {
      session_id: "gemini-session-no-cwd",
      hook_event_name: "SessionStart",
    };

    const result = await runCli("gemini", payload, projectDir);

    assert.equal(result.code, 0, result.stderr);
    const logPath = path.join(projectDir, ".nams", "logs", "gemini-session-start.jsonl");
    const entry = JSON.parse((await readFile(logPath, "utf8")).trim());
    assert.deepEqual(entry.payload, payload);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
