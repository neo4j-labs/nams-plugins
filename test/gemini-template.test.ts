import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  assert.match(command.prompt, /nams-hooks workspaces run gemini --event CustomCommand/);
  assert.match(command.prompt, /echo '\{ "command_name": "nams:workspace", "command_args": "\{\{args\}\}" \}'/);
  assert.doesNotMatch(command.prompt, /<<'NAMS_WORKSPACE_ARGS'/);
  assert.doesNotMatch(command.prompt, /\$\{extensionPath\}|bin\/cli\.js/);
  assert.doesNotMatch(command.prompt, /node -e/);
  assert.doesNotMatch(command.prompt, /process\.stdin/);
  assert.doesNotMatch(command.prompt, /process\.argv/);
  assert.doesNotMatch(command.prompt, /workspaces configure/);
});

test("Gemini workspace command TOML parser rejects invalid basic string escapes", () => {
  assert.throws(
    () => parseGeminiWorkspaceCommandToml('description = "x"\n\nprompt = """\ninvalid \\s escape\n"""\n'),
    /invalid TOML basic string escape: \\s/,
  );
});

test("Gemini workspace custom command forwards ordinary selector through installed nams-hooks", async () => {
  const source = await readFile(path.join(repoRoot, "templates", "gemini", "commands", "nams", "workspace.toml"), "utf8");
  const command = parseGeminiWorkspaceCommandToml(source);
  const tempDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-command-"));

  try {
    const payloadPath = path.join(tempDir, "payload.json");
    const binDir = path.join(tempDir, "bin");
    const stubCliPath = path.join(binDir, "nams-hooks");
    await mkdir(binDir, { recursive: true });
    await writeFile(stubCliPath, stubCliSource(payloadPath), "utf8");
    await chmod(stubCliPath, 0o755);

    const shellCommand = shellCommandForGeminiPrompt(command.prompt, "use Engineering Team");
    await execFileAsync("/bin/sh", ["-c", shellCommand], {
      cwd: tempDir,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
    });

    const payload = JSON.parse(await readFile(payloadPath, "utf8"));
    assert.deepEqual(payload.argv, ["workspaces", "run", "gemini", "--event", "CustomCommand"]);
    assert.equal(payload.body.command_name, "nams:workspace");
    assert.equal(payload.body.command_args, "use Engineering Team");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function shellCommandForGeminiPrompt(prompt: string, args: string) {
  const trimmed = prompt.trim();
  assert.ok(trimmed.startsWith("!{") && trimmed.endsWith("}"), "Gemini prompt must wrap a shell command in !{...}.");

  return trimmed
    .slice(2, -1)
    .trim()
    .replace("{{args}}", shellQuote(args));
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stubCliSource(payloadPath: string) {
  return `#!/usr/bin/env node
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
