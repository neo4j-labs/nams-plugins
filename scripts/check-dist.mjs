import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmDistDir = path.join(root, "dist");
const marketplaceDistDir = path.join(root, "dist-marketplace");
const localDistDir = path.join(root, "dist-local");
const generatedClientPath = path.join(npmDistDir, "bin", "generated", "nams-client.js");
const rootPackagePath = path.join(root, "package.json");
const releasePackageName = "@neo4j-labs/nams-plugins";
const execFileAsync = promisify(execFile);
const codexHookEvents = ["SessionStart", "UserPromptSubmit", "Stop", "PostToolUse"];
const npmRuntimeFilePatterns = [
  /^package\.json$/,
  /^bin\/.+$/,
];
const forbiddenNpmArtifactPatterns = [
  /^(dist\/)?templates(\/|$)/,
  /^dist-marketplace(\/|$)/,
  /^dist-local(\/|$)/,
  /^(dist\/)?(plugins|commands|hooks)(\/|$)/,
  /(^|\/)(\.agents|\.claude-plugin|\.codex-plugin|\.opencode|\.claude|\.codex|\.gemini)(\/|$)/,
  /^(dist\/)?(claude|codex|gemini|opencode)(\/|$)/,
  /^(dist\/)?gemini-extension\.json$/,
  /(^|\/)settings\.local\.json$/,
  /(^|\/)nams-hooks\.js$/,
];

const rootPackageJson = await verifySourcePackageIdentity(rootPackagePath);
await verifyRootPackageFiles(rootPackagePath);
await verifyNpmDist(rootPackageJson);
await verifyMarketplaceDist();
await verifyLocalDist();
await checkPackedPackage(root, "dist/bin/cli.js", { packageJson: rootPackageJson, identityAlreadyVerified: true });
await checkPackedPackage(npmDistDir, "bin/cli.js");

async function verifyNpmDist(rootPackageJson) {
  await assertExecutable(path.join(npmDistDir, "bin", "cli.js"));
  await access(generatedClientPath);

  const packageJson = JSON.parse(await readFile(path.join(npmDistDir, "package.json"), "utf8"));
  assertPackageIdentity(packageJson, npmDistDir, "./bin/cli.js");
  if (packageJson.version !== rootPackageJson.version || packageJson.license !== rootPackageJson.license) {
    throw new Error("dist/package.json version and license must match package.json.");
  }
  if (Object.hasOwn(packageJson, "files")) {
    throw new Error("dist/package.json must not define files because dist is already the package root.");
  }

  const source = await readFile(generatedClientPath, "utf8");
  if (/nams-openapi|readFile/.test(source)) {
    throw new Error("dist/bin/generated/nams-client.js must not read OpenAPI at runtime.");
  }

  const files = await listFiles(npmDistDir);
  assertOnlyMatchingFiles(files, npmRuntimeFilePatterns, "dist must include only npm runtime/package files");
  assertNoForbiddenNpmArtifacts(files, "dist must not include marketplace, local, template, or platform configuration artifacts");
  assertNoMatchingFiles(files, /openapi|nams-openapi/i, "dist must not include OpenAPI artifacts");
}

async function verifyMarketplaceDist() {
  await verifyGeminiMarketplaceFiles();
  await verifyClaudeMarketplaceFiles();
  await verifyCodexMarketplaceFiles();
  await verifyOpenCodeMarketplaceFiles();
  await verifyMarketplacePluginPackageMetadata();
  await verifyMarketplaceCliRunsOutsidePackageScope();

  const files = await listFiles(marketplaceDistDir);
  assertNoMatchingFiles(files, /openapi|nams-openapi/i, "dist-marketplace must not include OpenAPI artifacts");
  const unresolved = await filesWithPattern(marketplaceDistDir, /__PACKAGE_VERSION__|__PACKAGE_LICENSE__|__NAMS_HOOKS_COMMAND__/);
  if (unresolved.length > 0) {
    throw new Error(`dist-marketplace contains unresolved template placeholders: ${unresolved.join(", ")}`);
  }
}

