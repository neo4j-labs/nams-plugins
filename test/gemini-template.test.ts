import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const marketplaceExtensionPath = path.join(repoRoot, "templates", "marketplace", "gemini", "gemini-extension.json");
const marketplaceHooksPath = path.join(repoRoot, "templates", "marketplace", "gemini", "hooks", "hooks.json");
const marketplaceCommandPath = path.join(repoRoot, "templates", "marketplace", "gemini", "commands", "nams", "workspace.toml");
const marketplaceGeminiCliPath = "$HOME/.gemini/extensions/nams-hooks/plugins/gemini-nams-hooks/bin/cli.js";
const localGeminiRootPath = path.join(repoRoot, "templates", "local", "gemini", ".gemini");
const localSettingsPath = path.join(localGeminiRootPath, "settings.json");
const localCommandPath = path.join(localGeminiRootPath, "commands", "nams", "workspace.toml");
const localExtensionPath = path.join(localGeminiRootPath, "extensions");

test("Gemini extension template exposes NAMS environment settings in order", async () => {
  const template = JSON.parse(await readFile(marketplaceExtensionPath, "utf8"));
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
  const template = JSON.parse(await readFile(marketplaceHooksPath, "utf8"));
  const groups = template.hooks.BeforeAgent;

  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, "*");
  assert.deepEqual(
    groups[0].hooks.map((hook: { name: string; command: string }) => ({ name: hook.name, command: hook.command })),
    [
      {
        name: "nams-memory-before-agent",
        command: 'node "${extensionPath}/plugins/gemini-nams-hooks/bin/cli.js" run gemini --event BeforeAgent',
      },
    ],
  );
});

test("Gemini local template is symlinkable as project .gemini config", async () => {
  await access(localSettingsPath);
  await access(localCommandPath);
  await assertFileMissing(localExtensionPath);
});

test("Gemini local settings template routes BeforeAgent through installed nams-hooks", async () => {
  const template = JSON.parse(await readFile(localSettingsPath, "utf8"));
  const groups = template.hooks.BeforeAgent;

  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, "*");
  assert.deepEqual(
    groups[0].hooks.map((hook: { name: string; command: string }) => ({ name: hook.name, command: hook.command })),
    [
      {
        name: "nams-memory-before-agent",
        command: "nams-hooks run gemini --event BeforeAgent",
      },
    ],
  );
});

test("Gemini extension template packages nams workspace custom command", async () => {
  const source = await readFile(marketplaceCommandPath, "utf8");
  const command = parseGeminiWorkspaceCommandToml(source);

  assert.equal(command.description, "Select the NAMS workspace for this Gemini session.");
  assert.match(command.prompt, /nams:workspace/);
  assert.match(command.prompt, /workspaces run gemini --event CustomCommand/);
  assert.match(command.prompt, /\{\{args\}\}/);
  assert.match(command.prompt, /echo '\{ "command_name": "nams:workspace", "command_args": "\{\{args\}\}" \}'/);
  assert.doesNotMatch(command.prompt, /<<'NAMS_WORKSPACE_ARGS'/);
  assert.doesNotMatch(command.prompt, /node -e/);
  assert.doesNotMatch(command.prompt, /process\.stdin/);
  assert.doesNotMatch(command.prompt, /process\.argv/);
  assert.match(command.prompt, /^NAMS workspace command result:/);
  assert.match(command.prompt, /Report the command output to the user/);
  assert.doesNotMatch(command.prompt, /workspaces configure/);
});

test("Gemini marketplace workspace command routes through bundled platform folder", async () => {
  const source = await readFile(marketplaceCommandPath, "utf8");

  assert.match(source, /workspaces run gemini --event CustomCommand/);
  assert.ok(source.includes(marketplaceGeminiCliPath), `Gemini marketplace command must call ${marketplaceGeminiCliPath}.`);
  assert.doesNotMatch(source, /\$\{extensionPath\}/);
  assert.doesNotMatch(source, /workspaces configure/);
});

test("Gemini local workspace command routes through installed nams-hooks", async () => {
  const source = await readFile(localCommandPath, "utf8");

  assert.match(source, /nams-hooks workspaces run gemini --event CustomCommand/);
  assert.doesNotMatch(source, /\$\{extensionPath\}|bin\/cli\.js|workspaces configure/);
});

test("Gemini workspace command TOML parser rejects invalid basic string escapes", () => {
  assert.throws(
    () => parseGeminiWorkspaceCommandToml('description = "x"\n\nprompt = """\ninvalid \\s escape\n"""\n'),
    /invalid TOML basic string escape: \\s/,
  );
});

