import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const claudeSkillPath = "templates/claude/plugins/nams-hooks/skills/nams-hooks/SKILL.md";
const claudeSkillScriptPath = "templates/claude/plugins/nams-hooks/skills/nams-hooks/scripts/workspace-use.mjs";

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

test("Claude plugin template packages slash workspace skill", async () => {
  const skill = await readFile(claudeSkillPath, "utf8");
  const script = await readFile(claudeSkillScriptPath, "utf8");

  assert.match(skill, /name: nams-hooks/);
  assert.match(skill, /argument-hint: workspaces use <workspace-id-or-name>/);
  assert.match(skill, /disable-model-invocation: true/);
  assert.match(skill, /workspace-use\.mjs/);
  assert.match(skill, /\$ARGUMENTS/);

  assert.match(script, /CLAUDE_SESSION_ID/);
  assert.match(script, /CLAUDE_SKILL_DIR/);
  assert.match(script, /workspaces/);
  assert.match(script, /configure/);
  assert.match(script, /claude/);
});

test("Claude slash workspace helper delegates to bundled cli", async () => {
  const fixture = await createClaudeSkillFixture();
  try {
    const helperSource = await readFile(claudeSkillScriptPath, "utf8");
    await writeFile(fixture.scriptPath, helperSource, "utf8");
    await chmod(fixture.scriptPath, 0o755);

    const result = spawnSync(process.execPath, [fixture.scriptPath, "workspaces use Engineering Team"], {
      cwd: fixture.pluginDir,
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: "claude-session-1",
        CLAUDE_SKILL_DIR: fixture.skillDir,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "configured\n");
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
      "Engineering Team",
    ]]);
  } finally {
    await fixture.cleanup();
  }
});

test("Claude slash workspace helper rejects missing selector and session id", async () => {
  const fixture = await createClaudeSkillFixture();
  try {
    const helperSource = await readFile(claudeSkillScriptPath, "utf8");
    await writeFile(fixture.scriptPath, helperSource, "utf8");
    await chmod(fixture.scriptPath, 0o755);

    const missingSelector = spawnSync(process.execPath, [fixture.scriptPath, "workspaces use"], {
      cwd: fixture.pluginDir,
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: "claude-session-1",
        CLAUDE_SKILL_DIR: fixture.skillDir,
      },
      encoding: "utf8",
    });
    assert.equal(missingSelector.status, 1);
    assert.match(missingSelector.stderr, /Usage: \/nams-hooks workspaces use <workspace-id-or-name>/);

    const missingSession = spawnSync(process.execPath, [fixture.scriptPath, "workspaces use Engineering"], {
      cwd: fixture.pluginDir,
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: "",
        CLAUDE_SKILL_DIR: fixture.skillDir,
      },
      encoding: "utf8",
    });
    assert.equal(missingSession.status, 1);
    assert.match(missingSession.stderr, /Claude session id is unavailable/);
    assert.match(missingSession.stderr, /--session-id <session-id> --workspace Engineering/);
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

async function createClaudeSkillFixture(): Promise<{
  pluginDir: string;
  skillDir: string;
  scriptPath: string;
  callsPath: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nams-claude-skill-"));
  const pluginDir = path.join(root, "plugin");
  const binDir = path.join(pluginDir, "bin");
  const skillDir = path.join(pluginDir, "skills", "nams-hooks");
  const scriptDir = path.join(skillDir, "scripts");
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
    skillDir,
    scriptPath,
    callsPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