async function verifyLocalDist() {
  await verifyLocalCommandJson(path.join(localDistDir, "claude", ".claude", "settings.local.json"), "claude");
  await verifyLocalClaudeWorkspaceCommand(path.join(localDistDir, "claude", ".claude", "commands", "nams", "workspace.md"));
  await verifyLocalCommandJson(path.join(localDistDir, "codex", ".codex", "hooks.json"), "codex");
  await verifyLocalCodexWorkspaceSkill(
    path.join(localDistDir, "codex", ".codex", "skills", "workspace", "SKILL.md"),
    path.join(localDistDir, "codex", ".codex", "skills", "workspace", "agents", "openai.yaml"),
  );
  await verifyLocalCommandJson(path.join(localDistDir, "gemini", ".gemini", "settings.json"), "gemini");
  await verifyLocalGeminiWorkspaceCommand(path.join(localDistDir, "gemini", ".gemini", "commands", "nams", "workspace.toml"));

  const opencodeSource = await readFile(path.join(localDistDir, "opencode", ".opencode", "plugins", "nams-hooks.js"), "utf8");
  if (!/"nams-hooks"/.test(opencodeSource) || /new URL\("\.\/bin\/cli\.js"/.test(opencodeSource)) {
    throw new Error("dist-local OpenCode plugin must default to the installed nams-hooks executable.");
  }

  const files = await listFiles(localDistDir);
  assertNoMatchingFiles(files, /(^|\/)bin\/cli\.js$/, "dist-local must not include compiled runtime");
  assertNoMatchingFiles(files, /(^|\/)(\.agents\/plugins\/marketplace\.json|\.claude-plugin\/marketplace\.json)$/, "dist-local must not include marketplace roots");
  assertNoMatchingFiles(files, /(^|\/)plugins\/(claude-nams-hooks|codex-nams-hooks|gemini-nams-hooks|opencode-nams-hooks)(\/|$)/, "dist-local must not include marketplace plugin roots");
  assertNoMatchingFiles(files, /^gemini\/\.gemini\/extensions(\/|$)/, "dist-local Gemini must be symlinkable project config, not an extension package");

  const unresolved = await filesWithPattern(localDistDir, /__PACKAGE_VERSION__|__PACKAGE_LICENSE__|__NAMS_HOOKS_COMMAND__/);
  if (unresolved.length > 0) {
    throw new Error(`dist-local contains unresolved template placeholders: ${unresolved.join(", ")}`);
  }
}

async function verifyGeminiMarketplaceFiles() {
  const extensionPath = path.join(marketplaceDistDir, "gemini-extension.json");
  const hooksPath = path.join(marketplaceDistDir, "hooks", "hooks.json");
  const commandPath = path.join(marketplaceDistDir, "commands", "nams", "workspace.toml");
  const cliPath = path.join(marketplaceDistDir, "plugins", "gemini-nams-hooks", "bin", "cli.js");

  await access(extensionPath);
  await access(hooksPath);
  await access(commandPath);
  await assertExecutable(cliPath);
  await verifyGeminiExtensionSettings(extensionPath);

  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  assertGeminiMarketplaceCommand(hooks, "SessionStart", "SessionStart");
  assertGeminiMarketplaceCommand(hooks, "BeforeAgent", "BeforeAgent");
  assertGeminiMarketplaceCommand(hooks, "AfterAgent", "AfterAgent");
  assertGeminiMarketplaceCommand(hooks, "AfterTool", "AfterTool");
  await verifyGeminiMarketplaceWorkspaceCommand(commandPath);
}

async function verifyClaudeMarketplaceFiles() {
  const marketplacePath = path.join(marketplaceDistDir, ".claude-plugin", "marketplace.json");
  const manifestPath = path.join(marketplaceDistDir, "plugins", "claude-nams-hooks", ".claude-plugin", "plugin.json");
  const hooksPath = path.join(marketplaceDistDir, "plugins", "claude-nams-hooks", "hooks", "hooks.json");
  const commandPath = path.join(marketplaceDistDir, "plugins", "claude-nams-hooks", "commands", "nams", "workspace.md");
  const cliPath = path.join(marketplaceDistDir, "plugins", "claude-nams-hooks", "bin", "cli.js");

  await access(marketplacePath);
  await access(manifestPath);
  await access(hooksPath);
  await access(commandPath);
  await assertExecutable(cliPath);

  const packageJson = JSON.parse(await readFile(rootPackagePath, "utf8"));
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  const plugin = JSON.parse(await readFile(manifestPath, "utf8"));
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));

  if (marketplace.name !== "nams-plugins") {
    throw new Error("dist-marketplace/.claude-plugin/marketplace.json must name the marketplace nams-plugins.");
  }
  if (marketplace.metadata?.version !== packageJson.version) {
    throw new Error("Claude marketplace metadata version must match package.json.");
  }
  const marketplacePlugin = marketplace.plugins?.[0];
  if (marketplacePlugin?.name !== "nams-hooks" || marketplacePlugin.source !== "./plugins/claude-nams-hooks") {
    throw new Error("Claude marketplace must expose nams-hooks from ./plugins/claude-nams-hooks.");
  }
  if (marketplacePlugin.repository !== "https://github.com/neo4j-labs/nams-plugins") {
    throw new Error("Claude marketplace plugin repository must point to neo4j-labs/nams-plugins.");
  }
  if (marketplacePlugin.version !== packageJson.version || marketplacePlugin.license !== packageJson.license) {
    throw new Error("Claude marketplace plugin version and license must match package.json.");
  }
  if (plugin.name !== "nams-hooks" || plugin.version !== packageJson.version) {
    throw new Error("Claude plugin manifest must name nams-hooks and match package.json version.");
  }
  if (plugin.repository !== "https://github.com/neo4j-labs/nams-plugins") {
    throw new Error("Claude plugin manifest repository must point to neo4j-labs/nams-plugins.");
  }
  if (plugin.license !== packageJson.license) {
    throw new Error("Claude plugin manifest license must match package.json.");
  }
  if (Object.hasOwn(plugin, "hooks")) {
    throw new Error("Claude plugin manifest must not reference standard hooks/hooks.json because Claude loads it automatically.");
  }

  assertClaudePluginUserConfig(plugin);
  assertClaudeHookCommand(hooks, "SessionStart", "SessionStart");
  assertClaudeHookCommand(hooks, "UserPromptSubmit", "BeforeAgent");
  assertClaudeHookCommand(hooks, "PostToolUse", "AfterTool");
  assertClaudeHookCommand(hooks, "Stop", "AfterAgent");
  assertClaudeWorkspaceCommand(hooks);
  await verifyClaudeWorkspaceMarkdown(commandPath);
}

