import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const claudeSlash = "/nams-hooks:nams-hooks workspaces use <workspace-id-or-name>";
const opencodeSlash = "/nams-hooks workspaces use <workspace-id-or-name>";
const genericSessionConfigure =
  "nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>";

async function readDoc(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("README documents Tier 1 workspace selection and the portable shell command", async () => {
  const content = await readDoc("README.md");

  assert.match(content, /quickest deterministic fix is a session-scoped selection/);
  assert.match(content, /Claude Code[^.]*\/nams-hooks:nams-hooks workspaces use <workspace-id-or-name>/s);
  assert.match(content, /OpenCode[^.]*\/nams-hooks workspaces use <workspace-id-or-name>/s);
  assert.match(content, new RegExp(genericSessionConfigure.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(
    content,
    /nams-hooks workspaces configure <platform> --scope project --workspace <workspace-id-or-name>/,
  );
});

test("INSTALL workspace selection documents slash commands and shell fallback", async () => {
  const content = await readDoc("INSTALL.md");

  assert.match(content, /multi-workspace inactive memory notices/i);
  assert.match(content, /Claude Code[^.]*\/nams-hooks:nams-hooks workspaces use <workspace-id-or-name>/s);
  assert.match(content, /OpenCode[^.]*\/nams-hooks workspaces use <workspace-id-or-name>/s);
  assert.match(content, /slash commands wrap the explicit shell command/i);
  assert.match(content, new RegExp(genericSessionConfigure.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(
    content,
    /nams-hooks workspaces configure opencode --scope session --session-id session-1 --workspace Engineering/,
  );
  assert.match(content, /Gemini, Codex, scripts, and troubleshooting/i);
});

test("INSTALL platform notes keep platform-specific workspace command guidance", async () => {
  const content = await readDoc("INSTALL.md");

  assert.match(content, /## Claude Code[\s\S]*\/nams-hooks:nams-hooks workspaces use <workspace-id-or-name>/);
  assert.match(
    content,
    /## Claude Code[\s\S]*nams-hooks workspaces configure claude --scope session --session-id <session-id> --workspace <workspace-id-or-name>/,
  );

  assert.match(
    content,
    /## Codex[\s\S]*does not currently expose deterministic `\/nams-hooks workspaces use`/,
  );
  assert.match(
    content,
    /## Codex[\s\S]*nams-hooks workspaces configure codex --scope session --session-id <session-id> --workspace <workspace-id-or-name>/,
  );

  assert.match(content, /## Gemini CLI[\s\S]*slash-command support is designed but deferred/);
  assert.match(
    content,
    /## Gemini CLI[\s\S]*nams-hooks workspaces configure gemini --scope session --session-id <session-id> --workspace <workspace-id-or-name>/,
  );

  assert.match(content, /## OpenCode[\s\S]*\/nams-hooks workspaces use <workspace-id-or-name>/);
  assert.match(
    content,
    /## OpenCode[\s\S]*nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>/,
  );
});

test("session workspace research note reflects Tier 1 support and safe Claude handling", async () => {
  const content = await readDoc("docs/session-workspace-command-support.md");
  const remainingUxWork = content.slice(content.indexOf("## Remaining UX Work"));

  assert.match(remainingUxWork, new RegExp(claudeSlash.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(remainingUxWork, new RegExp(opencodeSlash.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(remainingUxWork, new RegExp(genericSessionConfigure.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(remainingUxWork, /Add Claude Code UX first/);
  assert.doesNotMatch(content, /current shim does not yet intercept a user command/);
  assert.match(content, /UserPromptExpansion/);
  assert.match(content, /\$ARGUMENTS[^.]*must not be interpolated into a shell command/s);
});
