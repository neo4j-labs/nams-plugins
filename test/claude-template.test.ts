import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const claudeCommandPath = "templates/claude/plugins/nams-hooks/commands/nams-hooks.md";
const claudeWorkspaceScriptPath = "templates/claude/plugins/nams-hooks/scripts/workspace-use.mjs";
const claudeWorkspaceCommandName = "nams-hooks:nams-hooks";

test("Claude template maps native hooks to NAMS events", async () => {
  const template = JSON.parse(await readFile("templates/claude/.claude/settings.local.json", "utf8"));

  assert.equal(commandFor(template, "SessionStart"), "nams-hooks run claude --event SessionStart");
  assert.equal(commandFor(template, "UserPromptSubmit"), "nams-hooks run claude --event BeforeAgent");
  assert.equal(commandFor(template, "PostToolUse"), "nams-hooks run claude --event AfterTool");
  assert.equal(commandFor(template, "Stop"), "nams-hooks run claude --event AfterAgent");
  assert.doesNotMatch(JSON.stringify(template.hooks.UserPromptSubmit), /workspaces|InstallConfigure/);
});

test("Claude plugin template invokes the bundled CLI through plugin root", async () => {
  const template = JSON.parse(await readFile("templates/claude/plugins/nams-hooks/hooks/hooks.json", "utf8"));

  assert.deepEqual(pluginCommandFor(template, "SessionStart"), ["node", "${CLAUDE_PLUGIN_ROOT}/bin/cli.js", "run", "claude", "--event", "SessionStart"]);
  assert.deepEqual(pluginCommandFor(template, "UserPromptSubmit"), ["node", "${CLAUDE_PLUGIN_ROOT}/bin/cli.js", "run", "claude", "--event", "BeforeAgent"]);
  assert.deepEqual(pluginCommandFor(template, "PostToolUse"), ["node", "${CLAUDE_PLUGIN_ROOT}/bin/cli.js", "run", "claude", "--event", "AfterTool"]);
  assert.deepEqual(pluginCommandFor(template, "Stop"), ["node", "${CLAUDE_PLUGIN_ROOT}/bin/cli.js", "run", "claude", "--event", "AfterAgent"]);
  assert.doesNotMatch(JSON.stringify(template.hooks.UserPromptSubmit), /workspaces|InstallConfigure/);
});