async function verifyCodexMarketplaceFiles() {
  const marketplacePath = path.join(marketplaceDistDir, ".agents", "plugins", "marketplace.json");
  const manifestPath = path.join(marketplaceDistDir, "plugins", "codex-nams-hooks", ".codex-plugin", "plugin.json");
  const hooksPath = path.join(marketplaceDistDir, "plugins", "codex-nams-hooks", "hooks", "hooks.json");
  const skillPath = path.join(marketplaceDistDir, "plugins", "codex-nams-hooks", "skills", "workspace", "SKILL.md");
  const skillPolicyPath = path.join(marketplaceDistDir, "plugins", "codex-nams-hooks", "skills", "workspace", "agents", "openai.yaml");
  const cliPath = path.join(marketplaceDistDir, "plugins", "codex-nams-hooks", "bin", "cli.js");

  await access(marketplacePath);
  await access(manifestPath);
  await access(hooksPath);
  await access(skillPath);
  await access(skillPolicyPath);
  await assertExecutable(cliPath);

  const packageJson = JSON.parse(await readFile(rootPackagePath, "utf8"));
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  const plugin = JSON.parse(await readFile(manifestPath, "utf8"));
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));

  if (marketplace.name !== "nams-plugins") {
    throw new Error("dist-marketplace/.agents/plugins/marketplace.json must name the marketplace nams-plugins.");
  }
  if (marketplace.metadata?.version !== packageJson.version) {
    throw new Error("Codex marketplace metadata version must match package.json.");
  }
  const marketplacePlugin = marketplace.plugins?.[0];
  if (marketplacePlugin?.name !== "nams-hooks") {
    throw new Error("Codex marketplace must expose the nams-hooks plugin.");
  }
  if (marketplacePlugin.source?.source !== "local" || marketplacePlugin.source?.path !== "./plugins/codex-nams-hooks") {
    throw new Error("Codex marketplace must expose nams-hooks from ./plugins/codex-nams-hooks.");
  }
  if (marketplacePlugin.repository !== "https://github.com/neo4j-labs/nams-plugins") {
    throw new Error("Codex marketplace plugin repository must point to neo4j-labs/nams-plugins.");
  }
  if (marketplacePlugin.policy?.installation !== "AVAILABLE") {
    throw new Error("Codex marketplace must mark nams-hooks as available for installation.");
  }
  if (marketplacePlugin.policy?.authentication !== "ON_USE") {
    throw new Error("Codex marketplace must defer marketplace authentication policy until first use.");
  }
  if (Object.hasOwn(marketplacePlugin ?? {}, "userConfig") || Object.hasOwn(marketplacePlugin ?? {}, "authentication")) {
    throw new Error("Codex marketplace plugin must not define NAMS credential prompts.");
  }
  if (marketplacePlugin.version !== packageJson.version || marketplacePlugin.license !== packageJson.license) {
    throw new Error("Codex marketplace plugin version and license must match package.json.");
  }

  if (plugin.name !== "nams-hooks" || plugin.version !== packageJson.version) {
    throw new Error("Codex plugin manifest must name nams-hooks and match package.json version.");
  }
  if (plugin.repository !== "https://github.com/neo4j-labs/nams-plugins") {
    throw new Error("Codex plugin manifest repository must point to neo4j-labs/nams-plugins.");
  }
  if (plugin.license !== packageJson.license) {
    throw new Error("Codex plugin manifest license must match package.json.");
  }
  if (plugin.skills !== "./skills/") {
    throw new Error("Codex plugin manifest must expose bundled skills from ./skills/.");
  }
  if (Object.hasOwn(plugin, "userConfig") || Object.hasOwn(plugin, "authentication")) {
    throw new Error("Codex plugin manifest must not define NAMS credential prompts.");
  }

  assertCodexHookEventSet(hooks);
  assertCodexHookCommand(hooks, "SessionStart", "SessionStart", "Loading session notes", "startup|resume");
  assertCodexHookCommand(hooks, "UserPromptSubmit", "BeforeAgent", "NAMS memory recall");
  assertCodexHookCommand(hooks, "Stop", "AfterAgent", "NAMS assistant persistence");
  assertCodexHookCommand(hooks, "PostToolUse", "AfterTool", "NAMS tool metadata");
  await verifyCodexWorkspaceSkill(skillPath, skillPolicyPath);
}

