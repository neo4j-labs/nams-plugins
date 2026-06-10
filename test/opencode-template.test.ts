import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("opencode plugin template routes session-created events through the typed hook gateway", async () => {
  const source = await readFile(path.join(repoRoot, "templates", "opencode", "plugins", "nams-hooks.js"), "utf8");

  assert.match(source, /session\.created/);
  assert.match(source, /nams-hooks/);
  assert.match(source, /run\("SessionStart", \{ hook: "event", event \}\)/);
  assert.match(source, /run\("BeforeAgent", \{ hook: "chat\.message", input, output \}\)/);
  assert.doesNotMatch(source, /runWorkspace/);
  assert.match(source, /memoryResult\?\.namsWorkspaceSelectionRequired === true/);
  assert.match(source, /showToast/);
  assert.match(source, /invokeNams\(event,/);
  assert.match(source, /\["run", "opencode", "--event", event\]/);
});
