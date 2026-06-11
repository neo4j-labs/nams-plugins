#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const commandName = "nams-hooks:nams-hooks";
const usage = `Usage: /${commandName} workspaces use <workspace-id-or-name>`;

const input = await readHookInput();
if (input.hook_event_name !== "UserPromptExpansion" || input.command_name !== commandName) {
  process.exit(0);
}

const rawArgs = stringValue(input.command_args).trim();
const match = /^workspaces\s+use\s+([\s\S]*)$/.exec(rawArgs);
const selector = match?.[1] ?? "";
if (selector.trim().length === 0) {
  block(usage);
}

const sessionId = stringValue(input.session_id).trim() || stringValue(process.env.CLAUDE_SESSION_ID).trim();
if (sessionId.length === 0) {
  block([
    "Claude session id is unavailable; cannot configure a session workspace automatically.",
    `Run manually: nams-hooks workspaces configure claude --scope session --session-id <session-id> --workspace ${selector}`,
  ].join("\n"));
}

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "bin", "cli.js");
const result = await runCli([
  cliPath,
  "workspaces",
  "configure",
  "claude",
  "--scope",
  "session",
  "--session-id",
  sessionId,
  "--workspace",
  selector,
]);

if (result.error !== undefined) {
  block(`Failed to run bundled nams-hooks CLI: ${result.error.message}`);
}

if (result.status !== 0) {
  block(["NAMS workspace selection failed.", result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n"));
}

block(result.stdout.trim() || "Configured NAMS workspace for this Claude session.");

async function readHookInput() {
  const stdin = await readStdin();
  try {
    const parsed = JSON.parse(stdin || "{}");
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    block("Unable to read Claude slash command input.");
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
    process.stdin.on("error", reject);
  });
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
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
    child.on("error", (error) => {
      resolve({ status: 1, stdout, stderr, error });
    });
    child.on("exit", (code) => {
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}

function block(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
  process.exit(0);
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}
