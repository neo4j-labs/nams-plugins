import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const localManifestPath = "templates/local/antigravity/.agents/plugins/nams-hooks/plugin.json";
const localHooksPath = "templates/local/antigravity/.agents/plugins/nams-hooks/hooks.json";
const marketplaceManifestPath = "templates/marketplace/antigravity/plugins/nams-hooks/plugin.json";
const marketplaceHooksPath = "templates/marketplace/antigravity/plugins/nams-hooks/hooks.json";
const localProjectionScriptPath = "scripts/build-dist-local.mjs";
const marketplaceProjectionScriptPath = "scripts/build-dist-marketplace.mjs";
const bundledCli = "$HOME/.gemini/config/plugins/nams-hooks/bin/cli.js";

test("Antigravity local plugin manifest uses project-local plugin metadata only", async () => {
  const manifest = JSON.parse(await readFile(localManifestPath, "utf8"));

  assert.equal(manifest.name, "nams-hooks");
  assert.equal(manifest.description, "Persistent Neo4j Agent Memory Service hooks for Antigravity.");
  assert.equal(Object.hasOwn(manifest, "userConfig"), false);
  assert.equal(Object.hasOwn(manifest, "authentication"), false);
  assert.equal(Object.hasOwn(manifest, "hooks"), false);
  assert.doesNotMatch(JSON.stringify(manifest), /NAMS_API_KEY|NAMS_BASE_URL|memory\.neo4jlabs\.com/);
});

test("Antigravity marketplace plugin manifest renders release metadata without credential prompts", async () => {
  const manifest = JSON.parse(await readFile(marketplaceManifestPath, "utf8"));

  assert.equal(manifest.name, "nams-hooks");
  assert.equal(manifest.version, "__PACKAGE_VERSION__");
  assert.equal(manifest.description, "Persistent Neo4j Agent Memory Service hooks for Antigravity.");
  assert.equal(manifest.author.name, "Neo4j Labs");
  assert.equal(manifest.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(manifest.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(manifest.keywords, ["memory", "context", "persistence", "neo4j", "nams"]);
  assert.equal(Object.hasOwn(manifest, "userConfig"), false);
  assert.equal(Object.hasOwn(manifest, "authentication"), false);
  assert.equal(Object.hasOwn(manifest, "hooks"), false);
  assert.doesNotMatch(JSON.stringify(manifest), /NAMS_API_KEY|NAMS_BASE_URL|memory\.neo4jlabs\.com/);
});

test("Antigravity local hook template maps native events to installed nams-hooks commands", async () => {
  const template = JSON.parse(await readFile(localHooksPath, "utf8"));

  assert.deepEqual(antigravityHookFor(template, "PreInvocation"), {
    type: "command",
    command: "nams-hooks run antigravity --event BeforeAgent",
    timeout: 30,
  });
  assert.deepEqual(antigravityHookFor(template, "PostInvocation"), {
    type: "command",
    command: "nams-hooks run antigravity --event AfterAgent",
    timeout: 30,
  });
  assert.deepEqual(antigravityHookFor(template, "PostToolUse"), {
    matcher: "*",
    type: "command",
    command: "nams-hooks run antigravity --event AfterTool",
    timeout: 30,
  });

  const serialized = JSON.stringify(template);
  assert.doesNotMatch(serialized, /SessionStart|Stop/);
  assert.doesNotMatch(serialized, /bin\/cli\.js|\$HOME/);
  assert.doesNotMatch(serialized, /NAMS_API_KEY|NAMS_BASE_URL|memory\.neo4jlabs\.com/);
});

test("Antigravity marketplace hook template maps native events to bundled runtime commands", async () => {
  const template = JSON.parse(await readFile(marketplaceHooksPath, "utf8"));

  assert.deepEqual(antigravityHookFor(template, "PreInvocation"), {
    type: "command",
    command: `node "${bundledCli}" run antigravity --event BeforeAgent`,
    timeout: 30,
  });
  assert.deepEqual(antigravityHookFor(template, "PostInvocation"), {
    type: "command",
    command: `node "${bundledCli}" run antigravity --event AfterAgent`,
    timeout: 30,
  });
  assert.deepEqual(antigravityHookFor(template, "PostToolUse"), {
    matcher: "*",
    type: "command",
    command: `node "${bundledCli}" run antigravity --event AfterTool`,
    timeout: 30,
  });

  const serialized = JSON.stringify(template);
  assert.doesNotMatch(serialized, /SessionStart|Stop/);
  assert.doesNotMatch(serialized, /(^|[^/])nams-hooks run antigravity --event/);
  assert.doesNotMatch(serialized, /NAMS_API_KEY|NAMS_BASE_URL|memory\.neo4jlabs\.com/);
});

test("Antigravity distribution scripts project local config and marketplace runtime separately", async () => {
  const localScript = await readFile(localProjectionScriptPath, "utf8");
  const marketplaceScript = await readFile(marketplaceProjectionScriptPath, "utf8");

  assert.match(localScript, /platform:\s*"antigravity"/);
  assert.match(localScript, /from:\s*"templates\/local\/antigravity"/);
  assert.match(localScript, /to:\s*"antigravity"/);
  assert.doesNotMatch(localScript, /antigravity[\s\S]*kind:\s*"runtime"/);

  assert.match(marketplaceScript, /platform:\s*"antigravity"/);
  assert.match(marketplaceScript, /from:\s*"templates\/marketplace\/antigravity\/plugins\/nams-hooks"/);
  assert.match(marketplaceScript, /to:\s*"antigravity\/plugins\/nams-hooks"/);
  assert.match(marketplaceScript, /kind:\s*"runtime"[\s\S]*platform:\s*"antigravity"[\s\S]*to:\s*"antigravity\/plugins\/nams-hooks\/bin"/);
});

function antigravityHookFor(template: any, eventName: string): Record<string, unknown> {
  for (const nativeEvents of Object.values(template) as any[]) {
    const groups = nativeEvents?.[eventName];
    if (!Array.isArray(groups) || groups.length !== 1) {
      continue;
    }
    const group = groups[0];
    const handler = group.hooks?.[0] ?? group;
    return {
      ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
      type: handler.type,
      command: handler.command,
      timeout: handler.timeout,
    };
  }
  return {};
}
