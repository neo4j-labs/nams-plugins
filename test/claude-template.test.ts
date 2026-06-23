import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const localSettingsPath = "templates/local/claude/.claude/settings.local.json";
const claudeCommandPath = "templates/marketplace/claude/plugins/claude-nams-hooks/commands/nams/workspace.md";
const claudeBaselineCommandPath = "templates/local/claude/.claude/commands/nams/workspace.md";
const marketplacePath = "templates/marketplace/claude/.claude-plugin/marketplace.json";
const pluginManifestPath = "templates/marketplace/claude/plugins/claude-nams-hooks/.claude-plugin/plugin.json";
const claudeMcpManifestPath = "templates/marketplace/claude/plugins/claude-nams-mcp/.claude-plugin/plugin.json";
const pluginHooksPath = "templates/marketplace/claude/plugins/claude-nams-hooks/hooks/hooks.json";

test("Claude template maps native hooks to NAMS events", async () => {
  const template = JSON.parse(await readFile(localSettingsPath, "utf8"));

  assert.equal(commandFor(template, "SessionStart"), "nams-hooks run claude --event SessionStart");
  assert.equal(commandFor(template, "UserPromptSubmit"), "nams-hooks run claude --event BeforeAgent");
  assert.equal(commandFor(template, "PostToolUse"), "nams-hooks run claude --event AfterTool");
  assert.equal(commandFor(template, "Stop"), "nams-hooks run claude --event AfterAgent");
  assert.doesNotMatch(JSON.stringify(template.hooks.UserPromptSubmit), /workspaces|InstallConfigure/);
});

test("Claude plugin template invokes the bundled CLI through plugin root", async () => {
  const template = JSON.parse(await readFile(pluginHooksPath, "utf8"));

  assert.deepEqual(pluginCommandFor(template, "SessionStart"), ["node", "${CLAUDE_PLUGIN_ROOT}/bin/cli.js", "run", "claude", "--event", "SessionStart"]);
  assert.deepEqual(pluginCommandFor(template, "UserPromptSubmit"), ["node", "${CLAUDE_PLUGIN_ROOT}/bin/cli.js", "run", "claude", "--event", "BeforeAgent"]);
  assert.deepEqual(pluginCommandFor(template, "PostToolUse"), ["node", "${CLAUDE_PLUGIN_ROOT}/bin/cli.js", "run", "claude", "--event", "AfterTool"]);
  assert.deepEqual(pluginCommandFor(template, "Stop"), ["node", "${CLAUDE_PLUGIN_ROOT}/bin/cli.js", "run", "claude", "--event", "AfterAgent"]);
  assert.doesNotMatch(JSON.stringify(template.hooks.UserPromptSubmit), /workspaces|InstallConfigure/);
});

test("Claude marketplace template exposes hooks and MCP plugins separately", async () => {
  const template = JSON.parse(await readFile(marketplacePath, "utf8"));

  assert.equal(template.name, "nams-plugins");
  assert.equal(template.metadata.version, "__PACKAGE_VERSION__");
  assert.equal(template.plugins.length, 2);

  const hooksPlugin = template.plugins.find((plugin: { name?: string }) => plugin.name === "nams-hooks");
  assert.ok(hooksPlugin, "Expected Claude marketplace template to include the nams-hooks plugin.");
  assert.equal(hooksPlugin.source, "./plugins/claude-nams-hooks");
  assert.equal(hooksPlugin.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(hooksPlugin.version, "__PACKAGE_VERSION__");
  assert.equal(hooksPlugin.license, "__PACKAGE_LICENSE__");

  const mcpPlugin = template.plugins.find((plugin: { name?: string }) => plugin.name === "mcp");
  assert.ok(mcpPlugin, "Expected Claude marketplace template to include the mcp plugin.");
  assert.equal(mcpPlugin.source, "./plugins/claude-nams-mcp");
  assert.equal(mcpPlugin.description, "OAuth-first Neo4j Agent Memory Service MCP tools for Claude Code.");
  assert.equal(mcpPlugin.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(mcpPlugin.version, "__PACKAGE_VERSION__");
  assert.equal(mcpPlugin.license, "__PACKAGE_LICENSE__");
  assert.equal(mcpPlugin.category, "memory");
});

test("Claude plugin manifest template declares user config without standard hooks", async () => {
  const template = JSON.parse(await readFile(pluginManifestPath, "utf8"));

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

test("Claude MCP plugin manifest template declares OAuth-first remote MCP only", async () => {
  const template = JSON.parse(await readFile(claudeMcpManifestPath, "utf8"));

  assert.equal(template.name, "mcp");
  assert.equal(template.version, "__PACKAGE_VERSION__");
  assert.equal(template.description, "OAuth-first Neo4j Agent Memory Service MCP tools for Claude Code.");
  assert.equal(template.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(template.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(template.mcpServers, {
    nams: {
      type: "http",
      url: "https://memory.neo4jlabs.com/mcp",
    },
  });
  assert.equal(Object.hasOwn(template, "hooks"), false);
  assert.equal(Object.hasOwn(template, "userConfig"), false);
  assert.doesNotMatch(JSON.stringify(template), /NAMS_API_KEY|Authorization|Bearer/);
});

test("Claude plugin template packages slash workspace command hook", async () => {
  const command = await readFile(claudeCommandPath, "utf8");
  const template = JSON.parse(await readFile(pluginHooksPath, "utf8"));

  assert.match(command, /argument-hint: use <workspace-id-or-name>/);
  assert.match(command, /disable-model-invocation: true/);
  assert.match(command, /\/nams-hooks:nams:workspace use <workspace-id-or-name>/);
  assert.match(command, /\/nams:workspace use <workspace-id-or-name>/);
  assert.doesNotMatch(command, /nams-hooks:nams-hooks/);
  assert.doesNotMatch(command, /\/nams-hooks workspaces use/);
  assert.doesNotMatch(command, /!\s*`/);
  assert.doesNotMatch(command, /\$ARGUMENTS/);

  assert.deepEqual(pluginCommandFor(template, "UserPromptExpansion"), [
    "node",
    "${CLAUDE_PLUGIN_ROOT}/bin/cli.js",
    "workspaces",
    "run",
    "claude",
    "--event",
    "UserPromptExpansion",
  ]);
  assert.equal(pluginMatcherFor(template, "UserPromptExpansion"), "^(?:nams-hooks:)?nams:workspace$");
  assert.doesNotMatch(JSON.stringify(template), /workspace-use\.mjs/);
});

test("Claude baseline template packages slash workspace command hook", async () => {
  const command = await readFile(claudeBaselineCommandPath, "utf8");
  const template = JSON.parse(await readFile(localSettingsPath, "utf8"));

  assert.match(command, /argument-hint: use <workspace-id-or-name>/);
  assert.match(command, /disable-model-invocation: true/);
  assert.match(command, /\/nams:workspace use <workspace-id-or-name>/);
  assert.doesNotMatch(command, /\/nams-hooks workspaces use/);
  assert.doesNotMatch(command, /!\s*`/);
  assert.doesNotMatch(command, /\$ARGUMENTS/);

  assert.equal(commandFor(template, "UserPromptExpansion"), "nams-hooks workspaces run claude --event UserPromptExpansion");
  assert.equal(pluginMatcherFor(template, "UserPromptExpansion"), "^nams:workspace$");
  assert.doesNotMatch(JSON.stringify(template), /workspace-use\.mjs/);
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