async function verifyOpenCodeMarketplaceFiles() {
  const pluginPath = path.join(marketplaceDistDir, "plugins", "opencode-nams-hooks", "nams-hooks.js");
  const cliPath = path.join(marketplaceDistDir, "plugins", "opencode-nams-hooks", "bin", "cli.js");

  await access(pluginPath);
  await assertExecutable(cliPath);

  const source = await readFile(pluginPath, "utf8");
  if (!/fileURLToPath\(new URL\("\.\/bin\/cli\.js", import\.meta\.url\)\)/.test(source)) {
    throw new Error("OpenCode marketplace plugin must default to its bundled bin/cli.js.");
  }
  if (/NAMS_HOOKS_COMMAND \?\? "nams-hooks"/.test(source)) {
    throw new Error("OpenCode marketplace plugin must not default to a global nams-hooks executable.");
  }
  if (!/command\.execute\.before/.test(source) || !/workspaces",\s*"run",\s*"opencode"/.test(source)) {
    throw new Error("OpenCode marketplace plugin must intercept nams:workspace and call workspaces run opencode.");
  }
}

async function verifyMarketplacePluginPackageMetadata() {
  for (const platform of ["claude", "codex", "gemini", "opencode"]) {
    const pluginRoot = path.join(marketplaceDistDir, "plugins", `${platform}-nams-hooks`);
    const packageJson = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
    if (packageJson.type !== "module") {
      throw new Error(`dist-marketplace/plugins/${platform}-nams-hooks/package.json must set type to module.`);
    }
    if (packageJson.bin?.["nams-hooks"] !== "./bin/cli.js") {
      throw new Error(`dist-marketplace/plugins/${platform}-nams-hooks/package.json must expose bin.nams-hooks at ./bin/cli.js.`);
    }
  }
}

