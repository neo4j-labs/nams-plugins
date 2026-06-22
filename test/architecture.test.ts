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
    "src/platforms/antigravity/index.ts",
    "src/platforms/gemini/workspaces.ts",
    "src/platforms/claude/workspaces.ts",
    "src/platforms/codex/workspaces.ts",
    "src/platforms/opencode/workspaces.ts",
    "src/platforms/antigravity/workspaces.ts",
  ]);

  return importedSourcePaths(file.path, file.content).some((importedPath) => concreteAdapters.has(importedPath));
}

test("platform adapters do not import each other", async () => {
  for (const platform of ["gemini", "claude", "codex", "opencode", "antigravity"]) {
    const otherPlatforms = ["gemini", "claude", "codex", "opencode", "antigravity"].filter(
      (candidate) => candidate !== platform,
    );
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

test("platform adapters do not accept test-only runtime dependencies", async () => {
  const content = await readFile("src/interfaces.ts", "utf8");

  assert.equal(/\bMemoryPlatformAdapterOptions\b/.test(content), false);
  assert.equal(/\bfetch\?: typeof fetch\b/.test(content), false);
  assert.equal(/\bruntimeEnvironment\?:/.test(content), false);
  assert.equal(/\benv\?:/.test(content), false);

  for (const platform of ["gemini", "claude", "codex", "opencode", "antigravity"]) {
    const filePath = `src/platforms/${platform}/index.ts`;
    const platformContent = await readFile(filePath, "utf8");

    assert.equal(/\bMemoryPlatformAdapterOptions\b/.test(platformContent), false);
    assert.equal(/\bprivate readonly options\b|\bthis\.options\b/.test(platformContent), false);
    assert.equal(/\bfetch\b/.test(platformContent), false);
  }
});

test("memory platform adapter contract is named explicitly", async () => {
  const interfaceContent = await readFile("src/interfaces.ts", "utf8");
  const registryContent = await readFile("src/platforms/index.ts", "utf8");

  assert.match(interfaceContent, /\bexport type MemoryPlatformAdapter\b/);
  assert.doesNotMatch(interfaceContent, /\bexport type PlatformAdapter\b/);
  assert.match(registryContent, /\bgetMemoryPlatformAdapter\b/);
  assert.doesNotMatch(registryContent, /\bgetPlatformAdapter\b/);
});

test("workspace adapter registry is static", async () => {
  const content = await readFile("src/platforms/index.ts", "utf8");

  assert.match(content, /\bgetWorkspacePlatformAdapter\b/);
  assert.equal(/\bimport\(|readdir|dynamic\b/.test(content), false);
});

test("workspace resolution runtime does not format platform hook output", async () => {
  const content = await readFile("src/runtime/workspace-resolution.ts", "utf8");

  assert.doesNotMatch(content, /\bdecision\b|\bhookSpecificOutput\b|\bsystemMessage\b|\bnamsWorkspaceSelectionRequired\b/);
  assert.doesNotMatch(content, /\bgemini\b|\bclaude\b|\bcodex\b|\bopencode\b|\bantigravity\b/);
});

test("workspace selection notice formatter does not branch by platform", async () => {
  const content = await readFile("src/platforms/workspace-selection.ts", "utf8");

  assert.doesNotMatch(content, /\bplatform\s*===\s*["']/);
  assert.doesNotMatch(content, /\bswitch\s*\(\s*platform\s*\)/);
});

test("platform session-start contract names local session initialization", async () => {
  const interfaceContent = await readFile("src/interfaces.ts", "utf8");
  const cliContent = await readFile("src/cli.ts", "utf8");

  assert.match(interfaceContent, /\bstartSession[:(]/);
  assert.equal(/\bstartConversation\b/.test(interfaceContent), false);
  assert.match(cliContent, /\badapter\.startSession\(/);
  assert.equal(/\badapter\.startConversation\b/.test(cliContent), false);

  for (const platform of ["gemini", "claude", "codex", "opencode", "antigravity"]) {
    const filePath = `src/platforms/${platform}/index.ts`;
    const content = await readFile(filePath, "utf8");

    assert.match(content, /\basync function startSession\(invocation: HookInvocation<"SessionStart">\): Promise<HookResult>/);
    assert.equal(/\bstartConversation\b/.test(content), false);
  }
});

test("platform adapters do not manage runtime environment", async () => {
  for (const platform of ["gemini", "claude", "codex", "opencode", "antigravity"]) {
    const filePath = `src/platforms/${platform}/index.ts`;
    const content = await readFile(filePath, "utf8");

    assert.equal(/\bRuntimeEnvironment\b|\bruntimeEnvironment\b/.test(content), false, `${filePath} should not manage runtime environment`);
  }
});

test("global runtime modules do not accept unused project directory plumbing", async () => {
  const sessionState = await readFile("src/runtime/session-state.ts", "utf8");
  const logging = await readFile("src/runtime/logging.ts", "utf8");

  assert.equal(/loadSessionState\(\s*\n\s*projectDirectory:/.test(sessionState), false);
  assert.equal(/saveSessionState\(\s*\n\s*projectDirectory:/.test(sessionState), false);
  assert.equal(/\bvoid projectDirectory\b/.test(sessionState), false);
  assert.equal(/\bprojectDirectory: string;/.test(logging), false);
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
  for (const platform of ["gemini", "codex", "opencode", "antigravity"]) {
    const filePath = `src/platforms/${platform}/index.ts`;
    const content = await readFile(filePath, "utf8");

    assert.equal(
      /async function append(?:NamsConfigDiagnostic|NamsFailureDiagnostic|NamsRequestLog|RawPlatformLog|[A-Z][A-Za-z]+DiagnosticLog)\b/.test(
        content,
      ),
      false,
      `${filePath} should reuse shared runtime logging helpers`,
    );
    assert.equal(/sanitizeNamsRequestLogPayload|isSensitiveLogKey|redactSecretValue/.test(content), false);
  }
});
