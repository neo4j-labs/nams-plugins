import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const marketplacePath = "templates/codex/.agents/plugins/marketplace.json";
const pluginManifestPath = "templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json";
const pluginHooksPath = "templates/codex/plugins/codex-nams-hooks/hooks/hooks.json";
const fallbackHooksPath = "templates/codex/hooks.json";
const pluginRoot = "${PLUGIN_ROOT}";

test("Codex repo marketplace template exposes nams-hooks as available", async () => {
  const template = JSON.parse(await readFile(marketplacePath, "utf8"));

  assert.equal(template.name, "neo4j-nams-hooks");
  assert.equal(template.metadata.description, "Neo4j Agent Memory Service hooks for Codex.");
  assert.equal(template.metadata.version, "__PACKAGE_VERSION__");

  assert.equal(template.plugins.length, 1);

  const plugin = template.plugins[0];
  assert.equal(plugin.name, "nams-hooks");
  assert.deepEqual(plugin.source, {
    source: "local",
    path: "./plugins/codex-nams-hooks",
  });
  assert.deepEqual(plugin.policy, {
    installation: "AVAILABLE",
    authentication: "ON_USE",
  });
  assert.equal(plugin.interface.displayName, "NAMS Hooks");
  assert.equal(plugin.description, "Persistent Neo4j Agent Memory Service hooks for Codex.");
  assert.equal(plugin.version, "__PACKAGE_VERSION__");
  assert.equal(plugin.author.name, "Neo4j Labs");
  assert.equal(plugin.repository, "https://github.com/neo4j-labs/nams-hooks");
  assert.equal(plugin.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(plugin.keywords, ["memory", "context", "persistence", "neo4j", "nams"]);
  assert.equal(plugin.category, "Productivity");
});

test("Codex plugin manifest template declares metadata without credential prompts", async () => {
  const template = JSON.parse(await readFile(pluginManifestPath, "utf8"));

  assert.equal(template.name, "nams-hooks");
  assert.equal(template.version, "__PACKAGE_VERSION__");
  assert.equal(template.description, "Persistent Neo4j Agent Memory Service hooks for Codex.");
  assert.equal(template.author.name, "Neo4j Labs");
  assert.equal(template.repository, "https://github.com/neo4j-labs/nams-hooks");
  assert.equal(template.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(template.keywords, ["memory", "context", "persistence", "neo4j", "nams"]);
  assert.equal(Object.hasOwn(template, "userConfig"), false);
  assert.equal(Object.hasOwn(template, "authentication"), false);
  assert.equal(Object.hasOwn(template, "hooks"), false);
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
