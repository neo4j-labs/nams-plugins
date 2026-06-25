import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const marketplacePath = "templates/marketplace/codex/.agents/plugins/marketplace.json";
const pluginManifestPath = "templates/marketplace/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json";
const mcpPluginManifestPath = "templates/marketplace/codex/plugins/codex-nams-mcp/.codex-plugin/plugin.json";
const localMcpPluginManifestPath = "templates/local/codex-mcp/.codex-plugin/plugin.json";
const pluginHooksPath = "templates/marketplace/codex/plugins/codex-nams-hooks/hooks/hooks.json";
const pluginSkillPath = "templates/marketplace/codex/plugins/codex-nams-hooks/skills/workspace/SKILL.md";
const pluginSkillPolicyPath = "templates/marketplace/codex/plugins/codex-nams-hooks/skills/workspace/agents/openai.yaml";
const fallbackHooksPath = "templates/local/codex/.codex/hooks.json";
const localSkillPath = "templates/local/codex/.codex/skills/workspace/SKILL.md";
const localSkillPolicyPath = "templates/local/codex/.codex/skills/workspace/agents/openai.yaml";
const pluginRoot = "${PLUGIN_ROOT}";

test("Codex repo marketplace template exposes hooks and MCP plugins separately", async () => {
  const template = JSON.parse(await readFile(marketplacePath, "utf8"));

  assert.equal(template.name, "nams-plugins");
  assert.equal(template.metadata.description, "Neo4j Agent Memory Service hooks for Codex.");
  assert.equal(template.metadata.version, "__PACKAGE_VERSION__");
  assert.equal(template.plugins.length, 2);

  const hooksPlugin = template.plugins.find((plugin: { name?: string }) => plugin.name === "nams-hooks");
  assert.ok(hooksPlugin);
  assert.deepEqual(hooksPlugin.source, {
    source: "local",
    path: "./plugins/codex-nams-hooks",
  });
  assert.deepEqual(hooksPlugin.policy, {
    installation: "AVAILABLE",
    authentication: "ON_USE",
  });
  assert.equal(hooksPlugin.interface.displayName, "NAMS Hooks");
  assert.equal(hooksPlugin.description, "Persistent Neo4j Agent Memory Service hooks for Codex.");
  assert.equal(hooksPlugin.version, "__PACKAGE_VERSION__");
  assert.equal(hooksPlugin.author.name, "Neo4j Labs");
  assert.equal(hooksPlugin.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(hooksPlugin.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(hooksPlugin.keywords, ["memory", "context", "persistence", "neo4j", "nams"]);
  assert.equal(hooksPlugin.category, "Productivity");

  const mcpPlugin = template.plugins.find((plugin: { name?: string }) => plugin.name === "mcp");
  assert.ok(mcpPlugin);
  assert.deepEqual(mcpPlugin.source, {
    source: "local",
    path: "./plugins/codex-nams-mcp",
  });
  assert.deepEqual(mcpPlugin.policy, {
    installation: "AVAILABLE",
    authentication: "ON_USE",
  });
  assert.equal(mcpPlugin.interface.displayName, "NAMS MCP");
  assert.equal(mcpPlugin.description, "OAuth-first Neo4j Agent Memory Service MCP tools for Codex.");
  assert.equal(mcpPlugin.version, "__PACKAGE_VERSION__");
  assert.equal(mcpPlugin.author.name, "Neo4j Labs");
  assert.equal(mcpPlugin.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(mcpPlugin.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(mcpPlugin.keywords, ["memory", "mcp", "neo4j", "nams"]);
  assert.equal(mcpPlugin.category, "Productivity");
});

test("Codex plugin manifest template declares metadata without credential prompts", async () => {
  const template = JSON.parse(await readFile(pluginManifestPath, "utf8"));

  assert.equal(template.name, "nams-hooks");
  assert.equal(template.version, "__PACKAGE_VERSION__");
  assert.equal(template.description, "Persistent Neo4j Agent Memory Service hooks for Codex.");
  assert.equal(template.skills, "./skills/");
  assert.equal(template.author.name, "Neo4j Labs");
  assert.equal(template.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(template.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(template.keywords, ["memory", "context", "persistence", "neo4j", "nams"]);
  assert.equal(Object.hasOwn(template, "userConfig"), false);
  assert.equal(Object.hasOwn(template, "authentication"), false);
  assert.equal(Object.hasOwn(template, "hooks"), false);
});

test("Codex MCP plugin manifest template declares OAuth-first remote MCP only", async () => {
  const template = JSON.parse(await readFile(mcpPluginManifestPath, "utf8"));

  assertCodexMcpManifest(template);
});

test("Codex MCP local template declares OAuth-first remote MCP only", async () => {
  const template = JSON.parse(await readFile(localMcpPluginManifestPath, "utf8"));

  assertCodexMcpManifest(template);
});

function assertCodexMcpManifest(template: any): void {
  assert.equal(template.name, "mcp");
  assert.equal(template.version, "__PACKAGE_VERSION__");
  assert.equal(template.description, "OAuth-first Neo4j Agent Memory Service MCP tools for Codex.");
  assert.equal(template.author.name, "Neo4j Labs");
  assert.equal(template.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(template.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(template.keywords, ["memory", "mcp", "neo4j", "nams"]);
  assert.deepEqual(template.mcpServers, {
    nams: {
      url: "https://memory.neo4jlabs.com/mcp",
    },
  });
  assert.equal(Object.hasOwn(template, "hooks"), false);
  assert.equal(Object.hasOwn(template, "skills"), false);
  assert.equal(Object.hasOwn(template, "userConfig"), false);
  assert.equal(Object.hasOwn(template, "authentication"), false);
  assert.doesNotMatch(JSON.stringify(template), /NAMS_API_KEY|Authorization|Bearer/);
}

test("Codex plugin template packages explicit nams workspace skill", async () => {
  const skill = await readFile(pluginSkillPath, "utf8");
  const policy = await readFile(pluginSkillPolicyPath, "utf8");

  assert.match(skill, /name: nams:workspace/);
  assert.match(skill, /description: Explicitly use \$nams:workspace use/);
  assert.match(skill, /workspaces run codex --event CustomCommand/);
  assert.match(skill, /command_name/);
  assert.match(skill, /command_args/);
  assert.match(skill, /node bin\/cli\.js workspaces run codex --event CustomCommand/);
  assert.match(skill, /nams-hooks workspaces run codex --event CustomCommand/);
  assert.match(skill, /installed executable fallback/);
  assert.doesNotMatch(skill, /workspaces configure/);
  assert.match(policy, /allow_implicit_invocation: false/);
});

test("Codex plugin hook template invokes the bundled CLI through plugin root", async () => {
  const template = JSON.parse(await readFile(pluginHooksPath, "utf8"));

  assert.deepEqual(codexHookFor(template, "SessionStart"), {
    matcher: "startup|resume",
    type: "command",
    command: `node ${pluginRoot}/bin/cli.js run codex --event SessionStart`,
    statusMessage: "Loading session notes",
  });
  assert.deepEqual(codexHookFor(template, "UserPromptSubmit"), {
    type: "command",
    command: `node ${pluginRoot}/bin/cli.js run codex --event BeforeAgent`,
    statusMessage: "NAMS memory recall",
  });
  assert.deepEqual(codexHookFor(template, "Stop"), {
    type: "command",
    command: `node ${pluginRoot}/bin/cli.js run codex --event AfterAgent`,
    statusMessage: "NAMS assistant persistence",
  });
  assert.deepEqual(codexHookFor(template, "PostToolUse"), {
    type: "command",
    command: `node ${pluginRoot}/bin/cli.js run codex --event AfterTool`,
    statusMessage: "NAMS tool metadata",
  });
  assert.doesNotMatch(JSON.stringify(template.hooks.UserPromptSubmit), /workspaces|InstallConfigure/);
});

test("Codex fallback hook template keeps first prompt memory-only", async () => {
  const template = JSON.parse(await readFile(fallbackHooksPath, "utf8"));

  assert.deepEqual(codexHookFor(template, "UserPromptSubmit"), {
    type: "command",
    command: "nams-hooks run codex --event BeforeAgent",
    statusMessage: "NAMS memory recall",
  });
  assert.doesNotMatch(JSON.stringify(template.hooks.UserPromptSubmit), /workspaces|InstallConfigure/);
});

test("Codex local template packages explicit nams workspace skill for installed runtime", async () => {
  const skill = await readFile(localSkillPath, "utf8");
  const policy = await readFile(localSkillPolicyPath, "utf8");

  assert.match(skill, /name: nams:workspace/);
  assert.match(skill, /description: Explicitly use \$nams:workspace use/);
  assert.match(skill, /nams-hooks workspaces run codex --event CustomCommand/);
  assert.match(skill, /command_name/);
  assert.match(skill, /command_args/);
  assert.doesNotMatch(skill, /node bin\/cli\.js|\$\{PLUGIN_ROOT\}|plugin root/i);
  assert.doesNotMatch(skill, /workspaces configure/);
  assert.match(policy, /allow_implicit_invocation: false/);
});

function codexHookFor(template: any, eventName: string): Record<string, string> {
  const group = template.hooks[eventName]?.[0];
  const handler = group?.hooks?.[0] ?? {};
  return {
    ...(group?.matcher !== undefined ? { matcher: group.matcher } : {}),
    type: handler.type,
    command: handler.command,
    statusMessage: handler.statusMessage,
  };
}
