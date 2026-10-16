import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceMcpConfigPath = path.join(repoRoot, "templates", "marketplace", "opencode-mcp", "opencode.json");
const localMcpConfigPath = path.join(repoRoot, "templates", "local", "opencode-mcp", "opencode.json");

test("opencode plugin template routes session-created events through the typed hook gateway", async () => {
  const source = await readFile(path.join(repoRoot, "templates", "opencode", ".opencode", "plugins", "nams-hooks.js"), "utf8");

  assert.match(source, /session\.created/);
  assert.match(source, /process\.env\.NAMS_HOOKS_COMMAND/);
  assert.match(source, /__NAMS_HOOKS_COMMAND__/);
  assert.match(source, /run\("SessionStart", \{ hook: "event", event \}\)/);
  assert.match(source, /run\("BeforeAgent", \{ hook: "chat\.message", input, output \}\)/);
  assert.doesNotMatch(source, /runWorkspace/);
  assert.match(source, /memoryResult\?\.namsWorkspaceSelectionRequired === true/);
  assert.match(source, /showToast/);
  assert.match(source, /invokeNams\(command, event,/);
  assert.match(source, /\["run", "opencode", "--event", event\]/);
});

test("opencode template does not package workspace command markdown prompt", async () => {
  await assert.rejects(
    readFile(
      path.join(repoRoot, "templates", "opencode", ".opencode", "commands", "nams:workspace.md"),
      "utf8",
    ),
    /ENOENT/,
  );
});

test("opencode MCP marketplace template is a remote OAuth config fragment", async () => {
  const config = JSON.parse(await readFile(marketplaceMcpConfigPath, "utf8"));

  assert.deepEqual(config, {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      nams: {
        type: "remote",
        url: "https://memory.neo4jlabs.com/mcp",
        enabled: true,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(config), /NAMS_API_KEY|Authorization|Bearer|nams-hooks|nams-hooks\.js/);
});

test("opencode MCP local template is a remote OAuth config fragment", async () => {
  const config = JSON.parse(await readFile(localMcpConfigPath, "utf8"));

  assert.deepEqual(config, {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      nams: {
        type: "remote",
        url: "https://memory.neo4jlabs.com/mcp",
        enabled: true,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(config), /NAMS_API_KEY|Authorization|Bearer|nams-hooks|nams-hooks\.js/);
});
