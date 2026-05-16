import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { projectFiles } from "archunit";

async function assertNoViolations(rule) {
  const violations = await rule.check();
  assert.deepEqual(violations, []);
}

async function assertNoGeneratedImportsFrom(folder) {
  const generatedClient = await readFile("src/generated/nams-client.ts", "utf8");
  const importPattern = new RegExp(
    String.raw`(?:import|export)\s+(?:[^"'();]+?\s+from\s+)?["'][^"']*${folder}/|import\s*\(\s*["'][^"']*${folder}/`,
  );

  assert.equal(importPattern.test(generatedClient), false);
}

function importedSourcePaths(filePath, content) {
  const importPattern =
    /(?:import|export)\s+(?:[^"'();]+?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g;

  return [...content.matchAll(importPattern)]
    .map((match) => match[1] ?? match[2])
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier));
      return resolved.replace(/\.(?:mjs|js)$/, ".ts");
    });
}

function importsConcreteAdapter(file) {
  const concreteAdapters = new Set([
    "src/platforms/gemini/index.ts",
    "src/platforms/claude/index.ts",
    "src/platforms/codex/index.ts",
    "src/platforms/opencode/index.ts",
  ]);

  return importedSourcePaths(file.path, file.content).some((importedPath) => concreteAdapters.has(importedPath));
}

test("platform adapters do not import each other", async () => {
  for (const platform of ["gemini", "claude", "codex", "opencode"]) {
    const otherPlatforms = ["gemini", "claude", "codex", "opencode"].filter((candidate) => candidate !== platform);
    for (const otherPlatform of otherPlatforms) {
      await assertNoViolations(
        projectFiles()
          .inFolder(`src/platforms/${platform}/**`)
          .shouldNot()
          .dependOnFiles()
          .inFolder(`src/platforms/${otherPlatform}/**`),
      );
    }
  }
});

test("runtime modules do not import gateway or platform modules", async () => {
  await assertNoViolations(
    projectFiles().inFolder("src/runtime/**").shouldNot().dependOnFiles().inFolder("src/platforms/**"),
  );
  await assertNoViolations(
    projectFiles().inFolder("src/runtime/**").shouldNot().dependOnFiles().inPath("src/cli.ts"),
  );
});

test("generated client does not import project runtime modules", async () => {
  for (const forbiddenFolder of ["src/runtime/**", "src/platforms/**", "src/cli.ts"]) {
    await assertNoViolations(
      projectFiles()
        .inFolder("src/generated/**")
        .shouldNot()
        .dependOnFiles()
        [forbiddenFolder.endsWith(".ts") ? "inPath" : "inFolder"](forbiddenFolder),
    );
  }

  await assertNoGeneratedImportsFrom("docs");
  await assertNoGeneratedImportsFrom("scripts");
});

test("only the platform registry imports all concrete adapters", async () => {
  await assertNoViolations(
    projectFiles()
      .inFolder("src/**")
      .should()
      .adhereTo(
        (file) => file.path === "src/platforms/index.ts" || !importsConcreteAdapter(file),
        "Only src/platforms/index.ts may import concrete platform adapters",
      ),
  );
});

test("platform adapters use shared adapter options", async () => {
  const adapterClassNames = {
    gemini: "Gemini",
    claude: "Claude",
    codex: "Codex",
    opencode: "OpenCode",
  };

  for (const [platform, className] of Object.entries(adapterClassNames)) {
    const filePath = `src/platforms/${platform}/index.ts`;
    const content = await readFile(filePath, "utf8");

    assert.equal(
      new RegExp(`interface\\s+${className}AdapterOptions\\b`).test(content),
      false,
      `${filePath} should use PlatformAdapterOptions instead of declaring ${className}AdapterOptions`,
    );
    assert.match(content, /\bPlatformAdapterOptions\b/, `${filePath} should reference PlatformAdapterOptions`);
  }
});
