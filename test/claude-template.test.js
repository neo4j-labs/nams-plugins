import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

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

  assert.equal(template.name, "neo4j-nams-hooks");
  assert.equal(template.metadata.version, "__PACKAGE_VERSION__");
  assert.equal(template.plugins[0].name, "nams-hooks");
  assert.equal(template.plugins[0].source, "./plugins/nams-hooks");
  assert.equal(template.plugins[0].version, "__PACKAGE_VERSION__");
  assert.equal(template.plugins[0].license, "__PACKAGE_LICENSE__");
});

test("Claude plugin manifest template declares user config without standard hooks", async () => {
  const template = JSON.parse(await readFile("templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json", "utf8"));

  assert.equal(template.name, "nams-hooks");
  assert.equal(template.version, "__PACKAGE_VERSION__");
  assert.equal(template.license, "__PACKAGE_LICENSE__");
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
    description: "Neo4j Agent Memory Service workspace ID.",
    required: true,
  });
  assert.equal(template.userConfig.NAMS_WORKSPACE_ID.required, true);
  assert.deepEqual(template.userConfig.NAMS_BASE_URL, {
    type: "string",
    title: "NAMS base URL",
    description: "Neo4j Agent Memory Service API base URL.",
    default: "https://memory.neo4jlabs.com",
  });
});

function commandFor(template, eventName) {
  return template.hooks[eventName]?.[0]?.hooks?.[0]?.command;
}

function pluginCommandFor(template, eventName) {
  const handler = template.hooks[eventName]?.[0]?.hooks?.[0];
  return [handler?.command, ...(handler?.args ?? [])];
}
