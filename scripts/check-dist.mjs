import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const generatedClientPath = path.join(root, "dist", "bin", "generated", "nams-client.js");
const geminiExtensionPath = path.join(root, "dist", "gemini-extension.json");
const geminiCommandPath = path.join(root, "dist", "commands", "nams", "workspace.toml");
const claudeMarketplacePath = path.join(root, "dist", ".claude-plugin", "marketplace.json");
const claudePluginManifestPath = path.join(root, "dist", "plugins", "nams-hooks", ".claude-plugin", "plugin.json");
const claudePluginHooksPath = path.join(root, "dist", "plugins", "nams-hooks", "hooks", "hooks.json");
const claudePluginCommandPath = path.join(root, "dist", "plugins", "nams-hooks", "commands", "nams", "workspace.md");
const claudePluginCliPath = path.join(root, "dist", "plugins", "nams-hooks", "bin", "cli.js");
const codexMarketplacePath = path.join(root, "dist", ".agents", "plugins", "marketplace.json");
const codexPluginManifestPath = path.join(root, "dist", "plugins", "codex-nams-hooks", ".codex-plugin", "plugin.json");
const codexPluginHooksPath = path.join(root, "dist", "plugins", "codex-nams-hooks", "hooks", "hooks.json");
const codexPluginCliPath = path.join(root, "dist", "plugins", "codex-nams-hooks", "bin", "cli.js");
const codexPluginSkillPath = path.join(root, "dist", "plugins", "codex-nams-hooks", "skills", "workspace", "SKILL.md");
const codexPluginSkillPolicyPath = path.join(root, "dist", "plugins", "codex-nams-hooks", "skills", "workspace", "agents", "openai.yaml");
const codexHookEvents = ["SessionStart", "UserPromptSubmit", "Stop", "PostToolUse"];
const opencodeTemplatePath = path.join(root, "templates", "opencode", ".opencode", "plugins", "nams-hooks.js");
const rootPackagePath = path.join(root, "package.json");
const releasePackageName = "@neo4j-labs/nams-plugins";
const execFileAsync = promisify(execFile);

await access(generatedClientPath);
await access(geminiExtensionPath);
await access(geminiCommandPath);
await access(opencodeTemplatePath);
await verifyRootPackageFiles(rootPackagePath);
const rootPackageJson = await verifySourcePackageIdentity(rootPackagePath);
await verifyGeminiExtensionSettings(geminiExtensionPath);
await verifyClaudePluginFiles();
await verifyCodexPluginFiles();

const source = await readFile(generatedClientPath, "utf8");
if (/nams-openapi|readFile/.test(source)) {
  throw new Error("dist/bin/generated/nams-client.js must not read OpenAPI at runtime.");
}

const distFiles = await listFiles(distDir);
const openApiArtifacts = distFiles.filter((file) => /openapi|nams-openapi/i.test(file));
if (openApiArtifacts.length > 0) {
  throw new Error(`dist must not include runtime OpenAPI artifacts: ${openApiArtifacts.join(", ")}`);
}

await checkPackedPackage(root, "dist/bin/cli.js", { packageJson: rootPackageJson, identityAlreadyVerified: true });
await checkPackedPackage(distDir, "bin/cli.js");

