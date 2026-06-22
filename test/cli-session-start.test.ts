import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { namsHome, runtimeEnv, sessionStateFiles, singleSessionLogPath } from "./support/runtime-home.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, ".build", "tsc", "cli.js");
const codexHooksTemplatePath = path.join(repoRoot, "templates", "local", "codex", ".codex", "hooks.json");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

type HookPayload = Record<string, unknown>;

function runCliWithEvent(
  harness: string,
  event: string,
  payload: HookPayload,
  cwd: string,
  homeDir = testHome(cwd),
): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "run", harness, "--event", event], {
      cwd,
      env: runtimeEnv(homeDir, process.env),
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

function runCli(harness: string, payload: HookPayload, cwd: string, homeDir?: string): Promise<CliResult> {
  return runCliWithEvent(harness, "SessionStart", payload, cwd, homeDir);
}

function runCliWithoutEvent(
  harness: string,
  payload: HookPayload,
  cwd: string,
  homeDir = testHome(cwd),
): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "run", harness], {
      cwd,
      env: runtimeEnv(homeDir, process.env),
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

function testHome(cwd: string): string {
  return path.join(cwd, "home");
}

async function fileMode(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

for (const harness of ["gemini", "claude", "codex", "opencode", "antigravity"] as const) {
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
      assert.deepEqual(
        JSON.parse(result.stdout),
        harness === "antigravity"
          ? {}
          : {
              continue: true,
              suppressOutput: true,
            },
      );

      const homeDir = testHome(projectDir);
      const logPath = await singleSessionLogPath(homeDir, harness);
      const lines = (await readFile(logPath, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      assert.equal(await fileMode(logPath), 0o600);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.harness, harness);
      assert.equal(entry.event, "SessionStart");
      assert.deepEqual(entry.payload, payload);
      if (harness === "codex") {
        await assert.rejects(readFile(path.join(namsHome(homeDir), "logs", "codex", "codex-session-start.jsonl")));
      }
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
    const logPath = await singleSessionLogPath(testHome(projectDir), "gemini");
    const entry = JSON.parse((await readFile(logPath, "utf8")).trim());
    assert.deepEqual(entry.payload, payload);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("opencode writes session log under directory and state under HOME when cwd is also present", async () => {
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
    const entry = JSON.parse((await readFile(await singleSessionLogPath(testHome(cwdDir), "opencode"), "utf8")).trim());
    assert.deepEqual(entry.payload, payload);
    assert.equal((await sessionStateFiles(testHome(cwdDir), "opencode")).length, 1);
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

  test(`routes antigravity ${event} hook event`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const payload = {
        conversationId: `antigravity-${event}`,
        workspacePaths: [projectDir],
        transcriptPath: path.join(projectDir, "transcript.jsonl"),
        artifactDirectoryPath: projectDir,
      };

      const result = await runCliWithEvent("antigravity", event, payload, projectDir);

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {});

      const logPath = await singleSessionLogPath(testHome(projectDir), "antigravity");
      const entry = (await readJsonl(logPath)).find((record) => record.kind === "hook.event");
      assert.ok(entry);
      assert.equal(entry.harness, "antigravity");
      assert.equal(entry.event, event);
      assert.deepEqual(entry.payload, payload);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
}

const claudeHookMappings = [
  ["UserPromptSubmit", "BeforeAgent"],
  ["Stop", "AfterAgent"],
  ["PostToolUse", "AfterTool"],
];

for (const [claudeHook, namsEvent] of claudeHookMappings) {
  test(`routes claude ${claudeHook} through NAMS ${namsEvent}`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const payload = {
        session_id: `claude-${namsEvent}`,
        hook_event_name: claudeHook,
        cwd: projectDir,
      };

      const result = await runCliWithEvent("claude", namsEvent, payload, projectDir);

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        continue: true,
        suppressOutput: true,
      });

      const logPath = await singleSessionLogPath(testHome(projectDir), "claude");
      const entry = (await readJsonl(logPath)).find((record) => record.kind === "hook.event");
      assert.ok(entry);
      assert.equal(entry.harness, "claude");
      assert.equal(entry.event, namsEvent);
      assert.deepEqual(entry.payload, payload);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
}

const codexNativeHookMappings = [
  {
    nativeHook: "UserPromptSubmit",
    namsEvent: "BeforeAgent",
    statusMessage: "NAMS memory recall",
  },
  {
    nativeHook: "Stop",
    namsEvent: "AfterAgent",
    statusMessage: "NAMS assistant persistence",
  },
  {
    nativeHook: "PostToolUse",
    namsEvent: "AfterTool",
    statusMessage: "NAMS tool metadata",
  },
];

for (const { nativeHook, namsEvent, statusMessage } of codexNativeHookMappings) {
  test(`maps Codex ${nativeHook} hook through ${namsEvent} NAMS event`, async () => {
    const template = JSON.parse(await readFile(codexHooksTemplatePath, "utf8"));
    assert.deepEqual(template.hooks[nativeHook], [
      {
        hooks: [
          {
            type: "command",
            command: `nams-hooks run codex --event ${namsEvent}`,
            statusMessage,
          },
        ],
      },
    ]);

    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const payload = {
        session_id: `codex-${nativeHook}`,
        hook_event_name: nativeHook,
        cwd: projectDir,
      };

      const result = await runCliWithEvent("codex", namsEvent, payload, projectDir);

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(
        JSON.parse(result.stdout),
        nativeHook === "PostToolUse" ? { continue: true } : { continue: true, suppressOutput: true },
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
}

for (const nativeHook of ["UserPromptSubmit", "Stop", "PostToolUse"]) {
  test(`rejects native Codex ${nativeHook} as typed NAMS event`, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-"));
    try {
      const payload = {
        session_id: `codex-invalid-${nativeHook}`,
        hook_event_name: nativeHook,
        cwd: projectDir,
      };

      const result = await runCliWithEvent("codex", nativeHook, payload, projectDir);

      assert.equal(result.code, 1);
      assert.match(result.stderr, /--event <SessionStart\|BeforeAgent\|AfterAgent\|AfterTool>/);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
}

async function readJsonl(logPath: string): Promise<Array<Record<string, any>>> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}
