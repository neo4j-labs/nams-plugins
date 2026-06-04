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
const claudeMarketplacePath = path.join(root, "dist", ".claude-plugin", "marketplace.json");
const claudePluginManifestPath = path.join(root, "dist", "plugins", "nams-hooks", ".claude-plugin", "plugin.json");
const claudePluginHooksPath = path.join(root, "dist", "plugins", "nams-hooks", "hooks", "hooks.json");
const claudePluginCliPath = path.join(root, "dist", "plugins", "nams-hooks", "bin", "cli.js");
const opencodeTemplatePath = path.join(root, "templates", "opencode", "plugins", "nams-hooks.js");
const rootPackagePath = path.join(root, "package.json");
const execFileAsync = promisify(execFile);

await access(generatedClientPath);
await access(geminiExtensionPath);
await access(opencodeTemplatePath);
await verifyRootPackageFiles(rootPackagePath);
await verifyGeminiExtensionSettings(geminiExtensionPath);
await verifyClaudePluginFiles();

const source = await readFile(generatedClientPath, "utf8");
if (/nams-openapi|readFile/.test(source)) {
  throw new Error("dist/bin/generated/nams-client.js must not read OpenAPI at runtime.");
}

const distFiles = await listFiles(distDir);
const openApiArtifacts = distFiles.filter((file) => /openapi|nams-openapi/i.test(file));
if (openApiArtifacts.length > 0) {
  throw new Error(`dist must not include runtime OpenAPI artifacts: ${openApiArtifacts.join(", ")}`);
}

await checkPackedPackage(root, "dist/bin/cli.js");
await checkPackedPackage(distDir, "bin/cli.js");

async function verifyClaudePluginFiles() {
  await access(claudeMarketplacePath);
  await access(claudePluginManifestPath);
  await access(claudePluginHooksPath);
  await assertExecutable(claudePluginCliPath);

  const packageJson = JSON.parse(await readFile(rootPackagePath, "utf8"));
  const marketplace = JSON.parse(await readFile(claudeMarketplacePath, "utf8"));
  const plugin = JSON.parse(await readFile(claudePluginManifestPath, "utf8"));
  const hooks = JSON.parse(await readFile(claudePluginHooksPath, "utf8"));

  if (marketplace.name !== "neo4j-nams-hooks") {
    throw new Error("dist/.claude-plugin/marketplace.json must name the marketplace neo4j-nams-hooks.");
  }
  if (marketplace.plugins?.[0]?.name !== "nams-hooks" || marketplace.plugins[0].source !== "./plugins/nams-hooks") {
    throw new Error("Claude marketplace must expose nams-hooks from ./plugins/nams-hooks.");
  }
  if (marketplace.plugins[0].version !== packageJson.version) {
    throw new Error("Claude marketplace plugin version must match package.json.");
  }
  if (plugin.name !== "nams-hooks" || plugin.version !== packageJson.version) {
    throw new Error("Claude plugin manifest must name nams-hooks and match package.json version.");
  }
  if (Object.hasOwn(plugin, "hooks")) {
    throw new Error("Claude plugin manifest must not reference standard hooks/hooks.json because Claude loads it automatically.");
  }
  assertClaudePluginUserConfig(plugin);

  assertClaudeHookCommand(hooks, "SessionStart", "SessionStart");
  assertClaudeHookCommand(hooks, "UserPromptSubmit", "BeforeAgent");
  assertClaudeHookCommand(hooks, "PostToolUse", "AfterTool");
  assertClaudeHookCommand(hooks, "Stop", "AfterAgent");
}

function assertClaudePluginUserConfig(plugin) {
  const apiKey = plugin.userConfig?.NAMS_API_KEY;
  if (apiKey?.type !== "string" || apiKey.title !== "NAMS API key" || apiKey.sensitive !== true || apiKey.required !== true) {
    throw new Error("Claude plugin manifest must require a sensitive NAMS_API_KEY userConfig value.");
  }

  const workspaceId = plugin.userConfig?.NAMS_WORKSPACE_ID;
  if (workspaceId?.type !== "string" || workspaceId.title !== "NAMS workspace ID" || workspaceId.required !== true) {
    throw new Error("Claude plugin manifest must require a NAMS_WORKSPACE_ID userConfig value.");
  }
  if (workspaceId.sensitive === true) {
    throw new Error("Claude plugin NAMS_WORKSPACE_ID must be non-sensitive.");
  }

  const baseUrl = plugin.userConfig?.NAMS_BASE_URL;
  if (baseUrl?.type !== "string" || baseUrl.title !== "NAMS base URL" || baseUrl.default !== "https://memory.neo4jlabs.com") {
    throw new Error("Claude plugin manifest must expose optional NAMS_BASE_URL with the default NAMS endpoint.");
  }
  if (baseUrl.sensitive === true || baseUrl.required === true) {
    throw new Error("Claude plugin NAMS_BASE_URL must be optional and non-sensitive.");
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

async function checkPackedPackage(packageDir, binTarget) {
  const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  if (packageJson.bin?.["nams-hooks"] !== `./${binTarget}`) {
    throw new Error(`${path.relative(root, packageDir) || "."}/package.json bin must point to ./${binTarget}.`);
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
  for (const expectedFile of claudePackedFiles(packageDir)) {
    if (!packedFiles.includes(expectedFile)) {
      throw new Error(`packed package is missing Claude plugin file: ${expectedFile}`);
    }
  }
}

function claudePackedFiles(packageDir) {
  const prefix = packageDir === root ? "dist/" : "";
  return [
    `${prefix}.claude-plugin/marketplace.json`,
    `${prefix}plugins/nams-hooks/.claude-plugin/plugin.json`,
    `${prefix}plugins/nams-hooks/hooks/hooks.json`,
    `${prefix}plugins/nams-hooks/bin/cli.js`,
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
