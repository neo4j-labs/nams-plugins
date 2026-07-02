import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { projectFiles } from "archunit";

interface ArchRule {
  check(): Promise<unknown[]>;
}

interface SourceFile {
  path: string;
  content: string;
}

async function readProjectFiles(folders: string[]): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const folder of folders) {
    await walk(folder);
  }
  return files;

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!/\.(?:ts|js|mjs|json)$/.test(entry.name)) {
        continue;
      }
      files.push({
        path: entryPath,
        content: await readFile(entryPath, "utf8"),
      });
    }
  }
}

async function assertNoViolations(rule: ArchRule): Promise<void> {
  const violations = await rule.check();
  assert.deepEqual(violations, []);
}

async function assertNoGeneratedImportsFrom(folder: string): Promise<void> {
  const generatedClient = await readFile("src/generated/nams-client.ts", "utf8");
  const importPattern = new RegExp(
    String.raw`(?:import|export)\s+(?:[^"'();]+?\s+from\s+)?["'][^"']*${folder}/|import\s*\(\s*["'][^"']*${folder}/`,
  );

  assert.equal(importPattern.test(generatedClient), false);
}

function importedSourcePaths(filePath: string, content: string): string[] {
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

function importsConcreteAdapter(file: SourceFile): boolean {
  const concreteAdapters = new Set([
    "src/platforms/gemini/index.ts",
    "src/platforms/claude/index.ts",
    "src/platforms/codex/index.ts",
    "src/platforms/opencode/index.ts",
    "src/platforms/gemini/workspaces.ts",
    "src/platforms/claude/workspaces.ts",
    "src/platforms/codex/workspaces.ts",
    "src/platforms/opencode/workspaces.ts",
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

test("runtime and generated-client source do not hardcode production NAMS service URL", async () => {
  const forbiddenHost = ["memory", "neo4jlabs", "com"].join(".");
  const files = [
    ...(await readProjectFiles(["src"])),
    {
      path: "scripts/generate-nams-client.mjs",
      content: await readFile("scripts/generate-nams-client.mjs", "utf8"),
    },
  ];
  const violations = files
    .filter((file) => file.content.includes(forbiddenHost))
    .map((file) => file.path);

  assert.deepEqual(violations, []);
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

test("platform adapters do not call fetch directly", async () => {
  for (const platform of ["gemini", "claude", "codex", "opencode"]) {
    const filePath = `src/platforms/${platform}/index.ts`;
    const platformContent = await readFile(filePath, "utf8");

    assert.equal(
      /\bfetch\b/.test(platformContent),
      false,
      `${filePath} must route NAMS traffic through runtime/memory-service.ts`,
    );
  }
});

test("workspace adapter registry is static", async () => {
  const content = await readFile("src/platforms/index.ts", "utf8");
  const platforms = ["gemini", "claude", "codex", "opencode"] as const;
  const importedWorkspaceAdapterNames = new Map<string, Set<string>>();

  assert.equal(/\bimport\s*\(|\breaddir(?:Sync)?\b|\bdynamic\b/.test(content), false);

  for (const platform of platforms) {
    const importMatch = content.match(
      new RegExp(String.raw`import\s+\{([^}]+)\}\s+from\s+["']\./${platform}/workspaces\.js["'];`),
    );

    assert.ok(importMatch, `src/platforms/index.ts must statically import ${platform} workspace adapter`);

    const importedNames = importMatch[1]
      .split(",")
      .map((specifier) => specifier.trim().match(/(?:\bas\s+)?([A-Za-z_$][\w$]*)$/)?.[1])
      .filter((name): name is string => name !== undefined);

    assert.notEqual(importedNames.length, 0, `${platform} workspace import must expose an adapter binding`);
    importedWorkspaceAdapterNames.set(platform, new Set(importedNames));
  }

  const registryMatch = content.match(
    /\bconst\s+[A-Za-z_$][\w$]*\s*:\s*Record<\s*Platform\s*,\s*WorkspacePlatformAdapter\s*>\s*=\s*\{([\s\S]*?)\n\};/,
  );
  assert.ok(registryMatch, "src/platforms/index.ts must declare a static workspace adapter registry");

  const registryEntryMatches = [
    ...registryMatch[1].matchAll(/\b(gemini|claude|codex|opencode)\s*:\s*([A-Za-z_$][\w$]*)\s*,?/g),
  ];
  assert.equal(registryEntryMatches.length, platforms.length);

  const registryEntries = new Map(
    registryEntryMatches.map((match) => [match[1], match[2]]),
  );

  assert.deepEqual([...registryEntries.keys()].sort(), [...platforms].sort());

  for (const platform of platforms) {
    const adapterName = registryEntries.get(platform);

    assert.ok(adapterName, `workspace adapter registry must include ${platform}`);
    assert.equal(
      importedWorkspaceAdapterNames.get(platform)?.has(adapterName),
      true,
      `workspace adapter registry must map ${platform} to its statically imported workspace adapter`,
    );
  }
});

test("workspace resolution runtime does not format platform hook output", async () => {
  const content = await readFile("src/runtime/workspace-resolution.ts", "utf8");

  assert.doesNotMatch(content, /\bdecision\b|\bhookSpecificOutput\b|\bsystemMessage\b|\bnamsWorkspaceSelectionRequired\b/);
  assert.doesNotMatch(content, /\bgemini\b|\bclaude\b|\bcodex\b|\bopencode\b/);
});

test("workspace selection notice formatter does not branch by platform", async () => {
  const content = await readFile("src/platforms/workspace-selection.ts", "utf8");

  assert.doesNotMatch(content, /\bplatform\s*===\s*["']/);
  assert.doesNotMatch(content, /\bswitch\s*\(\s*platform\s*\)/);
});

test("runtime environment home lookup stays in paths module", async () => {
  const config = await readFile("src/runtime/config.ts", "utf8");
  const sessionState = await readFile("src/runtime/session-state.ts", "utf8");
  const logging = await readFile("src/runtime/logging.ts", "utf8");

  for (const [filePath, content] of Object.entries({
    "src/runtime/config.ts": config,
    "src/runtime/session-state.ts": sessionState,
    "src/runtime/logging.ts": logging,
  })) {
    assert.equal(/\bHOME\b|\bUSERPROFILE\b/.test(content), false, `${filePath} should not resolve home directories`);
  }
});

test("platform adapters use shared logging wrappers", async () => {
  for (const platform of ["gemini", "claude", "codex", "opencode"]) {
    const filePath = `src/platforms/${platform}/index.ts`;
    const content = await readFile(filePath, "utf8");

    assert.equal(
      /async function append(?:NamsConfigDiagnostic|NamsFailureDiagnostic|NamsRequestLog|RawPlatformLog|[A-Z][A-Za-z]+DiagnosticLog)\b/.test(
        content,
      ),
      false,
      `${filePath} should reuse shared runtime logging helpers`,
    );
  }
});
