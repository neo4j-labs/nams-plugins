import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workspaceSlash = "/nams:workspace use <workspace-id-or-name>";
const claudeMarketplaceSlash = "/nams-hooks:nams:workspace use <workspace-id-or-name>";
const codexSkillCommand = "$nams:workspace use <workspace-id-or-name>";
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

function tableRowByFirstCell(markdownTable: string, firstCell: string): string {
  const row = markdownTable
    .split("\n")
    .find((line) => line.trim().startsWith(`| ${firstCell} |`));

  assert.ok(row, `Missing table row for ${firstCell}`);
  return row;
}

test("README documents Tier 1 workspace selection and the portable shell command", async () => {
  const content = await readDoc("README.md");

  assert.match(content, /session-scoped selection/i);
  assertMentionsPlatformCommand(content, "Claude Code", workspaceSlash);
  assertMentionsPlatformCommand(content, "Claude marketplace", claudeMarketplaceSlash);
  assertMentionsPlatformCommand(content, "Gemini", workspaceSlash);
  assertMentionsPlatformCommand(content, "Codex", codexSkillCommand);
  assert.match(content, /OpenCode[\s\S]{0,240}explicit shell command/i);
  assert.match(content, /OpenCode[\s\S]{0,240}markdown commands are prompt templates/i);
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
  assertMentionsPlatformCommand(workspaceSelection, "Claude marketplace", claudeMarketplaceSlash);
  assertMentionsPlatformCommand(workspaceSelection, "Gemini", workspaceSlash);
  assertMentionsPlatformCommand(workspaceSelection, "Codex", codexSkillCommand);
  assert.match(workspaceSelection, /OpenCode[\s\S]{0,240}explicit shell command/i);
  assert.match(workspaceSelection, /OpenCode markdown\s+commands are prompt\s+templates/i);
  assert.match(workspaceSelection, /command surfaces[\s\S]{0,160}explicit shell command/i);
  assert.doesNotMatch(workspaceSelection, /Keep using the shell command for Gemini, Codex/);
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
  assertIncludesCommand(claude, claudeMarketplaceSlash);
  assertIncludesCommand(
    claude,
    "nams-hooks workspaces configure claude --scope session --session-id <session-id> --workspace <workspace-id-or-name>",
  );

  assert.match(codex, /explicit skill/i);
  assertIncludesCommand(codex, codexSkillCommand);
  assert.doesNotMatch(codex, /does not currently expose deterministic/);
  assertIncludesCommand(
    codex,
    "nams-hooks workspaces configure codex --scope session --session-id <session-id> --workspace <workspace-id-or-name>",
  );

  assert.match(gemini, /custom command/i);
  assertIncludesCommand(gemini, workspaceSlash);
  assert.doesNotMatch(gemini, /deferred/i);
  assertIncludesCommand(
    gemini,
    "nams-hooks workspaces configure gemini --scope session --session-id <session-id> --workspace <workspace-id-or-name>",
  );

  assert.match(opencode, /OpenCode markdown\s+commands are prompt templates/i);
  assert.match(opencode, /does not package\s+`.opencode\/commands\/nams:workspace.md`/i);
  assert.doesNotMatch(opencode, /\/nams:workspace use <workspace-id-or-name>/);
  assertIncludesCommand(
    opencode,
    "nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>",
  );
});

