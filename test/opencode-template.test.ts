import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("opencode plugin template routes session-created events through the typed hook gateway", async () => {
  const source = await readFile(path.join(repoRoot, "templates", "opencode", ".opencode", "plugins", "nams-hooks.js"), "utf8");

  assert.match(source, /session\.created/);
  assert.match(source, /nams-hooks/);
  assert.match(source, /run\("SessionStart", \{ hook: "event", event \}\)/);
  assert.match(source, /run\("BeforeAgent", \{ hook: "chat\.message", input, output \}\)/);
  assert.doesNotMatch(source, /runWorkspace/);
  assert.match(source, /memoryResult\?\.namsWorkspaceSelectionRequired === true/);
  assert.match(source, /showToast/);
  assert.match(source, /invokeNams\(command, event,/);
  assert.match(source, /\["run", "opencode", "--event", event\]/);
});

test("opencode command markdown is packaged with the local template", async () => {
  const source = await readFile(
    path.join(repoRoot, "templates", "opencode", ".opencode", "commands", "nams:workspace.md"),
    "utf8",
  );

  assert.match(source, /description: Select the NAMS workspace for this OpenCode session\./);
  assert.match(source, /\/nams:workspace use <workspace-id-or-name>/);
  assert.match(source, /OpenCode plugin/);
  assert.doesNotMatch(source, /!\s*`/);
});