async function verifyClaudePluginFiles() {
  await access(claudeMarketplacePath);
  await access(claudePluginManifestPath);
  await access(claudePluginHooksPath);
  await access(claudePluginCommandPath);
  await assertExecutable(claudePluginCliPath);

  const packageJson = JSON.parse(await readFile(rootPackagePath, "utf8"));
  const marketplace = JSON.parse(await readFile(claudeMarketplacePath, "utf8"));
  const plugin = JSON.parse(await readFile(claudePluginManifestPath, "utf8"));
  const hooks = JSON.parse(await readFile(claudePluginHooksPath, "utf8"));

  if (marketplace.name !== "nams-plugins") {
    throw new Error("dist/.claude-plugin/marketplace.json must name the marketplace nams-plugins.");
  }
  if (marketplace.plugins?.[0]?.name !== "nams-hooks" || marketplace.plugins[0].source !== "./plugins/nams-hooks") {
    throw new Error("Claude marketplace must expose nams-hooks from ./plugins/nams-hooks.");
  }
  if (marketplace.plugins[0].repository !== "https://github.com/neo4j-labs/nams-plugins") {
    throw new Error("Claude marketplace plugin repository must point to neo4j-labs/nams-plugins.");
  }
  if (marketplace.plugins[0].version !== packageJson.version) {
    throw new Error("Claude marketplace plugin version must match package.json.");
  }
  if (plugin.name !== "nams-hooks" || plugin.version !== packageJson.version) {
    throw new Error("Claude plugin manifest must name nams-hooks and match package.json version.");
  }
  if (plugin.repository !== "https://github.com/neo4j-labs/nams-plugins") {
    throw new Error("Claude plugin manifest repository must point to neo4j-labs/nams-plugins.");
  }
  if (Object.hasOwn(plugin, "hooks")) {
    throw new Error("Claude plugin manifest must not reference standard hooks/hooks.json because Claude loads it automatically.");
  }
  assertClaudePluginUserConfig(plugin);

  assertClaudeHookCommand(hooks, "SessionStart", "SessionStart");
  assertClaudeHookCommand(hooks, "UserPromptSubmit", "BeforeAgent");
  assertClaudeWorkspaceCommandHook(hooks);
  assertClaudeHookCommand(hooks, "PostToolUse", "AfterTool");
  assertClaudeHookCommand(hooks, "Stop", "AfterAgent");
}