test("Gemini marketplace workspace custom command forwards slash args with readable echo payload", async () => {
  const source = await readFile(marketplaceCommandPath, "utf8");
  const command = parseGeminiWorkspaceCommandToml(source);
  const tempDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-command-"));

  try {
    const payloadPath = path.join(tempDir, "payload.json");
    const homeDir = path.join(tempDir, "home");
    const stubCliPath = path.join(
      homeDir,
      ".gemini",
      "extensions",
      "nams-hooks",
      "plugins",
      "gemini-nams-hooks",
      "bin",
      "cli.js",
    );
    await mkdir(path.dirname(stubCliPath), { recursive: true });
    await writeFile(stubCliPath, stubCliSource(payloadPath), "utf8");

    const shellCommand = shellCommandForGeminiMarketplacePrompt(command.prompt, "use Engineering Team");
    await execFileAsync("/bin/sh", ["-c", shellCommand], {
      cwd: tempDir,
      env: { ...process.env, HOME: homeDir },
    });

    const payload = JSON.parse(await readFile(payloadPath, "utf8"));
    assert.deepEqual(payload.argv, ["workspaces", "run", "gemini", "--event", "CustomCommand"]);
    assert.equal(payload.body.command_name, "nams:workspace");
    assert.equal(payload.body.command_args, "use Engineering Team");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Gemini local workspace custom command emits model-facing result instructions", async () => {
  const source = await readFile(localCommandPath, "utf8");
  const command = parseGeminiWorkspaceCommandToml(source);
  const tempDir = await mkdtemp(path.join(tmpdir(), "nams-gemini-local-command-"));

  try {
    const payloadPath = path.join(tempDir, "payload.json");
    const binDir = path.join(tempDir, "bin");
    const stubCliPath = path.join(binDir, "nams-hooks");
    await mkdir(binDir, { recursive: true });
    await writeFile(stubCliPath, stubCliSource(payloadPath), "utf8");
    await chmod(stubCliPath, 0o755);

    const renderedPrompt = await renderGeminiPromptWithShellOutput(command.prompt, stubCliPath, "use Default", {
      cwd: tempDir,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
    });

    assert.match(renderedPrompt, /^NAMS workspace command result:/);
    assert.match(renderedPrompt, /NAMS workspace configured for gemini session session-1: workspace-1/);
    assert.match(renderedPrompt, /Report the command output to the user/);
    assert.match(renderedPrompt, /Do not run additional shell commands/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function shellCommandForGeminiMarketplacePrompt(prompt: string, args: string) {
  const shellCommand = extractShellInjection(prompt);

  return shellCommand.trim().replace("{{args}}", shellQuote(args));
}

function shellCommandForGeminiLocalPrompt(prompt: string, stubCliPath: string, args: string) {
  const shellCommand = extractShellInjection(prompt);

  return shellCommand
    .trim()
    .replaceAll("nams-hooks", stubCliPath)
    .replace("{{args}}", shellQuote(args));
}

async function renderGeminiPromptWithShellOutput(
  prompt: string,
  stubCliPath: string,
  args: string,
  options: Parameters<typeof execFileAsync>[2],
) {
  const shellInjection = extractShellInjection(prompt);
  const shellCommand = shellCommandForGeminiLocalPrompt(prompt, stubCliPath, args);
  const { stdout } = await execFileAsync("/bin/sh", ["-c", shellCommand], options);
  return prompt.replace(`!{${shellInjection}}`, String(stdout));
}

function extractShellInjection(prompt: string) {
  const startIndex = prompt.indexOf("!{");
  assert.notEqual(startIndex, -1, "Gemini prompt must include a shell injection.");
  const lineEndIndex = prompt.indexOf("\n", startIndex);
  const injectionLine = prompt.slice(startIndex, lineEndIndex === -1 ? undefined : lineEndIndex).trim();
  assert.ok(injectionLine.startsWith("!{") && injectionLine.endsWith("}"), "Gemini shell injection must fit on one line.");
  return injectionLine.slice(2, -1);
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
  process.stdout.write(JSON.stringify({
    continue: true,
    suppressOutput: false,
    exitCode: 0,
    message: "NAMS workspace configured for gemini session session-1: workspace-1",
  }) + "\\n");
});
`;
}

async function assertFileMissing(filePath: string) {
  await assert.rejects(access(filePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
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
