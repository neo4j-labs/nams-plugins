#!/usr/bin/env node

import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const compileDir = path.join(root, ".build", "tsc");
const claudePluginDir = path.join(distDir, "plugins", "nams-hooks");
const codexPluginDir = path.join(distDir, "plugins", "codex-nams-hooks");

async function main() {
  const source = await readRootPackageJson();

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  await cp(path.join(compileDir), path.join(distDir, "bin"), { recursive: true });
  await chmod(path.join(distDir, "bin", "cli.js"), 0o755);
  await cp(path.join(root, "templates", "gemini", "gemini-extension.json"), path.join(distDir, "gemini-extension.json"));
  await cp(path.join(root, "templates", "gemini", "hooks"), path.join(distDir, "hooks"), { recursive: true });
  await cp(path.join(root, "templates", "gemini", "commands"), path.join(distDir, "commands"), { recursive: true });
  await writeClaudeTemplates(source);
  await writeCodexTemplates(source);
  await writeReleasePackageJson(source);
}

async function writeClaudeTemplates(source) {
  await renderTemplateTree(
    path.join(root, "templates", "claude", ".claude-plugin"),
    path.join(distDir, ".claude-plugin"),
    packageTemplateReplacements(source),
  );
  await renderTemplateTree(
    path.join(root, "templates", "claude", "plugins"),
    path.join(distDir, "plugins"),
    packageTemplateReplacements(source),
  );
  await cp(path.join(compileDir), path.join(claudePluginDir, "bin"), { recursive: true });
  await chmod(path.join(claudePluginDir, "bin", "cli.js"), 0o755);
}

async function writeCodexTemplates(source) {
  await renderTemplateTree(
    path.join(root, "templates", "codex", ".agents"),
    path.join(distDir, ".agents"),
    packageTemplateReplacements(source),
  );
  await renderTemplateTree(
    path.join(root, "templates", "codex", "plugins"),
    path.join(distDir, "plugins"),
    packageTemplateReplacements(source),
  );
  await cp(path.join(compileDir), path.join(codexPluginDir, "bin"), { recursive: true });
  await chmod(path.join(codexPluginDir, "bin", "cli.js"), 0o755);
}

async function writeReleasePackageJson(source) {
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
  await writeFile(path.join(distDir, "package.json"), `${JSON.stringify(releasePackage, null, 2)}\n`);
}

async function renderTemplateTree(sourceDir, targetDir, replacements) {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await renderTemplateTree(sourcePath, targetPath, replacements);
    } else if (entry.isFile()) {
      const rendered = renderTemplate(await readFile(sourcePath, "utf8"), replacements);
      await writeFile(targetPath, rendered);
    }
  }
}

function renderTemplate(content, replacements) {
  let rendered = content;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.split(placeholder).join(value);
  }
  return rendered;
}

function packageTemplateReplacements(source) {
  return {
    __PACKAGE_VERSION__: source.version,
    __PACKAGE_LICENSE__: source.license,
  };
}

async function readRootPackageJson() {
  return JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
