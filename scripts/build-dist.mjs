#!/usr/bin/env node

import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const compileDir = path.join(root, ".build", "tsc");

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  await cp(path.join(compileDir), path.join(distDir, "bin"), { recursive: true });
  await chmod(path.join(distDir, "bin", "cli.js"), 0o755);
  await cp(path.join(root, "templates", "gemini", "gemini-extension.json"), path.join(distDir, "gemini-extension.json"));
  await cp(path.join(root, "templates", "gemini", "hooks"), path.join(distDir, "hooks"), { recursive: true });
  await cp(path.join(root, "docs", "nams-openapi.json"), path.join(distDir, "docs", "nams-openapi.json"));
  await writeReleasePackageJson();
}

async function writeReleasePackageJson() {
  const source = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