async function verifyCodexPluginFiles() {
  await access(codexMarketplacePath);
  await access(codexPluginManifestPath);
  await access(codexPluginHooksPath);
  await assertExecutable(codexPluginCliPath);
  await access(codexPluginSkillPath);
  await access(codexPluginSkillPolicyPath);

  const packageJson = JSON.parse(await readFile(rootPackagePath, "utf8"));
  const marketplaceSource = await readFile(codexMarketplacePath, "utf8");
  const pluginSource = await readFile(codexPluginManifestPath, "utf8");
  const hooksSource = await readFile(codexPluginHooksPath, "utf8");
  assertNoPackageTemplatePlaceholders([
    [codexMarketplacePath, marketplaceSource],
    [codexPluginManifestPath, pluginSource],
    [codexPluginHooksPath, hooksSource],
  ]);

  const marketplace = JSON.parse(marketplaceSource);
  const plugin = JSON.parse(pluginSource);
  const hooks = JSON.parse(hooksSource);

  if (marketplace.name !== "nams-plugins") {
    throw new Error("dist/.agents/plugins/marketplace.json must name the marketplace nams-plugins.");
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
  if (marketplacePlugin.version !== packageJson.version) {
    throw new Error("Codex marketplace plugin version must match package.json.");
  }
  if (marketplacePlugin.license !== packageJson.license) {
    throw new Error("Codex marketplace plugin license must match package.json.");
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

function assertClaudeWorkspaceCommandHook(hooks) {
  const group = hooks.hooks?.UserPromptExpansion?.[0];
  const handler = group?.hooks?.[0];
  if (group?.matcher !== "^nams:workspace$") {
    throw new Error("Claude plugin UserPromptExpansion hook must match the /nams:workspace command.");
  }
  if (handler?.type !== "command" || handler.command !== "node") {
    throw new Error("Claude plugin UserPromptExpansion hook must run node.");
  }
  const expectedArgs = ["${CLAUDE_PLUGIN_ROOT}/bin/cli.js", "workspaces", "run", "claude", "--event", "UserPromptExpansion"];
  if (JSON.stringify(handler.args) !== JSON.stringify(expectedArgs)) {
    throw new Error("Claude plugin UserPromptExpansion hook must invoke the bundled CLI workspace runner with exec-form args.");
  }
}

function assertNoPackageTemplatePlaceholders(files) {
  for (const [filePath, source] of files) {
    if (/__PACKAGE_VERSION__|__PACKAGE_LICENSE__/.test(source)) {
      throw new Error(`${path.relative(root, filePath)} must not contain unresolved package template placeholders.`);
    }
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

async function checkPackedPackage(packageDir, binTarget, options = {}) {
  const packageJson = options.packageJson ?? JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  if (options.identityAlreadyVerified !== true) {
    assertPackageIdentity(packageJson, packageDir, `./${binTarget}`);
  }
  await assertExecutable(path.join(packageDir, binTarget));

  const pack = await npmPackDryRun(packageDir);
  const packedFiles = pack.files.map((file) => file.path);
  const openApiPackedFiles = packedFiles.filter((file) => /openapi|nams-openapi/i.test(file));
  if (openApiPackedFiles.length > 0) {
    throw new Error(`packed package must not include OpenAPI artifacts: ${openApiPackedFiles.join(", ")}`);
  }
  if (!packedFiles.includes(binTarget)) {
    throw new Error(`packed package is missing nams-hooks bin target: ${binTarget}`);
  }
  for (const expectedFile of [
    ...geminiPackedFiles(packageDir),
    ...claudePackedFiles(packageDir),
    ...codexPackedFiles(packageDir),
    ...opencodePackedFiles(packageDir),
  ]) {
    if (!packedFiles.includes(expectedFile)) {
      throw new Error(`packed package is missing plugin file: ${expectedFile}`);
    }
  }
}

function geminiPackedFiles(packageDir) {
  const prefix = packageDir === root ? "dist/" : "";
  return [
    `${prefix}commands/nams/workspace.toml`,
  ];
}

function claudePackedFiles(packageDir) {
  const prefix = packageDir === root ? "dist/" : "";
  return [
    `${prefix}.claude-plugin/marketplace.json`,
    `${prefix}plugins/nams-hooks/.claude-plugin/plugin.json`,
    `${prefix}plugins/nams-hooks/hooks/hooks.json`,
    `${prefix}plugins/nams-hooks/commands/nams/workspace.md`,
    `${prefix}plugins/nams-hooks/bin/cli.js`,
  ];
}

function codexPackedFiles(packageDir) {
  const prefix = packageDir === root ? "dist/" : "";
  return [
    `${prefix}.agents/plugins/marketplace.json`,
    `${prefix}plugins/codex-nams-hooks/.codex-plugin/plugin.json`,
    `${prefix}plugins/codex-nams-hooks/hooks/hooks.json`,
    `${prefix}plugins/codex-nams-hooks/bin/cli.js`,
    `${prefix}plugins/codex-nams-hooks/skills/workspace/SKILL.md`,
    `${prefix}plugins/codex-nams-hooks/skills/workspace/agents/openai.yaml`,
  ];
}

function opencodePackedFiles(packageDir) {
  if (packageDir !== root) {
    return [];
  }
  return [
    "templates/opencode/.opencode/plugins/nams-hooks.js",
  ];
}

async function assertExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK);
  } catch {
    throw new Error(`${path.relative(root, filePath)} must be executable.`);
  }
}

async function verifyRootPackageFiles(packagePath) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (!Array.isArray(packageJson.files) || !packageJson.files.includes("templates/")) {
    throw new Error("package.json files must include templates/ for the OpenCode plugin shim.");
  }
}

async function verifySourcePackageIdentity(packagePath) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  assertPackageIdentity(packageJson, path.dirname(packagePath), "./dist/bin/cli.js");
  return packageJson;
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
    throw new Error("dist/gemini-extension.json settings must include NAMS_API_KEY, NAMS_WORKSPACE_ID, and NAMS_BASE_URL.");
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