test("session workspace research note reflects Tier 1 support and safe Claude handling", async () => {
  const content = await readDoc("docs/session-workspace-command-support.md");
  const intro = content.slice(0, content.indexOf("## Current Repo State"));
  const platformMatrix = sectionByHeading(content, "## Platform Matrix");
  const opencodeMatrixRow = tableRowByFirstCell(platformMatrix, "OpenCode");
  const geminiMatrixRow = tableRowByFirstCell(platformMatrix, "Gemini CLI");
  const codexMatrixRow = tableRowByFirstCell(platformMatrix, "Codex");
  const opencode = sectionByHeading(content, "### OpenCode");
  const gemini = sectionByHeading(content, "### Gemini CLI");
  const codex = sectionByHeading(content, "### Codex");
  const remainingUxWork = sectionByHeading(content, "## Remaining UX Work");

  assertMentionsPlatformCommand(intro, "Claude Code", workspaceSlash);
  assertMentionsPlatformCommand(intro, "Claude marketplace", claudeMarketplaceSlash);
  assertMentionsPlatformCommand(intro, "Gemini", workspaceSlash);
  assertMentionsPlatformCommand(intro, "Codex", codexSkillCommand);
  assert.match(intro, /OpenCode[\s\S]{0,240}explicit shell/i);
  assert.match(opencodeMatrixRow, /Shell fallback/i);
  assert.match(opencodeMatrixRow, /markdown command files are prompt templates/i);
  assert.match(opencodeMatrixRow, /must not package/i);
  assertIncludesCommand(intro, genericSessionConfigure);
  assert.doesNotMatch(intro, /Tier 1 user-facing forms are/i);
  assert.doesNotMatch(intro, /# Claude Code and OpenCode/);
  assertIncludesCommand(geminiMatrixRow, workspaceSlash);
  assert.match(geminiMatrixRow, /active-session\s+bridge/i);
  assert.match(geminiMatrixRow, /shell fallback/i);
  assert.doesNotMatch(geminiMatrixRow, /bridge is still needed/i);
  assertIncludesCommand(codexMatrixRow, codexSkillCommand);
  assert.match(codexMatrixRow, /active-session\s+bridge/i);
  assert.match(codexMatrixRow, /shell fallback/i);
  assert.doesNotMatch(codexMatrixRow, /Prompt-helper only/i);
  assert.doesNotMatch(codexMatrixRow, /custom prompts/i);
  assert.match(opencode, /not currently a safe slash-command fit/i);
  assert.match(opencode, /must not package\s+`.opencode\/commands\/nams:workspace.md`/i);
  assert.match(opencode, /unconditionally calls its prompt path/i);
  assertIncludesCommand(opencode, "nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>");
  assert.match(gemini, /extension custom command/i);
  assertIncludesCommand(gemini, workspaceSlash);
  assert.match(gemini, /active-session\s+bridge/i);
  assert.match(gemini, /missing or ambiguous/i);
  assert.doesNotMatch(gemini, /close, but not quite direct/i);
  assert.doesNotMatch(gemini, /bridge is implemented/i);
  assert.doesNotMatch(gemini, /Keep Gemini on the current runtime auto-selection/i);
  assert.match(codex, /explicit skill/i);
  assertIncludesCommand(codex, codexSkillCommand);
  assert.match(codex, /active NAMS session cannot be resolved/i);
  assert.doesNotMatch(codex, /does not expose deterministic/i);
  assert.doesNotMatch(codex, /prompt-only helper skill/i);
  assert.doesNotMatch(codex, /optionally provide a prompt/i);
  assertIncludesCommand(remainingUxWork, workspaceSlash);
  assertIncludesCommand(remainingUxWork, codexSkillCommand);
  assertIncludesCommand(remainingUxWork, genericSessionConfigure);
  assert.match(remainingUxWork, /OpenCode[\s\S]{0,240}explicit configure command/i);
  assert.match(remainingUxWork, /Gemini CLI[\s\S]{0,240}active-session\s+bridge/i);
  assert.match(remainingUxWork, /Codex[\s\S]{0,240}\$nams:workspace/i);
  assert.doesNotMatch(remainingUxWork, /Gemini CLI[\s\S]{0,160}deferred/i);
  assert.doesNotMatch(remainingUxWork, /Codex[\s\S]{0,160}explicit shell configuration/i);
  assert.doesNotMatch(remainingUxWork, /Add Claude Code UX first/);
  assert.doesNotMatch(content, /current shim does not yet intercept a user command/);
  assert.doesNotMatch(content, /nams-hooks:nams-hooks/);
  assert.match(content, /UserPromptExpansion/);
  assert.match(content, /\$ARGUMENTS[^.]*must not be interpolated into a shell command/s);
});
