import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workspaceSlash = "/nams:workspace use <workspace-id-or-name>";
const genericSessionConfigure =
  "nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>";
const durableProjectConfigure =
  "nams-hooks workspaces configure <platform> --scope project --workspace <workspace-id-or-name>";
const opencodeSessionExample =
  "nams-hooks workspaces configure opencode --scope session --session-id session-1 --workspace Engineering";

async function readDoc(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertIncludesCommand(content: string, command: string): void {
  assert.match(content, new RegExp(escapeRegExp(command)));
}

function assertMentionsPlatformCommand(content: string, platform: string, command: string): void {
  const platformPattern = escapeRegExp(platform);
  const commandPattern = escapeRegExp(command);
  const nearbyPattern = new RegExp(
    `${platformPattern}[\\s\\S]{0,240}${commandPattern}|${commandPattern}[\\s\\S]{0,240}${platformPattern}`,
  );

  assert.match(content, nearbyPattern);
}

function sectionByHeading(content: string, heading: string): string {
  const level = heading.match(/^#+/)?.[0].length;
  assert.ok(level, `Heading must start with # characters: ${heading}`);

  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => line === heading);
  assert.notEqual(headingIndex, -1, `Missing section ${heading}`);

  let inFence = false;
  let endIndex = lines.length;
  const headingPattern = new RegExp(`^#{1,${level}}\\s+`);
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && headingPattern.test(line)) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(headingIndex + 1, endIndex).join("\n");
}

test("README documents Tier 1 workspace selection and the portable shell command", async () => {
  const content = await readDoc("README.md");

  assert.match(content, /session-scoped selection/i);
  assertMentionsPlatformCommand(content, "Claude Code", workspaceSlash);
  assertMentionsPlatformCommand(content, "OpenCode", workspaceSlash);
  assertIncludesCommand(content, genericSessionConfigure);
  assertIncludesCommand(content, durableProjectConfigure);
  assert.doesNotMatch(content, /nams-hooks:nams-hooks/);
  assert.doesNotMatch(content, /\/nams-hooks workspaces use/);
});

test("INSTALL workspace selection documents slash commands and shell fallback", async () => {
  const content = await readDoc("INSTALL.md");
  const workspaceSelection = sectionByHeading(content, "### Workspace Selection");

  assert.match(workspaceSelection, /multi-workspace inactive memory notices/i);
  assertMentionsPlatformCommand(workspaceSelection, "Claude Code", workspaceSlash);
  assertMentionsPlatformCommand(workspaceSelection, "OpenCode", workspaceSlash);
  assert.match(workspaceSelection, /slash commands[\s\S]{0,160}explicit shell command/i);
  assert.match(workspaceSelection, /shell command[\s\S]{0,160}Gemini/i);
  assert.match(workspaceSelection, /shell command[\s\S]{0,160}Codex/i);
  assertIncludesCommand(workspaceSelection, genericSessionConfigure);
  assertIncludesCommand(workspaceSelection, opencodeSessionExample);
  assert.doesNotMatch(workspaceSelection, /nams-hooks:nams-hooks/);
  assert.doesNotMatch(workspaceSelection, /\/nams-hooks workspaces use/);
});

test("INSTALL platform notes keep platform-specific workspace command guidance", async () => {
  const content = await readDoc("INSTALL.md");
  const claude = sectionByHeading(content, "## Claude Code");
  const codex = sectionByHeading(content, "## Codex");
  const gemini = sectionByHeading(content, "## Gemini CLI");
  const opencode = sectionByHeading(content, "## OpenCode");

  assert.match(claude, /project template/i);
  assert.match(claude, /Claude plugin/i);
  assertIncludesCommand(claude, workspaceSlash);
  assertIncludesCommand(
    claude,
    "nams-hooks workspaces configure claude --scope session --session-id <session-id> --workspace <workspace-id-or-name>",
  );

  assert.match(codex, /does not currently expose deterministic/i);
  assert.match(codex, /\/nams:workspace use/);
  assertIncludesCommand(
    codex,
    "nams-hooks workspaces configure codex --scope session --session-id <session-id> --workspace <workspace-id-or-name>",
  );

  assert.match(gemini, /slash-command support/i);
  assert.match(gemini, /deferred/i);
  assertIncludesCommand(
    gemini,
    "nams-hooks workspaces configure gemini --scope session --session-id <session-id> --workspace <workspace-id-or-name>",
  );

  assertIncludesCommand(opencode, workspaceSlash);
  assertIncludesCommand(
    opencode,
    "nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>",
  );
});

test("session workspace research note reflects Tier 1 support and safe Claude handling", async () => {
  const content = await readDoc("docs/session-workspace-command-support.md");
  const intro = content.slice(0, content.indexOf("## Current Repo State"));
  const remainingUxWork = sectionByHeading(content, "## Remaining UX Work");

  assertMentionsPlatformCommand(intro, "Claude Code", workspaceSlash);
  assertMentionsPlatformCommand(intro, "OpenCode", workspaceSlash);
  assertIncludesCommand(intro, genericSessionConfigure);
  assertIncludesCommand(remainingUxWork, workspaceSlash);
  assertIncludesCommand(remainingUxWork, genericSessionConfigure);
  assert.match(remainingUxWork, /Gemini CLI[\s\S]{0,160}deferred/i);
  assert.match(remainingUxWork, /Codex[\s\S]{0,160}explicit shell configuration/i);
  assert.doesNotMatch(remainingUxWork, /Add Claude Code UX first/);
  assert.doesNotMatch(content, /current shim does not yet intercept a user command/);
  assert.doesNotMatch(content, /nams-hooks:nams-hooks/);
  assert.match(content, /UserPromptExpansion/);
  assert.match(content, /\$ARGUMENTS[^.]*must not be interpolated into a shell command/s);
});
