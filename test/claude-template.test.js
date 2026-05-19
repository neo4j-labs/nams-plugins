import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Claude template maps native hooks to NAMS events", async () => {
  const template = JSON.parse(await readFile("templates/claude/settings.local.json", "utf8"));

  assert.equal(commandFor(template, "SessionStart"), "nams-hooks run claude --event SessionStart");
  assert.equal(commandFor(template, "UserPromptSubmit"), "nams-hooks run claude --event BeforeAgent");
  assert.equal(commandFor(template, "PostToolUse"), "nams-hooks run claude --event AfterTool");
  assert.equal(commandFor(template, "Stop"), "nams-hooks run claude --event AfterAgent");
});

function commandFor(template, eventName) {
  return template.hooks[eventName]?.[0]?.hooks?.[0]?.command;
}
