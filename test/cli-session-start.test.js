import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, ".build", "tsc", "cli.js");

function runCliWithEvent(harness, event, payload, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "run", harness, "--event", event], {
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

function runCli(harness, payload, cwd) {
  return runCliWithEvent(harness, "SessionStart", payload, cwd);
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

for (const harness of ["gemini", "claude", "codex", "opencode"]) {
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

      const logPath =
        harness === "gemini" || harness === "opencode"
          ? await singleSessionLogPath(projectDir)
          : path.join(projectDir, ".nams", "logs", `${harness}-session-start.jsonl`);
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
    assert.match(result.stderr, /--event <SessionStart\|BeforeAgent\|AfterAgent\|AfterTool>/);
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
    const logPath = await singleSessionLogPath(projectDir);
    const entry = JSON.parse((await readFile(logPath, "utf8")).trim());
    assert.deepEqual(entry.payload, payload);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("opencode writes session log and state under directory when cwd is also present", async () => {
  const cwdDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-cwd-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-project-"));
  try {
    const payload = {
      hook: "session.created",
      input: { sessionID: "opencode-directory-wins" },
      cwd: cwdDir,
      directory: projectDir,
    };

    const result = await runCli("opencode", payload, cwdDir);

    assert.equal(result.code, 0, result.stderr);
    const entry = JSON.parse((await readFile(await singleSessionLogPath(projectDir), "utf8")).trim());
    assert.deepEqual(entry.payload, payload);
    assert.equal((await sessionStateFiles(projectDir, "opencode")).length, 1);
    assert.deepEqual(await sessionStateFiles(cwdDir, "opencode"), []);
  } finally {
    await rm(cwdDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

for (const event of ["BeforeAgent", "AfterAgent", "AfterTool"]) {
  test(`routes opencode ${event} hook event`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const result = await runCliWithEvent(
        "opencode",
        event,
        {
          hook: "test",
          input: { sessionID: `opencode-${event}` },
          directory: projectDir,
        },
        projectDir,
      );

      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).continue, true);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test(`routes gemini ${event} hook event`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const payload = {
        session_id: `gemini-${event}`,
        hook_event_name: "WrongEventNameMustNotMatter",
        cwd: projectDir,
      };

      const result = await runCliWithEvent("gemini", event, payload, projectDir);

      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).continue, true);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
}

async function singleSessionLogPath(projectDir) {
  const logDir = path.join(projectDir, ".nams", "logs");
  const logFiles = (await readdir(logDir)).filter((fileName) => /^session-.*\.jsonl$/.test(fileName));
  assert.equal(logFiles.length, 1, `expected one session log file, got ${logFiles.join(", ")}`);
  return path.join(logDir, logFiles[0]);
}

async function sessionStateFiles(projectDir, harness) {
  try {
    return await readdir(path.join(projectDir, ".nams", "state", "sessions", harness));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
