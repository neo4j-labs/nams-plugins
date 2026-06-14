import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

test("Gemini extension template exposes NAMS environment settings in order", async () => {
  const template = JSON.parse(await readFile(path.join(repoRoot, "templates", "gemini", "gemini-extension.json"), "utf8"));
  const settings = template.settings;

  assert.ok(Array.isArray(settings), "Gemini extension settings must be an array.");
  assert.deepEqual(settings.map((setting) => setting.envVar), [
    "NAMS_API_KEY",
    "NAMS_WORKSPACE_ID",
    "NAMS_BASE_URL",
  ]);

  assert.equal(settings[0].sensitive, true);
  assert.equal(settings[1].sensitive, false);
  assert.equal(settings[2].sensitive, false);
  assert.match(settings[1].description, /Optional/);
});

test("Gemini hook template routes BeforeAgent through the memory hook only", async () => {
  const template = JSON.parse(await readFile(path.join(repoRoot, "templates", "gemini", "hooks", "hooks.json"), "utf8"));
  const groups = template.hooks.BeforeAgent;

  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, "*");
  assert.deepEqual(
    groups[0].hooks.map((hook: { name: string; command: string }) => ({ name: hook.name, command: hook.command })),
    [
      {
        name: "nams-memory-before-agent",
        command: 'node "${extensionPath}/bin/cli.js" run gemini --event BeforeAgent',
      },
    ],
  );
});

test("Gemini extension template packages nams workspace custom command", async () => {
  const source = await readFile(path.join(repoRoot, "templates", "gemini", "commands", "nams", "workspace.toml"), "utf8");
  const command = parseGeminiWorkspaceCommandToml(source);

  assert.equal(command.description, "Select the NAMS workspace for this Gemini session.");
  assert.match(command.prompt, /nams:workspace/);
  assert.match(command.prompt, /workspaces run gemini --event CustomCommand/);
  assert.match(command.prompt, /\{\{args\}\}/);
  assert.match(command.prompt, /<<'NAMS_WORKSPACE_ARGS'/);
  assert.match(command.prompt, /process\.stdin/);
  assert.doesNotMatch(command.prompt, /process\.argv/);
  assert.doesNotMatch(command.prompt, /'\s+\{\{args\}\}\s*\|/);
  assert.doesNotMatch(command.prompt, /workspaces configure/);
});

test("Gemini workspace command TOML parser rejects invalid basic string escapes", () => {
  assert.throws(
    () => parseGeminiWorkspaceCommandToml('description = "x"\n\nprompt = """\ninvalid \\s escape\n"""\n'),
    /invalid TOML basic string escape: \\s/,
  );
});

test("Gemini workspace custom command preserves selectors and normalizes use prefix", async () => {
  const source = await readFile(path.join(repoRoot, "templates", "gemini", "commands", "nams", "workspace.toml"), "utf8");
  const command = parseGeminiWorkspaceCommandToml(source);

  assert.deepEqual(await renderGeminiWorkspaceCommandArgs(command.prompt, ["Engineering", "Team"]), {
    command_name: "nams:workspace",
    command_args: "use Engineering Team",
  });
  assert.deepEqual(await renderGeminiWorkspaceCommandArgs(command.prompt, ["use", "Engineering", "Team"]), {
    command_name: "nams:workspace",
    command_args: "use Engineering Team",
  });
});

test("Gemini workspace custom command passes shell-sensitive args through heredoc literally", async () => {
  const source = await readFile(path.join(repoRoot, "templates", "gemini", "commands", "nams", "workspace.toml"), "utf8");
  const command = parseGeminiWorkspaceCommandToml(source);
  const tempDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-command-"));

  try {
    const sentinelPath = path.join(tempDir, "sentinel");
    const payloadPath = path.join(tempDir, "payload.json");
    const binDir = path.join(tempDir, "bin");
    const stubCliPath = path.join(binDir, "cli.js");
    await mkdir(binDir, { recursive: true });
    await writeFile(stubCliPath, stubCliSource(payloadPath), "utf8");

    const sensitiveArgs = `O'Reilly; $(touch ${sentinelPath}) "quoted"`;
    const shellCommand = shellCommandForGeminiPrompt(command.prompt, stubCliPath, sensitiveArgs);
    await execFileAsync("/bin/sh", ["-c", shellCommand], { cwd: tempDir });

    const payload = JSON.parse(await readFile(payloadPath, "utf8"));
    assert.deepEqual(payload.argv, ["workspaces", "run", "gemini", "--event", "CustomCommand"]);
    assert.equal(payload.body.command_name, "nams:workspace");
    assert.equal(payload.body.command_args, `use ${sensitiveArgs}`);
    assert.doesNotMatch(payload.body.command_args, /^use\s+use(?:\s|$)/);
    await assertFileMissing(sentinelPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function renderGeminiWorkspaceCommandArgs(command: string, args: string[]) {
  const script = command.match(/node -e '([^']+)'/)?.[1];
  assert.ok(script, "Gemini workspace command must use a node -e JSON bridge.");

  const { stdout } = await execFileWithInput(process.execPath, ["-e", script], args.join(" "));
  return JSON.parse(stdout.trim().replace(/\\n$/, ""));
}

function shellCommandForGeminiPrompt(prompt: string, stubCliPath: string, args: string) {
  const trimmed = prompt.trim();
  assert.ok(trimmed.startsWith("!{") && trimmed.endsWith("}"), "Gemini prompt must wrap a shell command in !{...}.");

  return trimmed
    .slice(2, -1)
    .trim()
    .replaceAll("${extensionPath}/bin/cli.js", stubCliPath)
    .replace("{{args}}", args);
}

function stubCliSource(payloadPath: string) {
  return `
const { writeFileSync } = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(payloadPath)}, JSON.stringify({
    argv: process.argv.slice(2),
    body: JSON.parse(input),
  }));
});
`;
}

async function assertFileMissing(filePath: string) {
  await assert.rejects(access(filePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}

async function execFileWithInput(command: string, args: string[], input: string) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
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
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr}`));
      }
    });
    child.stdin.end(input);
  });
}

function parseGeminiWorkspaceCommandToml(source: string) {
  const descriptionSource = source.match(/^description\s*=\s*"((?:\\.|[^"\\])*)"\s*$/m)?.[1];
  const promptSource = source.match(/^prompt\s*=\s*"""([\s\S]*)"""\s*$/m)?.[1]?.replace(/^\r?\n/, "");
  assert.ok(descriptionSource !== undefined, "Gemini workspace command TOML must define a basic string description.");
  assert.ok(promptSource !== undefined, "Gemini workspace command TOML must define a multiline basic string prompt.");

  return {
    description: parseTomlBasicString(descriptionSource),
    prompt: parseTomlBasicString(promptSource),
  };
}

function parseTomlBasicString(source: string) {
  let parsed = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char !== "\\") {
      parsed += char;
      continue;
    }

    index += 1;
    const escaped = source[index];
    if (escaped === undefined) {
      throw new Error("invalid TOML basic string escape at end of string");
    }
    if (escaped === "b") parsed += "\b";
    else if (escaped === "t") parsed += "\t";
    else if (escaped === "n") parsed += "\n";
    else if (escaped === "f") parsed += "\f";
    else if (escaped === "r") parsed += "\r";
    else if (escaped === '"') parsed += '"';
    else if (escaped === "\\") parsed += "\\";
    else {
      throw new Error(`invalid TOML basic string escape: \\${escaped}`);
    }
  }
  return parsed;
}
