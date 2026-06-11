#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const usage = "Usage: /nams-hooks workspaces use <workspace-id-or-name>";
const rawArguments = process.argv.slice(2).join(" ").trim();
const match = /^workspaces use (.+)$/.exec(rawArguments);
const selector = match?.[1]?.trim() ?? "";

if (selector.length === 0) {
  console.error(usage);
  process.exit(1);
}

const sessionId = process.env.CLAUDE_SESSION_ID?.trim() ?? "";
if (sessionId.length === 0) {
  console.error("Claude session id is unavailable; cannot configure a session workspace automatically.");
  console.error(`Run manually: nams-hooks workspaces configure claude --scope session --session-id <session-id> --workspace ${selector}`);
  process.exit(1);
}

const skillDir = process.env.CLAUDE_SKILL_DIR?.trim() ?? "";
if (skillDir.length === 0) {
  console.error("Cannot locate the bundled nams-hooks runtime because CLAUDE_SKILL_DIR is unavailable.");
  process.exit(1);
}

const pluginRoot = path.resolve(skillDir, "..", "..");
const cliPath = path.join(pluginRoot, "bin", "cli.js");
const child = spawn(process.execPath, [
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
], {
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Failed to run bundled nams-hooks CLI: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    console.error(`Bundled nams-hooks CLI exited due to signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