test("Claude marketplace template exposes the nams-hooks plugin source", async () => {
  const template = JSON.parse(await readFile("templates/claude/.claude-plugin/marketplace.json", "utf8"));

  assert.equal(template.name, "nams-plugins");
  assert.equal(template.metadata.version, "__PACKAGE_VERSION__");
  assert.equal(template.plugins[0].name, "nams-hooks");
  assert.equal(template.plugins[0].source, "./plugins/nams-hooks");
  assert.equal(template.plugins[0].repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(template.plugins[0].version, "__PACKAGE_VERSION__");
  assert.equal(template.plugins[0].license, "__PACKAGE_LICENSE__");
});

test("Claude plugin manifest template declares user config without standard hooks", async () => {
  const template = JSON.parse(await readFile("templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json", "utf8"));

  assert.equal(template.name, "nams-hooks");
  assert.equal(template.version, "__PACKAGE_VERSION__");
  assert.equal(template.license, "__PACKAGE_LICENSE__");
  assert.equal(template.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(Object.hasOwn(template, "hooks"), false);
  assert.deepEqual(template.userConfig.NAMS_API_KEY, {
    type: "string",
    title: "NAMS API key",
    description: "Neo4j Agent Memory Service API key.",
    sensitive: true,
    required: true,
  });
  assert.deepEqual(template.userConfig.NAMS_WORKSPACE_ID, {
    type: "string",
    title: "NAMS workspace ID",
    description: "Optional workspace ID for Neo4j Agent Memory Service. If omitted, nams-hooks auto-selects a single available workspace before memory starts.",
  });
  assert.equal(Object.hasOwn(template.userConfig.NAMS_WORKSPACE_ID, "required"), false);
  assert.deepEqual(template.userConfig.NAMS_BASE_URL, {
    type: "string",
    title: "NAMS base URL",
    description: "Neo4j Agent Memory Service API base URL.",
    default: "https://memory.neo4jlabs.com",
  });
});

test("Claude plugin template packages slash workspace command hook", async () => {
  const command = await readFile(claudeCommandPath, "utf8");
  const script = await readFile(claudeWorkspaceScriptPath, "utf8");
  const template = JSON.parse(await readFile("templates/claude/plugins/nams-hooks/hooks/hooks.json", "utf8"));

  assert.match(command, /argument-hint: workspaces use <workspace-id-or-name>/);
  assert.match(command, /disable-model-invocation: true/);
  assert.match(command, /\/nams-hooks:nams-hooks workspaces use <workspace-id-or-name>/);
  assert.doesNotMatch(command, /!\s*`/);
  assert.doesNotMatch(command, /\$ARGUMENTS/);

  assert.deepEqual(pluginCommandFor(template, "UserPromptExpansion"), ["node", "${CLAUDE_PLUGIN_ROOT}/scripts/workspace-use.mjs"]);
  assert.equal(pluginMatcherFor(template, "UserPromptExpansion"), "^nams-hooks:nams-hooks$");
  assert.match(script, /UserPromptExpansion/);
  assert.match(script, /command_args/);
  assert.match(script, /session_id/);
  assert.match(script, /CLAUDE_SESSION_ID/);
  assert.match(script, /workspaces/);
  assert.match(script, /configure/);
  assert.match(script, /claude/);
});

test("Claude slash workspace helper delegates to bundled cli without shell expansion", async () => {
  const fixture = await createClaudeSkillFixture();
  try {
    const helperSource = await readFile(claudeWorkspaceScriptPath, "utf8");
    await writeFile(fixture.scriptPath, helperSource, "utf8");
    await chmod(fixture.scriptPath, 0o755);

    const selector = "Engineering Team; $(echo unsafe) \"quoted\" `ticks`";
    const result = spawnSync(process.execPath, [fixture.scriptPath], {
      cwd: fixture.pluginDir,
      input: JSON.stringify(userPromptExpansionInput({
        session_id: "claude-session-1",
        command_args: `workspaces   use ${selector}`,
      })),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).decision, "block");
    assert.match(JSON.parse(result.stdout).reason, /configured/i);
    const calls = JSON.parse(await readFile(fixture.callsPath, "utf8"));
    assert.deepEqual(calls, [[
      "workspaces",
      "configure",
      "claude",
      "--scope",
      "session",
      "--session-id",
      "claude-session-1",
      "--workspace",
      selector,
    ]]);
  } finally {
    await fixture.cleanup();
  }
});

test("Claude slash workspace helper blocks missing selector and session id", async () => {
  const fixture = await createClaudeSkillFixture();
  try {
    const helperSource = await readFile(claudeWorkspaceScriptPath, "utf8");
    await writeFile(fixture.scriptPath, helperSource, "utf8");
    await chmod(fixture.scriptPath, 0o755);

    const missingSelector = spawnSync(process.execPath, [fixture.scriptPath], {
      cwd: fixture.pluginDir,
      input: JSON.stringify(userPromptExpansionInput({
        session_id: "claude-session-1",
        command_args: "workspaces   use",
      })),
      encoding: "utf8",
    });
    assert.equal(missingSelector.status, 0);
    assert.equal(JSON.parse(missingSelector.stdout).decision, "block");
    assert.match(JSON.parse(missingSelector.stdout).reason, /Usage: \/nams-hooks:nams-hooks workspaces use <workspace-id-or-name>/);

    const missingSession = spawnSync(process.execPath, [fixture.scriptPath], {
      cwd: fixture.pluginDir,
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: "",
      },
      input: JSON.stringify(userPromptExpansionInput({
        session_id: "",
        command_args: "workspaces use Engineering",
      })),
      encoding: "utf8",
    });
    assert.equal(missingSession.status, 0);
    assert.equal(JSON.parse(missingSession.stdout).decision, "block");
    assert.match(JSON.parse(missingSession.stdout).reason, /Claude session id is unavailable/);
    assert.match(JSON.parse(missingSession.stdout).reason, /--session-id <session-id> --workspace Engineering/);
  } finally {
    await fixture.cleanup();
  }
});

function commandFor(template: any, eventName: string): string | undefined {
  return template.hooks[eventName]?.[0]?.hooks?.[0]?.command;
}

function pluginCommandFor(template: any, eventName: string): Array<string | undefined> {
  const handler = template.hooks[eventName]?.[0]?.hooks?.[0];
  return [handler?.command, ...(handler?.args ?? [])];
}

function pluginMatcherFor(template: any, eventName: string): string | undefined {
  return template.hooks[eventName]?.[0]?.matcher;
}

function userPromptExpansionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "UserPromptExpansion",
    expansion_type: "slash_command",
    command_name: claudeWorkspaceCommandName,
    command_args: "",
    command_source: "plugin",
    prompt: `/${claudeWorkspaceCommandName}`,
    ...overrides,
  };
}

async function createClaudeSkillFixture(): Promise<{
  pluginDir: string;
  scriptPath: string;
  callsPath: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nams-claude-skill-"));
  const pluginDir = path.join(root, "plugin");
  const binDir = path.join(pluginDir, "bin");
  const scriptDir = path.join(pluginDir, "scripts");
  const callsPath = path.join(root, "calls.json");
  const cliPath = path.join(binDir, "cli.js");
  const scriptPath = path.join(scriptDir, "workspace-use.mjs");

  await mkdir(binDir, { recursive: true });
  await mkdir(scriptDir, { recursive: true });
  await writeFile(callsPath, "[]", "utf8");
  await writeFile(cliPath, [
    "#!/usr/bin/env node",
    "import { readFile, writeFile } from 'node:fs/promises';",
    `const callsPath = ${JSON.stringify(callsPath)};`,
    "const calls = JSON.parse(await readFile(callsPath, 'utf8'));",
    "calls.push(process.argv.slice(2));",
    "await writeFile(callsPath, JSON.stringify(calls), 'utf8');",
    "process.stdout.write('configured\\n');",
    "",
  ].join("\n"), "utf8");
  await chmod(cliPath, 0o755);

  return {
    pluginDir,
    scriptPath,
    callsPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
