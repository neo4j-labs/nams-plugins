import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const compileDir = path.join(root, ".build", "tsc");

export async function resetOutputRoot(outputRoot) {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
}

export async function readRootPackageJson() {
  return JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
}

export function packageTemplateReplacements(source) {
  return {
    __PACKAGE_VERSION__: source.version,
    __PACKAGE_LICENSE__: source.license,
  };
}

export async function copyRuntime(targetDir) {
  await cp(compileDir, targetDir, { recursive: true });
  await chmod(path.join(targetDir, "cli.js"), 0o755);
}

export async function writeReleasePackageJson(source, targetPath) {
  const releasePackage = {
    name: source.name,
    version: source.version,
    description: source.description,
    type: source.type,
    bin: {
      "nams-hooks": "./bin/cli.js",
    },
    engines: source.engines,
    license: source.license,
  };
  await writeFileWithParents(targetPath, `${JSON.stringify(releasePackage, null, 2)}\n`);
}

export async function buildProjectionTarget(outputRoot, projections) {
  const source = await readRootPackageJson();
  const replacements = packageTemplateReplacements(source);
  await resetOutputRoot(outputRoot);
  for (const projection of projections) {
    await applyProjection(outputRoot, projection, source, replacements);
  }
}

async function applyProjection(outputRoot, projection, source, replacements) {
  if (projection.kind === "runtime") {
    await copyRuntime(path.join(outputRoot, projection.to));
    return;
  }
  if (projection.kind === "packageJson") {
    await writeReleasePackageJson(source, path.join(outputRoot, projection.to));
    return;
  }
  if (projection.kind === "template") {
    const templateReplacements = projection.renderPackage === true ? replacements : {};
    await renderTemplatePath(path.join(root, projection.from), path.join(outputRoot, projection.to), templateReplacements);
    return;
  }
  if (projection.kind === "opencode") {
    await renderOpenCodeProjection(outputRoot, projection);
    return;
  }
  throw new Error(`Unsupported projection kind ${projection.kind}`);
}

export async function renderTemplatePath(sourcePath, targetPath, replacements) {
  const entries = await readdir(sourcePath, { withFileTypes: true }).catch(async (error) => {
    if (error?.code === "ENOTDIR") {
      const rendered = renderTemplate(await readFile(sourcePath, "utf8"), replacements);
      await writeFileWithParents(targetPath, rendered);
      return undefined;
    }
    throw error;
  });
  if (entries === undefined) {
    return;
  }
  await mkdir(targetPath, { recursive: true });
  for (const entry of entries) {
    const childSource = path.join(sourcePath, entry.name);
    const childTarget = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      await renderTemplatePath(childSource, childTarget, replacements);
    } else if (entry.isFile()) {
      const rendered = renderTemplate(await readFile(childSource, "utf8"), replacements);
      await writeFileWithParents(childTarget, rendered);
    }
  }
}

export function renderTemplate(content, replacements) {
  let rendered = content;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.split(placeholder).join(value);
  }
  return rendered;
}

export async function renderOpenCodeProjection(outputRoot, projection) {
  const marker = await readFile(path.join(root, projection.from), "utf8");
  const markerPath = marker.trim();
  if (markerPath !== "../../../../opencode/.opencode/plugins/nams-hooks.js") {
    throw new Error(`${projection.from} must point at the shared OpenCode template.`);
  }
  const commandExpression = projection.commandMode === "bundled"
    ? 'new URL("./bin/cli.js", import.meta.url).pathname'
    : JSON.stringify("nams-hooks");
  const source = await readFile(path.join(root, "templates", "opencode", ".opencode", "plugins", "nams-hooks.js"), "utf8");
  const rendered = renderTemplate(source, { __NAMS_HOOKS_COMMAND__: commandExpression });
  await writeFileWithParents(path.join(outputRoot, projection.to), rendered);
}

export async function writeFileWithParents(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}
