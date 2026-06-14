import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Gemini extension template exposes NAMS environment settings in order", async () => {
  const template = JSON.parse(await readFile(path.join(repoRoot, "templates", "gemini", "gemini-extension.json"), "utf8"));
  const settings = template.settings;

  assert.ok(Array.isArray(settings), "Gemini extension settings must be an array.");
  assert.deepEqual(settings.map((setting) => setting.envVar), [
    "NAMS_API_KEY",
    "NAMS_WORKSPACE_ID",
    "NAMS_BASE_URL",
  ]);

  assert.equal(settings[0].sensitive, true);
  assert.equal(settings[1].sensitive, false);
  assert.equal(settings[2].sensitive, false);
  assert.match(settings[1].description, /Optional/);
});

test("Gemini hook template routes BeforeAgent through the memory hook only", async () => {
  const template = JSON.parse(await readFile(path.join(repoRoot, "templates", "gemini", "hooks", "hooks.json"), "utf8"));
  const groups = template.hooks.BeforeAgent;

  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, "*");
  assert.deepEqual(
    groups[0].hooks.map((hook: { name: string; command: string }) => ({ name: hook.name, command: hook.command })),
    [
      {
        name: "nams-memory-before-agent",
        command: 'node "${extensionPath}/bin/cli.js" run gemini --event BeforeAgent',
      },
    ],
  );
});

test("Gemini extension template packages nams workspace custom command", async () => {
  const command = await readFile(path.join(repoRoot, "templates", "gemini", "commands", "nams", "workspace.toml"), "utf8");

  assert.match(command, /description\s*=\s*"Select the NAMS workspace for this Gemini session\."/);
  assert.match(command, /prompt\s*=/);
  assert.match(command, /nams:workspace/);
  assert.match(command, /workspaces run gemini --event CustomCommand/);
  assert.match(command, /\{\{args\}\}/);
  assert.doesNotMatch(command, /workspaces configure/);
});
