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
const opencodeTemplatePath = path.join(root, "templates", "opencode", "plugins", "nams-hooks.js");
const rootPackagePath = path.join(root, "package.json");
const execFileAsync = promisify(execFile);

await access(generatedClientPath);
await access(geminiExtensionPath);
await access(opencodeTemplatePath);
await verifyRootPackageFiles(rootPackagePath);
await verifyGeminiExtensionSettings(geminiExtensionPath);

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