async function verifyMarketplaceCliRunsOutsidePackageScope() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nams hooks marketplace cli "));
  try {
    const pluginRoot = path.join(tempRoot, "copied plugin");
    await cp(path.join(marketplaceDistDir, "plugins", "opencode-nams-hooks"), pluginRoot, { recursive: true });
    const nodeArgs = await supportedNodeArgs(["--no-experimental-detect-module"]);
    const result = await execFileSettled(process.execPath, [...nodeArgs, path.join(pluginRoot, "bin", "cli.js")], {
      cwd: tempRoot,
    });
    if (result.code !== 1) {
      throw new Error(`copied marketplace CLI should exit 1 with usage, got ${result.code}. stderr: ${result.stderr}`);
    }
    if (!/Usage: nams-hooks/.test(result.stderr)) {
      throw new Error(`copied marketplace CLI should print usage, got stderr: ${result.stderr}`);
    }
    if (/SyntaxError|Cannot use import statement|Unexpected token/.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(`copied marketplace CLI failed module loading: ${result.stderr}`);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function assertGeminiMarketplaceCommand(hooks, eventName, namsEvent) {
  const handler = hooks.hooks?.[eventName]?.[0]?.hooks?.[0];
  const expected = `node "\${extensionPath}/plugins/gemini-nams-hooks/bin/cli.js" run gemini --event ${namsEvent}`;
  if (handler?.type !== "command" || handler.command !== expected) {
    throw new Error(`Gemini marketplace ${eventName} hook must invoke ${expected}.`);
  }
}

async function verifyGeminiMarketplaceWorkspaceCommand(filePath) {
  const source = await readFile(filePath, "utf8");
  const installedCliPath = "$HOME/.gemini/extensions/nams-hooks/plugins/gemini-nams-hooks/bin/cli.js";
  if (!/workspaces run gemini --event CustomCommand/.test(source)) {
    throw new Error("Gemini marketplace workspace command must route through CustomCommand.");
  }
  if (!source.includes(installedCliPath)) {
    throw new Error(`Gemini marketplace workspace command must call ${installedCliPath}.`);
  }
  if (/\$\{extensionPath\}/.test(source)) {
    throw new Error("Gemini marketplace workspace command TOML must not rely on extensionPath substitution.");
  }
  if (!/NAMS workspace command result/.test(source) || !/Do not run additional shell commands/.test(source)) {
    throw new Error("Gemini marketplace workspace command must emit a model-facing command result prompt.");
  }
  if (!/echo '\{ "command_name": "nams:workspace", "command_args": "\{\{args\}\}" \}'/.test(source) || /node -e/.test(source)) {
    throw new Error("Gemini marketplace workspace command must keep the readable echo payload.");
  }
  if (/workspaces configure/.test(source)) {
    throw new Error("Gemini marketplace workspace command must not call workspaces configure directly.");
  }
}

async function verifyLocalGeminiWorkspaceCommand(filePath) {
  const source = await readFile(filePath, "utf8");
  if (!/nams-hooks workspaces run gemini --event CustomCommand/.test(source)) {
    throw new Error("Gemini local workspace command must call the installed nams-hooks executable.");
  }
  if (!/NAMS workspace command result/.test(source) || !/Do not run additional shell commands/.test(source)) {
    throw new Error("Gemini local workspace command must emit a model-facing command result prompt.");
  }
  if (!/echo '\{ "command_name": "nams:workspace", "command_args": "\{\{args\}\}" \}'/.test(source) || /node -e/.test(source)) {
    throw new Error("Gemini local workspace command must keep the readable echo payload.");
  }
  if (/\$\{extensionPath\}|bin\/cli\.js|workspaces configure/.test(source)) {
    throw new Error("Gemini local workspace command must not use bundled runtime paths or workspaces configure.");
  }
}

function assertClaudeWorkspaceCommand(hooks) {
  const group = hooks.hooks?.UserPromptExpansion?.[0];
  const handler = group?.hooks?.[0];
  const args = handler?.args ?? [];
  const expectedArgs = ["${CLAUDE_PLUGIN_ROOT}/bin/cli.js", "workspaces", "run", "claude", "--event", "UserPromptExpansion"];

  if (group?.matcher !== "^(?:nams-hooks:)?nams:workspace$") {
    throw new Error("Claude marketplace workspace hook must match bare and plugin-namespaced nams:workspace.");
  }
  if (handler?.type !== "command" || handler.command !== "node" || JSON.stringify(args) !== JSON.stringify(expectedArgs)) {
    throw new Error("Claude marketplace workspace hook must call the bundled CLI workspace runner.");
  }
}

async function verifyClaudeWorkspaceMarkdown(filePath) {
  const source = await readFile(filePath, "utf8");
  if (!/argument-hint: use <workspace-id-or-name>/.test(source) || !/disable-model-invocation: true/.test(source)) {
    throw new Error("Claude workspace command markdown must disable model invocation and document the use argument.");
  }
  if (!/\/nams:workspace use <workspace-id-or-name>/.test(source)) {
    throw new Error("Claude workspace command markdown must document /nams:workspace use.");
  }
  if (!/\/nams-hooks:nams:workspace use <workspace-id-or-name>/.test(source)) {
    throw new Error("Claude marketplace workspace command markdown must document /nams-hooks:nams:workspace use.");
  }
  if (/workspaces configure|workspace-use\.mjs|\$ARGUMENTS/.test(source)) {
    throw new Error("Claude workspace command markdown must not call configuration helpers directly.");
  }
}

async function verifyLocalClaudeWorkspaceCommand(filePath) {
  const source = await readFile(filePath, "utf8");
  if (!/\/nams:workspace use <workspace-id-or-name>/.test(source)) {
    throw new Error("Claude local workspace command markdown must document /nams:workspace use.");
  }
  if (/workspaces configure|workspace-use\.mjs|\$ARGUMENTS/.test(source)) {
    throw new Error("Claude local workspace command markdown must not call configuration helpers directly.");
  }
}

async function verifyCodexWorkspaceSkill(skillPath, policyPath) {
  const skill = await readFile(skillPath, "utf8");
  const policy = await readFile(policyPath, "utf8");

  if (!/name: nams:workspace/.test(skill) || !/workspaces run codex --event CustomCommand/.test(skill)) {
    throw new Error("Codex workspace skill must expose nams:workspace through the CustomCommand runner.");
  }
  if (!/node bin\/cli\.js workspaces run codex --event CustomCommand/.test(skill)) {
    throw new Error("Codex workspace skill must prefer the bundled plugin CLI.");
  }
  if (!/nams-hooks workspaces run codex --event CustomCommand/.test(skill)) {
    throw new Error("Codex workspace skill must document the installed executable fallback.");
  }
  if (!/allow_implicit_invocation: false/.test(policy)) {
    throw new Error("Codex workspace skill policy must disable implicit invocation.");
  }
}

async function verifyLocalCodexWorkspaceSkill(skillPath, policyPath) {
  const skill = await readFile(skillPath, "utf8");
  const policy = await readFile(policyPath, "utf8");

  if (!/name: nams:workspace/.test(skill) || !/workspaces run codex --event CustomCommand/.test(skill)) {
    throw new Error("Codex local workspace skill must expose nams:workspace through the CustomCommand runner.");
  }
  if (!/nams-hooks workspaces run codex --event CustomCommand/.test(skill)) {
    throw new Error("Codex local workspace skill must use the installed nams-hooks executable.");
  }
  if (/node bin\/cli\.js|\$\{PLUGIN_ROOT\}|plugin root/i.test(skill)) {
    throw new Error("Codex local workspace skill must not reference bundled plugin runtime paths.");
  }
  if (/workspaces configure/.test(skill)) {
    throw new Error("Codex local workspace skill must not call workspaces configure directly.");
  }
  if (!/allow_implicit_invocation: false/.test(policy)) {
    throw new Error("Codex local workspace skill policy must disable implicit invocation.");
  }
}

async function verifyLocalCommandJson(filePath, platform) {
  const source = await readFile(filePath, "utf8");
  const parsed = JSON.parse(source);
  const commands = JSON.stringify(parsed);
  if (!commands.includes(`nams-hooks run ${platform} --event`)) {
    throw new Error(`${path.relative(root, filePath)} must call installed nams-hooks for ${platform}.`);
  }
  if (/bin\/cli\.js|\$\{PLUGIN_ROOT\}|\$\{CLAUDE_PLUGIN_ROOT\}|\$\{extensionPath\}/.test(commands)) {
    throw new Error(`${path.relative(root, filePath)} must not reference bundled runtime paths.`);
  }
}

function assertClaudePluginUserConfig(plugin) {
  const apiKey = plugin.userConfig?.NAMS_API_KEY;
  if (apiKey?.type !== "string" || apiKey.title !== "NAMS API key" || apiKey.sensitive !== true || apiKey.required !== true) {
    throw new Error("Claude plugin manifest must require a sensitive NAMS_API_KEY userConfig value.");
  }

  const workspaceId = plugin.userConfig?.NAMS_WORKSPACE_ID;
  if (workspaceId?.type !== "string" || workspaceId.title !== "NAMS workspace ID" || workspaceId.required === true) {
    throw new Error("Claude plugin manifest must define an optional NAMS_WORKSPACE_ID userConfig value.");
  }
  if (workspaceId.sensitive === true) {
    throw new Error("Claude plugin NAMS_WORKSPACE_ID must be non-sensitive.");
  }

  const baseUrl = plugin.userConfig?.NAMS_BASE_URL;
  if (baseUrl?.type !== "string" || baseUrl.title !== "NAMS base URL" || baseUrl.default !== "https://memory.neo4jlabs.com") {
    throw new Error("Claude plugin manifest must define the standard NAMS_BASE_URL userConfig default.");
  }
  if (baseUrl.sensitive === true || baseUrl.required === true) {
    throw new Error("Claude plugin NAMS_BASE_URL must be non-sensitive and optional because the template supplies a default.");
  }
}

function assertClaudeHookCommand(hooks, eventName, namsEvent) {
  const handler = hooks.hooks?.[eventName]?.[0]?.hooks?.[0];
  if (handler?.type !== "command" || handler.command !== "node") {
    throw new Error(`Claude plugin ${eventName} hook must run node.`);
  }
  const expectedArgs = ["${CLAUDE_PLUGIN_ROOT}/bin/cli.js", "run", "claude", "--event", namsEvent];
  if (JSON.stringify(handler.args) !== JSON.stringify(expectedArgs)) {
    throw new Error(`Claude plugin ${eventName} hook must invoke the bundled CLI with --event ${namsEvent}.`);
  }
}

function assertCodexHookEventSet(hooks) {
  const actualEvents = Object.keys(hooks.hooks ?? {}).sort();
  const expectedEvents = [...codexHookEvents].sort();
  if (JSON.stringify(actualEvents) !== JSON.stringify(expectedEvents)) {
    throw new Error(`Codex plugin hooks must define exactly these events: ${codexHookEvents.join(", ")}.`);
  }
}

function assertCodexHookCommand(hooks, eventName, namsEvent, statusMessage, matcher) {
  const groups = hooks.hooks?.[eventName];
  if (!Array.isArray(groups) || groups.length !== 1) {
    throw new Error(`Codex plugin ${eventName} hook must define exactly one hook group.`);
  }
  const group = groups[0];
  if (!Array.isArray(group.hooks) || group.hooks.length !== 1) {
    throw new Error(`Codex plugin ${eventName} hook must define exactly one command handler.`);
  }
  const handler = group.hooks[0];
  if (matcher === undefined && Object.hasOwn(group ?? {}, "matcher")) {
    throw new Error(`Codex plugin ${eventName} hook must not declare a matcher.`);
  }
  if (matcher !== undefined && group?.matcher !== matcher) {
    throw new Error(`Codex plugin ${eventName} hook must use matcher ${matcher}.`);
  }
  if (handler?.type !== "command") {
    throw new Error(`Codex plugin ${eventName} hook must be a command hook.`);
  }
  const expectedCommand = `node \${PLUGIN_ROOT}/bin/cli.js run codex --event ${namsEvent}`;
  if (handler.command !== expectedCommand) {
    throw new Error(`Codex plugin ${eventName} hook must invoke the bundled CLI with --event ${namsEvent}.`);
  }
  if (handler.statusMessage !== statusMessage) {
    throw new Error(`Codex plugin ${eventName} hook must use status message ${statusMessage}.`);
  }
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function assertNoMatchingFiles(files, pattern, message) {
  const matches = files.filter((file) => pattern.test(file));
  if (matches.length > 0) {
    throw new Error(`${message}: ${matches.join(", ")}`);
  }
}

function assertOnlyMatchingFiles(files, patterns, message) {
  const matches = files.filter((file) => !patterns.some((pattern) => pattern.test(file)));
  if (matches.length > 0) {
    throw new Error(`${message}: ${matches.join(", ")}`);
  }
}

function assertNoForbiddenNpmArtifacts(files, message) {
  const forbiddenFiles = files.filter((file) => forbiddenNpmArtifactPatterns.some((pattern) => pattern.test(file)));
  if (forbiddenFiles.length > 0) {
    throw new Error(`${message}: ${forbiddenFiles.join(", ")}`);
  }
}

async function filesWithPattern(directory, pattern) {
  const files = await listFiles(directory);
  const matches = [];
  for (const file of files) {
    const source = await readFile(path.join(directory, file), "utf8");
    if (pattern.test(source)) {
      matches.push(file);
    }
  }
  return matches;
}

async function checkPackedPackage(packageDir, binTarget, options = {}) {
  const packageJson = options.packageJson ?? JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  if (options.identityAlreadyVerified !== true) {
    assertPackageIdentity(packageJson, packageDir, `./${binTarget}`);
  }
  await assertExecutable(path.join(packageDir, binTarget));

  const pack = await npmPackDryRun(packageDir);
  const packedFiles = pack.files.map((file) => file.path);
  assertNoForbiddenNpmArtifacts(packedFiles, "packed package must not include template, marketplace, local, plugin, or platform configuration artifacts");
  const openApiPackedFiles = packedFiles.filter((file) => /openapi|nams-openapi/i.test(file));
  if (openApiPackedFiles.length > 0) {
    throw new Error(`packed package must not include OpenAPI artifacts: ${openApiPackedFiles.join(", ")}`);
  }
  if (!packedFiles.includes(binTarget)) {
    throw new Error(`packed package is missing nams-hooks bin target: ${binTarget}`);
  }
  for (const expectedFile of npmPackedFiles(packageDir)) {
    if (!packedFiles.includes(expectedFile)) {
      throw new Error(`packed package is missing runtime file: ${expectedFile}`);
    }
  }
}

async function supportedNodeArgs(candidateArgs) {
  const supported = [];
  for (const arg of candidateArgs) {
    const result = await execFileSettled(process.execPath, [arg, "-e", ""], { cwd: root });
    if (result.code === 0) {
      supported.push(arg);
    }
  }
  return supported;
}

async function execFileSettled(command, args, options) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      ...options,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error?.code === "number" ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : String(error?.message ?? error),
    };
  }
}

function npmPackedFiles(packageDir) {
  const prefix = packageDir === root ? "dist/" : "";
  return [
    `${prefix}bin/cli.js`,
    `${prefix}bin/generated/nams-client.js`,
    `${prefix}package.json`,
  ];
}

async function assertExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK);
  } catch {
    throw new Error(`${path.relative(root, filePath)} must exist and be executable.`);
  }
}

async function verifySourcePackageIdentity(packagePath) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  assertPackageIdentity(packageJson, path.dirname(packagePath), "./dist/bin/cli.js");
  return packageJson;
}

async function verifyRootPackageFiles(packagePath) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (!Array.isArray(packageJson.files) || packageJson.files.includes("templates/")) {
    throw new Error("package.json files must not include templates/ in the npm package artifact.");
  }
  if (!packageJson.files.includes("dist/")) {
    throw new Error("package.json files must include dist/ for the npm package artifact.");
  }
}

function assertPackageIdentity(packageJson, packageDir, expectedBinTarget) {
  const packageLabel = packageDir === root ? "package.json" : `${path.relative(root, packageDir)}/package.json`;
  if (packageJson.name !== releasePackageName) {
    throw new Error(`${packageLabel} name must be ${releasePackageName}.`);
  }
  if (packageJson.bin?.["nams-hooks"] !== expectedBinTarget) {
    throw new Error(`${packageLabel} must expose the nams-hooks executable at ${expectedBinTarget}.`);
  }
}

async function verifyGeminiExtensionSettings(extensionPath) {
  const extension = JSON.parse(await readFile(extensionPath, "utf8"));
  const envVars = extension.settings?.map((setting) => setting.envVar);
  if (!Array.isArray(envVars) || !envVars.includes("NAMS_API_KEY") || !envVars.includes("NAMS_WORKSPACE_ID") || !envVars.includes("NAMS_BASE_URL")) {
    throw new Error("Gemini extension settings must include NAMS_API_KEY, NAMS_WORKSPACE_ID, and NAMS_BASE_URL.");
  }
}

async function npmPackDryRun(packageDir) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "nams-hooks-npm-cache-"));
  try {
    const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json", packageDir], {
      cwd: root,
      env: {
        ...process.env,
        npm_config_cache: cacheDir,
        npm_config_update_notifier: "false",
      },
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0].files)) {
      throw new Error("npm pack --dry-run returned an unexpected payload.");
    }
    return parsed[0];
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}
