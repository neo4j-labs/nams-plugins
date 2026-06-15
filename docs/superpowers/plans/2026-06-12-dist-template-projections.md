# Dist Template Projections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split generated artifacts into npm, marketplace, and local distribution trees driven by a tested template projection manifest.

**Architecture:** Keep hook runtime and platform adapters unchanged. Move source templates into shared, local, and marketplace template roots, then make target-specific build scripts project those templates into `dist/`, `dist-marketplace/`, and `dist-local/` from explicit manifests. Put shared filesystem/rendering helpers in one build utility module, while each target script owns exactly one output tree. Make `scripts/check-dist.mjs` independently verify output presence, absence, command-mode, executable bits, package contents, and placeholder rendering.

**Tech Stack:** TypeScript source compiled by `tsc`, Node.js ESM scripts using built-ins only, Node's `node:test` runner through `tsx`, JSON/JavaScript hook templates, npm dry-run package verification.

---

## File Structure

- `package.json`: add `dist:npm`, `dist:marketplace`, and `dist:local`; keep `dist` as the umbrella; keep root npm package focused on `dist/`.
- `.gitignore`: ignore `dist-marketplace/` and `dist-local/`.
- `templates/`: move existing templates into shared, local, and marketplace roots.
- `test/claude-template.test.ts`: update source template paths, Claude marketplace source path expectations, and slash workspace command paths.
- `test/codex-template.test.ts`: update source template paths for local hooks, marketplace Codex templates, and marketplace workspace skill files.
- `test/gemini-template.test.ts`: update Gemini marketplace and local template paths, including workspace command TOML expectations.
- `test/opencode-template.test.ts`: assert the shared OpenCode `.opencode` plugin template supports both installed and bundled command modes.
- `test/opencode/opencode-template.test.ts`: render the shared OpenCode template in a temp file before importing it.
- `test/package-metadata.test.ts`: assert new package scripts and package file inclusion rules.
- `scripts/build-dist-common.mjs`: shared projection helpers for package metadata, runtime copying, template rendering, and OpenCode command rendering.
- `scripts/build-dist-npm.mjs`: build only the npm package tree in `dist/`.
- `scripts/build-dist-marketplace.mjs`: build only the self-contained marketplace tree in `dist-marketplace/`.
- `scripts/build-dist-local.mjs`: build only local project configurations in `dist-local/`.
- `scripts/build-dist.mjs`: delete after the target scripts are wired.
- `scripts/check-dist.mjs`: verify all three generated trees, including workspace-selection command and skill assets.
- `README.md`, `INSTALL.md`, `DEVELOPMENT.md`, and `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`: document the three output trees and updated local/marketplace install paths.

---

### Task 1: Lock Package Script And Ignore Contracts

**Files:**
- Modify: `test/package-metadata.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Extend package metadata tests first**

Edit `test/package-metadata.test.ts` so it contains these tests:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("package metadata uses nams-plugins package and nams-hooks executable", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.name, "@neo4j-labs/nams-plugins");
  assert.deepEqual(packageJson.bin, {
    "nams-hooks": "./dist/bin/cli.js",
  });
});

test("package files include npm dist and docs without source templates", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.deepEqual(packageJson.files, [
    "dist/",
    "README.md",
    "INSTALL.md",
    "DEVELOPMENT.md",
  ]);
});

test("package scripts expose split dist targets and umbrella dist", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.scripts["dist:npm"], "npm run build && node scripts/build-dist-npm.mjs");
  assert.equal(packageJson.scripts["dist:marketplace"], "npm run build && node scripts/build-dist-marketplace.mjs");
  assert.equal(packageJson.scripts["dist:local"], "npm run build && node scripts/build-dist-local.mjs");
  assert.equal(packageJson.scripts.dist, "npm run dist:npm && npm run dist:local && npm run dist:marketplace");
  assert.equal(packageJson.scripts["dist:check"], "node scripts/check-dist.mjs");
  assert.equal(packageJson.scripts["package:check"], "npm run check && npm run dist && npm run dist:check");
});

test("package lock root package matches package metadata", async () => {
  const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));

  assert.equal(packageLock.name, "@neo4j-labs/nams-plugins");
  assert.equal(packageLock.packages[""].name, "@neo4j-labs/nams-plugins");
  assert.deepEqual(packageLock.packages[""].bin, {
    "nams-hooks": "dist/bin/cli.js",
  });
});
```

- [ ] **Step 2: Run the focused package metadata test and verify it fails**

Run:

```bash
node --import=tsx --test test/package-metadata.test.ts
```

Expected: FAIL because `package.json.files` still includes `templates/`, and the split dist scripts are not present.

- [ ] **Step 3: Update `package.json` scripts and files**

Edit `package.json` so `files` and `scripts` use this exact shape:

```json
  "files": [
    "dist/",
    "README.md",
    "INSTALL.md",
    "DEVELOPMENT.md"
  ],
  "scripts": {
    "openapi:generate": "node scripts/generate-nams-client.mjs",
    "build": "rm -rf .build/tsc && tsc -p tsconfig.json --outDir .build/tsc",
    "test:typecheck": "tsc -p tsconfig.test.json",
    "test": "npm run build && node --import=tsx --test test/*.test.ts test/**/*.test.ts",
    "check": "npm run openapi:generate && npm run build && npm run test:typecheck && npm test",
    "dist:npm": "npm run build && node scripts/build-dist-npm.mjs",
    "dist:marketplace": "npm run build && node scripts/build-dist-marketplace.mjs",
    "dist:local": "npm run build && node scripts/build-dist-local.mjs",
    "dist": "npm run dist:npm && npm run dist:local && npm run dist:marketplace",
    "dist:check": "node scripts/check-dist.mjs",
    "package:check": "npm run check && npm run dist && npm run dist:check"
  },
```

Keep the surrounding package fields unchanged.

- [ ] **Step 4: Ignore the new generated output trees**

Edit `.gitignore` so it contains:

```gitignore
node_modules/
.nams/
.build/
*.log
*.tsbuildinfo
dist/
dist-marketplace/
dist-local/
.worktrees/
```

- [ ] **Step 5: Run the focused package metadata test and verify it passes**

Run:

```bash
node --import=tsx --test test/package-metadata.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit package contract changes**

Run:

```bash
git add package.json .gitignore test/package-metadata.test.ts
git commit -m "test: lock split dist package contract" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Move Templates Into Canonical Source Layout

**Files:**
- Move: `templates/claude/.claude/settings.local.json` to `templates/local/claude/.claude/settings.local.json`
- Move: `templates/claude/.claude/commands/nams/workspace.md` to `templates/local/claude/.claude/commands/nams/workspace.md`
- Move: `templates/codex/hooks.json` to `templates/local/codex/.codex/hooks.json`
- Move: `templates/claude/.claude-plugin/marketplace.json` to `templates/marketplace/claude/.claude-plugin/marketplace.json`
- Move: `templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json` to `templates/marketplace/claude/plugins/claude-nams-hooks/.claude-plugin/plugin.json`
- Move: `templates/claude/plugins/nams-hooks/hooks/hooks.json` to `templates/marketplace/claude/plugins/claude-nams-hooks/hooks/hooks.json`
- Move: `templates/claude/plugins/nams-hooks/commands/nams/workspace.md` to `templates/marketplace/claude/plugins/claude-nams-hooks/commands/nams/workspace.md`
- Move: `templates/codex/.agents/plugins/marketplace.json` to `templates/marketplace/codex/.agents/plugins/marketplace.json`
- Move: `templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json` to `templates/marketplace/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json`
- Move: `templates/codex/plugins/codex-nams-hooks/hooks/hooks.json` to `templates/marketplace/codex/plugins/codex-nams-hooks/hooks/hooks.json`
- Move: `templates/codex/plugins/codex-nams-hooks/skills/workspace` to `templates/marketplace/codex/plugins/codex-nams-hooks/skills/workspace`
- Move: `templates/gemini/gemini-extension.json` to `templates/marketplace/gemini/gemini-extension.json`
- Move: `templates/gemini/hooks/hooks.json` to `templates/marketplace/gemini/hooks/hooks.json`
- Move: `templates/gemini/commands/nams/workspace.toml` to `templates/marketplace/gemini/commands/nams/workspace.toml`
- Keep: `templates/opencode/.opencode/plugins/nams-hooks.js` as the shared OpenCode plugin template
- Create: `templates/local/gemini/.gemini/extensions/gemini-nams-hooks/gemini-extension.json`
- Create: `templates/local/gemini/.gemini/extensions/gemini-nams-hooks/hooks/hooks.json`
- Create: `templates/local/gemini/.gemini/extensions/gemini-nams-hooks/commands/nams/workspace.toml`
- Create: `templates/local/opencode/.opencode/plugins/nams-hooks.js`
- Create: `templates/marketplace/opencode/plugins/opencode-nams-hooks/nams-hooks.js`
- Modify: `templates/marketplace/claude/.claude-plugin/marketplace.json`
- Modify: `templates/marketplace/gemini/hooks/hooks.json`
- Modify: `templates/marketplace/gemini/commands/nams/workspace.toml`
- Modify: `templates/opencode/.opencode/plugins/nams-hooks.js`
- Modify: `test/claude-template.test.ts`
- Modify: `test/codex-template.test.ts`
- Modify: `test/gemini-template.test.ts`
- Modify: `test/opencode-template.test.ts`
- Modify: `test/opencode/opencode-template.test.ts`

- [ ] **Step 1: Move existing templates with `git mv`**

Run these commands:

```bash
mkdir -p templates/local/claude/.claude
mkdir -p templates/local/claude/.claude/commands/nams
mkdir -p templates/local/codex/.codex
mkdir -p templates/marketplace/claude/.claude-plugin
mkdir -p templates/marketplace/claude/plugins/claude-nams-hooks/.claude-plugin
mkdir -p templates/marketplace/claude/plugins/claude-nams-hooks/hooks
mkdir -p templates/marketplace/claude/plugins/claude-nams-hooks/commands/nams
mkdir -p templates/marketplace/codex/.agents/plugins
mkdir -p templates/marketplace/codex/plugins/codex-nams-hooks/.codex-plugin
mkdir -p templates/marketplace/codex/plugins/codex-nams-hooks/hooks
mkdir -p templates/marketplace/codex/plugins/codex-nams-hooks/skills
mkdir -p templates/marketplace/gemini/hooks
mkdir -p templates/marketplace/gemini/commands/nams
git mv templates/claude/.claude/settings.local.json templates/local/claude/.claude/settings.local.json
git mv templates/claude/.claude/commands/nams/workspace.md templates/local/claude/.claude/commands/nams/workspace.md
git mv templates/codex/hooks.json templates/local/codex/.codex/hooks.json
git mv templates/claude/.claude-plugin/marketplace.json templates/marketplace/claude/.claude-plugin/marketplace.json
git mv templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json templates/marketplace/claude/plugins/claude-nams-hooks/.claude-plugin/plugin.json
git mv templates/claude/plugins/nams-hooks/hooks/hooks.json templates/marketplace/claude/plugins/claude-nams-hooks/hooks/hooks.json
git mv templates/claude/plugins/nams-hooks/commands/nams/workspace.md templates/marketplace/claude/plugins/claude-nams-hooks/commands/nams/workspace.md
git mv templates/codex/.agents/plugins/marketplace.json templates/marketplace/codex/.agents/plugins/marketplace.json
git mv templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json templates/marketplace/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json
git mv templates/codex/plugins/codex-nams-hooks/hooks/hooks.json templates/marketplace/codex/plugins/codex-nams-hooks/hooks/hooks.json
git mv templates/codex/plugins/codex-nams-hooks/skills/workspace templates/marketplace/codex/plugins/codex-nams-hooks/skills/workspace
git mv templates/gemini/gemini-extension.json templates/marketplace/gemini/gemini-extension.json
git mv templates/gemini/hooks/hooks.json templates/marketplace/gemini/hooks/hooks.json
git mv templates/gemini/commands/nams/workspace.toml templates/marketplace/gemini/commands/nams/workspace.toml
```

- [ ] **Step 2: Update Claude marketplace source path**

In `templates/marketplace/claude/.claude-plugin/marketplace.json`, replace the plugin `source` value:

```json
"source": "./plugins/claude-nams-hooks"
```

- [ ] **Step 3: Update Gemini marketplace hook commands to use explicit bundled folder**

In `templates/marketplace/gemini/hooks/hooks.json`, replace each command so it points at `plugins/gemini-nams-hooks/bin/cli.js`. The four command strings must be:

```json
"command": "node \"${extensionPath}/plugins/gemini-nams-hooks/bin/cli.js\" run gemini --event SessionStart"
```

```json
"command": "node \"${extensionPath}/plugins/gemini-nams-hooks/bin/cli.js\" run gemini --event BeforeAgent"
```

```json
"command": "node \"${extensionPath}/plugins/gemini-nams-hooks/bin/cli.js\" run gemini --event AfterAgent"
```

```json
"command": "node \"${extensionPath}/plugins/gemini-nams-hooks/bin/cli.js\" run gemini --event AfterTool"
```

In `templates/marketplace/gemini/commands/nams/workspace.toml`, replace the final pipe target so the prompt invokes the bundled Gemini runtime:

```toml
prompt = """
!{node -e 'const raw = process.argv[1] ?? ""; const selector = raw.replace(/^use(?:\\s+|$)/i, "").trim(); process.stdout.write(JSON.stringify({ command_name: "nams:workspace", command_args: `use ${selector}`.trim() }) + "\\n");' {{args}} | node "${extensionPath}/plugins/gemini-nams-hooks/bin/cli.js" workspaces run gemini --event CustomCommand}
"""
```

- [ ] **Step 4: Create local Gemini project extension templates**

Create `templates/local/gemini/.gemini/extensions/gemini-nams-hooks/gemini-extension.json` with this content:

```json
{
  "name": "nams-hooks",
  "version": "0.1.0",
  "description": "Neo4j Agent Memory Service hooks for Gemini CLI using an installed nams-hooks executable."
}
```

Create `templates/local/gemini/.gemini/extensions/gemini-nams-hooks/hooks/hooks.json` with this content:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "name": "nams-session-start",
            "description": "Route Gemini CLI session-start payload to the installed NAMS hook runtime.",
            "command": "nams-hooks run gemini --event SessionStart"
          }
        ]
      }
    ],
    "BeforeAgent": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "name": "nams-memory-before-agent",
            "description": "Route Gemini CLI before-agent payload to the installed NAMS hook runtime.",
            "command": "nams-hooks run gemini --event BeforeAgent"
          }
        ]
      }
    ],
    "AfterAgent": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "name": "nams-after-agent",
            "description": "Route Gemini CLI after-agent payload to the installed NAMS hook runtime.",
            "command": "nams-hooks run gemini --event AfterAgent"
          }
        ]
      }
    ],
    "AfterTool": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "name": "nams-after-tool",
            "description": "Route Gemini CLI after-tool payload to the installed NAMS hook runtime.",
            "command": "nams-hooks run gemini --event AfterTool"
          }
        ]
      }
    ]
  }
}
```

Create `templates/local/gemini/.gemini/extensions/gemini-nams-hooks/commands/nams/workspace.toml` with this content:

```toml
description = "Select the NAMS workspace for this Gemini session."

prompt = """
!{node -e 'const raw = process.argv[1] ?? ""; const selector = raw.replace(/^use(?:\\s+|$)/i, "").trim(); process.stdout.write(JSON.stringify({ command_name: "nams:workspace", command_args: `use ${selector}`.trim() }) + "\\n");' {{args}} | nams-hooks workspaces run gemini --event CustomCommand}
"""
```

- [ ] **Step 5: Make the shared OpenCode template command-mode renderable**

Edit `templates/opencode/.opencode/plugins/nams-hooks.js`. Replace:

```js
const command = process.env.NAMS_HOOKS_COMMAND ?? "nams-hooks";
```

with:

```js
const command = process.env.NAMS_HOOKS_COMMAND ?? __NAMS_HOOKS_COMMAND__;
```

Create `templates/local/opencode/.opencode/plugins/nams-hooks.js` with this one-line projection marker:

```js
../../../../opencode/.opencode/plugins/nams-hooks.js
```

Create `templates/marketplace/opencode/plugins/opencode-nams-hooks/nams-hooks.js` with this one-line projection marker:

```js
../../../../opencode/.opencode/plugins/nams-hooks.js
```

These marker files are not copied literally. Task 4 teaches the build script to detect a single-line `.js` file ending in `opencode/.opencode/plugins/nams-hooks.js` and render the shared OpenCode template with the target-specific `__NAMS_HOOKS_COMMAND__` replacement.

- [ ] **Step 6: Update Claude template tests**

In `test/claude-template.test.ts`, use these paths:

```ts
const localSettingsPath = "templates/local/claude/.claude/settings.local.json";
const claudeCommandPath = "templates/marketplace/claude/plugins/claude-nams-hooks/commands/nams/workspace.md";
const claudeBaselineCommandPath = "templates/local/claude/.claude/commands/nams/workspace.md";
const marketplacePath = "templates/marketplace/claude/.claude-plugin/marketplace.json";
const pluginManifestPath = "templates/marketplace/claude/plugins/claude-nams-hooks/.claude-plugin/plugin.json";
const pluginHooksPath = "templates/marketplace/claude/plugins/claude-nams-hooks/hooks/hooks.json";
```

Update the tests to read from those constants. Change the marketplace source assertion to:

```ts
assert.equal(template.plugins[0].source, "./plugins/claude-nams-hooks");
```

Keep the existing workspace command assertions, but make them read `claudeCommandPath` for the marketplace command and `claudeBaselineCommandPath` for the local command. The local hook assertion must stay:

```ts
assert.equal(commandFor(template, "UserPromptExpansion"), "nams-hooks workspaces run claude --event UserPromptExpansion");
```

The marketplace hook assertion must stay:

```ts
assert.deepEqual(pluginCommandFor(template, "UserPromptExpansion"), [
  "node",
  "${CLAUDE_PLUGIN_ROOT}/bin/cli.js",
  "workspaces",
  "run",
  "claude",
  "--event",
  "UserPromptExpansion",
]);
```

- [ ] **Step 7: Update Codex template tests**

In `test/codex-template.test.ts`, use these paths:

```ts
const marketplacePath = "templates/marketplace/codex/.agents/plugins/marketplace.json";
const pluginManifestPath = "templates/marketplace/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json";
const pluginHooksPath = "templates/marketplace/codex/plugins/codex-nams-hooks/hooks/hooks.json";
const pluginSkillPath = "templates/marketplace/codex/plugins/codex-nams-hooks/skills/workspace/SKILL.md";
const pluginSkillPolicyPath = "templates/marketplace/codex/plugins/codex-nams-hooks/skills/workspace/agents/openai.yaml";
const fallbackHooksPath = "templates/local/codex/.codex/hooks.json";
```

Keep the existing assertions for Codex hook and workspace skill command shapes.

- [ ] **Step 8: Update Gemini template tests**

In `test/gemini-template.test.ts`, keep the existing TOML parser, command rendering, and shell-sensitive argument tests. Replace the path constants near the top with:

```ts
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceExtensionPath = path.join(repoRoot, "templates", "marketplace", "gemini", "gemini-extension.json");
const marketplaceHooksPath = path.join(repoRoot, "templates", "marketplace", "gemini", "hooks", "hooks.json");
const marketplaceCommandPath = path.join(repoRoot, "templates", "marketplace", "gemini", "commands", "nams", "workspace.toml");
const localHooksPath = path.join(repoRoot, "templates", "local", "gemini", ".gemini", "extensions", "gemini-nams-hooks", "hooks", "hooks.json");
const localCommandPath = path.join(repoRoot, "templates", "local", "gemini", ".gemini", "extensions", "gemini-nams-hooks", "commands", "nams", "workspace.toml");
```

Update the existing extension settings test to read `marketplaceExtensionPath`.

Update the existing marketplace hook test to read `marketplaceHooksPath` and expect:

```ts
command: 'node "${extensionPath}/plugins/gemini-nams-hooks/bin/cli.js" run gemini --event BeforeAgent',
```

Add this local hook test:

```ts
test("Gemini local hook template routes through installed nams-hooks", async () => {
  const template = JSON.parse(await readFile(localHooksPath, "utf8"));
  const beforeAgent = template.hooks.BeforeAgent[0].hooks[0];

  assert.equal(beforeAgent.command, "nams-hooks run gemini --event BeforeAgent");
});
```

Add these workspace command tests:

```ts
test("Gemini marketplace workspace command routes through bundled platform folder", async () => {
  const source = await readFile(marketplaceCommandPath, "utf8");

  assert.match(source, /workspaces run gemini --event CustomCommand/);
  assert.match(source, /\$\{extensionPath\}\/plugins\/gemini-nams-hooks\/bin\/cli\.js/);
  assert.doesNotMatch(source, /workspaces configure/);
});

test("Gemini local workspace command routes through installed nams-hooks", async () => {
  const source = await readFile(localCommandPath, "utf8");

  assert.match(source, /nams-hooks workspaces run gemini --event CustomCommand/);
  assert.doesNotMatch(source, /\$\{extensionPath\}|bin\/cli\.js|workspaces configure/);
});
```

In the existing shell-sensitive argument test, call `shellCommandForGeminiPrompt(command.prompt, stubCliPath, sensitiveArgs)` for the marketplace command and add the same assertion for the local command with `stubCliPath` set to `"nams-hooks"` after replacing `nams-hooks` in the rendered shell command with the stub path. Both tests must continue to assert that the sentinel file is not created.

- [ ] **Step 9: Update OpenCode template tests**

In `test/opencode-template.test.ts`, keep the source path pointing at `templates/opencode/.opencode/plugins/nams-hooks.js`, and update expectations:

```ts
assert.match(source, /__NAMS_HOOKS_COMMAND__/);
assert.match(source, /process\.env\.NAMS_HOOKS_COMMAND/);
```

In `test/opencode/opencode-template.test.ts`, keep the existing `node:fs/promises` import as:

```ts
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
```

Replace the `importTemplateWithCommand()` helper with:

```ts
async function importTemplateWithCommand(commandPath: string): Promise<TemplateModule> {
  const previousCommand = process.env.NAMS_HOOKS_COMMAND;
  process.env.NAMS_HOOKS_COMMAND = commandPath;
  const renderedPath = await renderTemplateForImport();
  try {
    return (await import(`${pathToFileURL(renderedPath).href}?test=${Date.now()}-${Math.random()}`)) as TemplateModule;
  } finally {
    restoreEnv("NAMS_HOOKS_COMMAND", previousCommand);
    await rm(path.dirname(renderedPath), { recursive: true, force: true });
  }
}

async function renderTemplateForImport(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nams-opencode-rendered-template-"));
  const renderedPath = path.join(directory, "nams-hooks.js");
  const source = await readFile(templatePath, "utf8");
  await writeFile(renderedPath, source.replace("__NAMS_HOOKS_COMMAND__", JSON.stringify("nams-hooks")), "utf8");
  return renderedPath;
}
```

Keep every OpenCode behavior test unchanged.

- [ ] **Step 10: Run template tests and verify they pass**

Run:

```bash
node --import=tsx --test test/claude-template.test.ts test/codex-template.test.ts test/gemini-template.test.ts test/opencode-template.test.ts test/opencode/opencode-template.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit template migration**

Run:

```bash
git add templates test/claude-template.test.ts test/codex-template.test.ts test/gemini-template.test.ts test/opencode-template.test.ts test/opencode/opencode-template.test.ts
git commit -m "refactor: organize dist projection templates" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Add Failing Distribution Checks For Three Output Trees

**Files:**
- Modify: `scripts/check-dist.mjs`

- [ ] **Step 1: Replace top-level dist constants**

In `scripts/check-dist.mjs`, replace the current dist constants with:

```js
const npmDistDir = path.join(root, "dist");
const marketplaceDistDir = path.join(root, "dist-marketplace");
const localDistDir = path.join(root, "dist-local");
const generatedClientPath = path.join(npmDistDir, "bin", "generated", "nams-client.js");
const rootPackagePath = path.join(root, "package.json");
const releasePackageName = "@neo4j-labs/nams-plugins";
const execFileAsync = promisify(execFile);
```

- [ ] **Step 2: Replace the top-level verification flow**

Replace the top-level `await` calls through `checkPackedPackage()` with:

```js
const rootPackageJson = await verifySourcePackageIdentity(rootPackagePath);
await verifyNpmDist(rootPackageJson);
await verifyMarketplaceDist();
await verifyLocalDist();
await checkPackedPackage(root, "dist/bin/cli.js", { packageJson: rootPackageJson, identityAlreadyVerified: true });
await checkPackedPackage(npmDistDir, "bin/cli.js");
```

- [ ] **Step 3: Add npm dist verification**

Add this function:

```js
async function verifyNpmDist(rootPackageJson) {
  await assertExecutable(path.join(npmDistDir, "bin", "cli.js"));
  await access(generatedClientPath);
  const packageJson = JSON.parse(await readFile(path.join(npmDistDir, "package.json"), "utf8"));
  assertPackageIdentity(packageJson, npmDistDir, "./bin/cli.js");
  if (packageJson.version !== rootPackageJson.version || packageJson.license !== rootPackageJson.license) {
    throw new Error("dist/package.json version and license must match package.json.");
  }

  const source = await readFile(generatedClientPath, "utf8");
  if (/nams-openapi|readFile/.test(source)) {
    throw new Error("dist/bin/generated/nams-client.js must not read OpenAPI at runtime.");
  }

  const files = await listFiles(npmDistDir);
  assertNoMatchingFiles(files, /(^|\/)(\.agents|\.claude-plugin|hooks|plugins|templates)(\/|$)/, "dist must not include marketplace or template files");
  assertNoMatchingFiles(files, /openapi|nams-openapi/i, "dist must not include OpenAPI artifacts");
}
```

- [ ] **Step 4: Add marketplace dist verification**

Add this function:

```js
async function verifyMarketplaceDist() {
  await verifyGeminiMarketplaceFiles();
  await verifyClaudeMarketplaceFiles();
  await verifyCodexMarketplaceFiles();
  await verifyOpenCodeMarketplaceFiles();

  const files = await listFiles(marketplaceDistDir);
  assertNoMatchingFiles(files, /openapi|nams-openapi/i, "dist-marketplace must not include OpenAPI artifacts");
  const unresolved = await filesWithPattern(marketplaceDistDir, /__PACKAGE_VERSION__|__PACKAGE_LICENSE__|__NAMS_HOOKS_COMMAND__/);
  if (unresolved.length > 0) {
    throw new Error(`dist-marketplace contains unresolved template placeholders: ${unresolved.join(", ")}`);
  }
}
```

- [ ] **Step 5: Add local dist verification**

Add this function:

```js
async function verifyLocalDist() {
  await verifyLocalCommandJson(path.join(localDistDir, "claude", ".claude", "settings.local.json"), "claude");
  await verifyLocalClaudeWorkspaceCommand(path.join(localDistDir, "claude", ".claude", "commands", "nams", "workspace.md"));
  await verifyLocalCommandJson(path.join(localDistDir, "codex", ".codex", "hooks.json"), "codex");
  await verifyLocalCommandJson(path.join(localDistDir, "gemini", ".gemini", "extensions", "gemini-nams-hooks", "hooks", "hooks.json"), "gemini");
  await verifyLocalGeminiWorkspaceCommand(path.join(localDistDir, "gemini", ".gemini", "extensions", "gemini-nams-hooks", "commands", "nams", "workspace.toml"));
  const opencodeSource = await readFile(path.join(localDistDir, "opencode", ".opencode", "plugins", "nams-hooks.js"), "utf8");
  if (!/\"nams-hooks\"/.test(opencodeSource) || /new URL\("\.\/bin\/cli\.js"/.test(opencodeSource)) {
    throw new Error("dist-local OpenCode plugin must default to the installed nams-hooks executable.");
  }

  const files = await listFiles(localDistDir);
  assertNoMatchingFiles(files, /(^|\/)bin\/cli\.js$/, "dist-local must not include compiled runtime");
  assertNoMatchingFiles(files, /(^|\/)(\.agents\/plugins\/marketplace\.json|\.claude-plugin\/marketplace\.json)$/, "dist-local must not include marketplace roots");
}
```

- [ ] **Step 6: Add platform-specific marketplace verification functions**

Add these functions:

```js
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
  if (marketplace.plugins?.[0]?.source !== "./plugins/claude-nams-hooks") {
    throw new Error("Claude marketplace must expose nams-hooks from ./plugins/claude-nams-hooks.");
  }
  if (plugin.name !== "nams-hooks" || plugin.version !== packageJson.version) {
    throw new Error("Claude plugin manifest must name nams-hooks and match package.json version.");
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
  if (marketplace.metadata?.version !== packageJson.version) {
    throw new Error("Codex marketplace metadata version must match package.json.");
  }
  const marketplacePlugin = marketplace.plugins?.[0];
  if (marketplacePlugin?.source?.path !== "./plugins/codex-nams-hooks") {
    throw new Error("Codex marketplace must expose nams-hooks from ./plugins/codex-nams-hooks.");
  }
  if (plugin.name !== "nams-hooks" || plugin.version !== packageJson.version) {
    throw new Error("Codex plugin manifest must name nams-hooks and match package.json version.");
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
  if (!/new URL\("\.\/bin\/cli\.js", import\.meta\.url\)\.pathname/.test(source)) {
    throw new Error("OpenCode marketplace plugin must default to its bundled bin/cli.js.");
  }
  if (/NAMS_HOOKS_COMMAND \?\? "nams-hooks"/.test(source)) {
    throw new Error("OpenCode marketplace plugin must not default to a global nams-hooks executable.");
  }
  if (!/command\.execute\.before/.test(source) || !/workspaces",\s*"run",\s*"opencode"/.test(source)) {
    throw new Error("OpenCode marketplace plugin must intercept nams:workspace and call workspaces run opencode.");
  }
}
```

- [ ] **Step 7: Add helper functions**

Add these helpers near the existing helper functions:

```js
function assertGeminiMarketplaceCommand(hooks, eventName, namsEvent) {
  const handler = hooks.hooks?.[eventName]?.[0]?.hooks?.[0];
  const expected = `node "\${extensionPath}/plugins/gemini-nams-hooks/bin/cli.js" run gemini --event ${namsEvent}`;
  if (handler?.type !== "command" || handler.command !== expected) {
    throw new Error(`Gemini marketplace ${eventName} hook must invoke ${expected}.`);
  }
}

async function verifyGeminiMarketplaceWorkspaceCommand(filePath) {
  const source = await readFile(filePath, "utf8");
  if (!/workspaces run gemini --event CustomCommand/.test(source)) {
    throw new Error("Gemini marketplace workspace command must route through CustomCommand.");
  }
  if (!/\$\{extensionPath\}\/plugins\/gemini-nams-hooks\/bin\/cli\.js/.test(source)) {
    throw new Error("Gemini marketplace workspace command must call the bundled Gemini runtime.");
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
  if (/\$\{extensionPath\}|bin\/cli\.js|workspaces configure/.test(source)) {
    throw new Error("Gemini local workspace command must not use bundled runtime paths or workspaces configure.");
  }
}

function assertClaudeWorkspaceCommand(hooks) {
  const handler = hooks.hooks?.UserPromptExpansion?.[0]?.hooks?.[0];
  const args = handler?.args ?? [];
  const expectedArgs = ["${CLAUDE_PLUGIN_ROOT}/bin/cli.js", "workspaces", "run", "claude", "--event", "UserPromptExpansion"];
  if (hooks.hooks?.UserPromptExpansion?.[0]?.matcher !== "^nams:workspace$") {
    throw new Error("Claude marketplace workspace hook must match nams:workspace.");
  }
  if (handler?.command !== "node" || JSON.stringify(args) !== JSON.stringify(expectedArgs)) {
    throw new Error("Claude marketplace workspace hook must call the bundled CLI workspace runner.");
  }
}

async function verifyClaudeWorkspaceMarkdown(filePath) {
  const source = await readFile(filePath, "utf8");
  if (!/argument-hint: use <workspace-id-or-name>/.test(source) || !/disable-model-invocation: true/.test(source)) {
    throw new Error("Claude workspace command markdown must disable model invocation and document the use argument.");
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

function assertNoMatchingFiles(files, pattern, message) {
  const matches = files.filter((file) => pattern.test(file));
  if (matches.length > 0) {
    throw new Error(`${message}: ${matches.join(", ")}`);
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
```

- [ ] **Step 8: Update packed package file expectations**

Replace `claudePackedFiles()` and `codexPackedFiles()` with a single npm runtime check. In `checkPackedPackage()`, replace the plugin file loop with:

```js
for (const expectedFile of npmPackedFiles(packageDir)) {
  if (!packedFiles.includes(expectedFile)) {
    throw new Error(`packed package is missing runtime file: ${expectedFile}`);
  }
}
```

Add:

```js
function npmPackedFiles(packageDir) {
  const prefix = packageDir === root ? "dist/" : "";
  return [
    `${prefix}bin/cli.js`,
    `${prefix}bin/generated/nams-client.js`,
    `${prefix}package.json`,
  ];
}
```

- [ ] **Step 9: Run dist check before build wiring and verify it fails**

Run:

```bash
node scripts/check-dist.mjs
```

Expected: FAIL because the split output trees are not generated yet. The error should mention a missing file under `dist/`, `dist-marketplace/`, or `dist-local/`.

- [ ] **Step 10: Commit failing check contract**

Run:

```bash
git add scripts/check-dist.mjs
git commit -m "test: require split dist outputs" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Implement Separate Build Scripts With Shared Projection Helpers

**Files:**
- Create: `scripts/build-dist-common.mjs`
- Create: `scripts/build-dist-npm.mjs`
- Create: `scripts/build-dist-marketplace.mjs`
- Create: `scripts/build-dist-local.mjs`
- Delete: `scripts/build-dist.mjs`

- [ ] **Step 1: Create shared build helper module**

Create `scripts/build-dist-common.mjs` with this content:

```js
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
```

- [ ] **Step 2: Create npm dist build script**

Create `scripts/build-dist-npm.mjs` with this content:

```js
#!/usr/bin/env node

import path from "node:path";
import {
  copyRuntime,
  readRootPackageJson,
  resetOutputRoot,
  root,
  writeReleasePackageJson,
} from "./build-dist-common.mjs";

const outputRoot = path.join(root, "dist");

await resetOutputRoot(outputRoot);
await copyRuntime(path.join(outputRoot, "bin"));
await writeReleasePackageJson(await readRootPackageJson(), path.join(outputRoot, "package.json"));
```

- [ ] **Step 3: Create marketplace dist build script**

Create `scripts/build-dist-marketplace.mjs` with this content:

```js
#!/usr/bin/env node

import path from "node:path";
import { buildProjectionTarget, root } from "./build-dist-common.mjs";

const outputRoot = path.join(root, "dist-marketplace");
const projections = [
  { kind: "template", platform: "gemini", from: "templates/marketplace/gemini/gemini-extension.json", to: "gemini-extension.json", renderPackage: false },
  { kind: "template", platform: "gemini", from: "templates/marketplace/gemini/hooks", to: "hooks", renderPackage: false },
  { kind: "template", platform: "gemini", from: "templates/marketplace/gemini/commands", to: "commands", renderPackage: false },
  { kind: "runtime", platform: "gemini", to: "plugins/gemini-nams-hooks/bin" },
  { kind: "template", platform: "claude", from: "templates/marketplace/claude/.claude-plugin", to: ".claude-plugin", renderPackage: true },
  { kind: "template", platform: "claude", from: "templates/marketplace/claude/plugins/claude-nams-hooks", to: "plugins/claude-nams-hooks", renderPackage: true },
  { kind: "runtime", platform: "claude", to: "plugins/claude-nams-hooks/bin" },
  { kind: "template", platform: "codex", from: "templates/marketplace/codex/.agents", to: ".agents", renderPackage: true },
  { kind: "template", platform: "codex", from: "templates/marketplace/codex/plugins/codex-nams-hooks", to: "plugins/codex-nams-hooks", renderPackage: true },
  { kind: "runtime", platform: "codex", to: "plugins/codex-nams-hooks/bin" },
  { kind: "opencode", platform: "opencode", from: "templates/marketplace/opencode/plugins/opencode-nams-hooks/nams-hooks.js", to: "plugins/opencode-nams-hooks/nams-hooks.js", commandMode: "bundled" },
  { kind: "runtime", platform: "opencode", to: "plugins/opencode-nams-hooks/bin" },
];

await buildProjectionTarget(outputRoot, projections);
```

- [ ] **Step 4: Create local dist build script**

Create `scripts/build-dist-local.mjs` with this content:

```js
#!/usr/bin/env node

import path from "node:path";
import { buildProjectionTarget, root } from "./build-dist-common.mjs";

const outputRoot = path.join(root, "dist-local");
const projections = [
  { kind: "template", platform: "claude", from: "templates/local/claude", to: "claude", renderPackage: false },
  { kind: "template", platform: "codex", from: "templates/local/codex", to: "codex", renderPackage: false },
  { kind: "template", platform: "gemini", from: "templates/local/gemini", to: "gemini", renderPackage: false },
  { kind: "opencode", platform: "opencode", from: "templates/local/opencode/.opencode/plugins/nams-hooks.js", to: "opencode/.opencode/plugins/nams-hooks.js", commandMode: "installed" },
];

await buildProjectionTarget(outputRoot, projections);
```

- [ ] **Step 5: Remove the old umbrella build script**

Run:

```bash
git rm scripts/build-dist.mjs
```

- [ ] **Step 6: Run split dist targets and verify output is created**

Run:

```bash
npm run dist:npm
test -x dist/bin/cli.js
npm run dist:marketplace
test -f dist-marketplace/commands/nams/workspace.toml
test -f dist-marketplace/plugins/claude-nams-hooks/commands/nams/workspace.md
test -f dist-marketplace/plugins/codex-nams-hooks/skills/workspace/SKILL.md
test -x dist-marketplace/plugins/claude-nams-hooks/bin/cli.js
test -x dist-marketplace/plugins/codex-nams-hooks/bin/cli.js
test -x dist-marketplace/plugins/gemini-nams-hooks/bin/cli.js
test -x dist-marketplace/plugins/opencode-nams-hooks/bin/cli.js
npm run dist:local
test -f dist-local/claude/.claude/commands/nams/workspace.md
test -f dist-local/codex/.codex/hooks.json
test -f dist-local/gemini/.gemini/extensions/gemini-nams-hooks/commands/nams/workspace.toml
```

Expected: all commands exit `0`.

- [ ] **Step 7: Run dist check and verify it passes**

Run:

```bash
npm run dist
npm run dist:check
```

Expected: PASS.

- [ ] **Step 8: Commit build projection implementation**

Run:

```bash
git add -A scripts/build-dist-common.mjs scripts/build-dist-npm.mjs scripts/build-dist-marketplace.mjs scripts/build-dist-local.mjs scripts/build-dist.mjs
git commit -m "feat: build split dist projections" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Tighten Dist Verification And Package Dry Run

**Files:**
- Modify: `scripts/check-dist.mjs`

- [ ] **Step 1: Run package check and record the current failure**

Run:

```bash
npm run package:check
```

Expected: FAIL before the hardening edits in this task. Acceptable failure messages include `package.json files must not include templates/`, `packed package must not include template, marketplace, or local artifacts`, or a generated-output absence error from `verifyNpmDist()`.

- [ ] **Step 2: Remove stale root package template requirement**

In `verifyRootPackageFiles()`, replace the current template requirement with:

```js
async function verifyRootPackageFiles(packagePath) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (!Array.isArray(packageJson.files) || packageJson.files.includes("templates/")) {
    throw new Error("package.json files must not include templates/ in the npm package artifact.");
  }
  if (!packageJson.files.includes("dist/")) {
    throw new Error("package.json files must include dist/ for the npm package artifact.");
  }
}
```

- [ ] **Step 3: Verify package dry-run excludes marketplace, local, templates, and OpenAPI**

In `checkPackedPackage()`, after `const packedFiles = pack.files.map((file) => file.path);`, add:

```js
const forbiddenPackedFiles = packedFiles.filter((file) =>
  /^templates\//.test(file) ||
  /^dist-marketplace\//.test(file) ||
  /^dist-local\//.test(file) ||
  /(^|\/)(\.agents|\.claude-plugin)(\/|$)/.test(file),
);
if (forbiddenPackedFiles.length > 0) {
  throw new Error(`packed package must not include template, marketplace, or local artifacts: ${forbiddenPackedFiles.join(", ")}`);
}
```

- [ ] **Step 4: Verify marketplace and local outputs are not npm-packed from `dist/`**

In `verifyNpmDist()`, add:

```js
const packageJson = JSON.parse(await readFile(path.join(npmDistDir, "package.json"), "utf8"));
if (Object.hasOwn(packageJson, "files")) {
  throw new Error("dist/package.json must not define files because dist is already the package root.");
}
```

- [ ] **Step 5: Run package check and verify it passes**

Run:

```bash
npm run package:check
```

Expected: PASS.

- [ ] **Step 6: Commit dist verification hardening**

Run:

```bash
git add scripts/check-dist.mjs
git commit -m "test: verify split dist artifacts" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 6: Update Documentation And Source-Of-Truth Design

**Files:**
- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `DEVELOPMENT.md`
- Modify: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`

- [ ] **Step 1: Update README build command descriptions**

In `README.md`, replace the package check text with:

```markdown
# Build and verify all generated artifacts: npm dist, marketplace dist, and local config dist
npm run package:check
```

Add this paragraph near the architecture section:

```markdown
Generated artifacts are split by install mode. `dist/` is the npm-installable package, `dist-marketplace/` is the self-contained marketplace release tree, and `dist-local/` contains project-local configurations that call an installed `nams-hooks` executable.
```

- [ ] **Step 2: Update INSTALL generated branch wording**

In `INSTALL.md`, replace the opening paragraph with:

```markdown
Use this guide to install `nams-hooks` from generated release artifacts. Marketplace installs are built from `dist-marketplace/`. Local project configurations are built from `dist-local/`. The npm-installable package is built from `dist/`.
For local development and generated artifact testing, see [DEVELOPMENT.md](DEVELOPMENT.md).
```

In the Codex section, replace the generated marketplace path sentence with:

```markdown
The generated Codex marketplace lives at `dist-marketplace/.agents/plugins/marketplace.json`. Its plugin source is `dist-marketplace/plugins/codex-nams-hooks/`, with standard hook configuration at `hooks/hooks.json` and the compiled CLI at `bin/cli.js`.
```

In the Claude section, add:

```markdown
The generated Claude marketplace lives at `dist-marketplace/.claude-plugin/marketplace.json`. Its plugin source is `dist-marketplace/plugins/claude-nams-hooks/`.
```

- [ ] **Step 3: Update DEVELOPMENT generated artifact guide**

In `DEVELOPMENT.md`, replace the "Generated Distribution Tree" section with this text:

````markdown
## Generated Distribution Trees

Run:

```bash
npm run dist
```

The command creates three ignored trees:

- `dist/`: npm package output with `bin/cli.js` and `package.json`.
- `dist-marketplace/`: self-contained marketplace output for Gemini, Claude Code, Codex, and OpenCode.
- `dist-local/`: project-local configurations that call an installed `nams-hooks`.

Use target-specific commands when you only need one tree:

```bash
npm run dist:npm
npm run dist:marketplace
npm run dist:local
```

Do not hand-edit generated dist trees; change TypeScript source, templates, or build scripts instead.
````

Update local test command blocks:

```bash
npm run dist:marketplace
gemini extensions link ./dist-marketplace
```

```bash
npm run dist:marketplace
codex plugin marketplace add ./dist-marketplace
```

```bash
npm run dist:npm
npm install -g ./dist
cp -R dist-local/codex/.codex /path/to/project/.codex
```

```bash
npm run dist:marketplace
claude plugin validate ./dist-marketplace
claude plugin marketplace add ./dist-marketplace
```

```bash
npm run dist:npm
npm install -g ./dist
cp -R dist-local/claude/.claude /path/to/project/.claude
```

```bash
npm run dist:npm
npm install -g ./dist
cp -R dist-local/gemini/.gemini /path/to/project/.gemini
```

```bash
npm run dist:local
cp dist-local/opencode/.opencode/plugins/nams-hooks.js /path/to/project/.opencode/plugins/nams-hooks.js
```

- [ ] **Step 4: Update the primary architecture design**

In `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`, update the Build And Distribution section so it states:

```markdown
On `devel`, `dist/`, `dist-marketplace/`, and `dist-local/` are generated and ignored. `npm run dist` builds all three trees. `dist/` is the npm package artifact. `dist-marketplace/` is the self-contained marketplace release tree for Gemini, Claude Code, Codex, and OpenCode. `dist-local/` contains project-local configurations that call an installed `nams-hooks` executable.
```

Replace the old single `dist/` tree with three trees matching the final generated output:

```text
dist/
  bin/
    cli.js
    platforms/
    runtime/
    generated/
      nams-client.js
  package.json

dist-marketplace/
  .agents/
    plugins/
      marketplace.json
  .claude-plugin/
    marketplace.json
  gemini-extension.json
  commands/
    nams/
      workspace.toml
  hooks/
    hooks.json
  plugins/
    claude-nams-hooks/
      .claude-plugin/
        plugin.json
      commands/
        nams/
          workspace.md
      hooks/
        hooks.json
      bin/
        cli.js
    codex-nams-hooks/
      .codex-plugin/
        plugin.json
      hooks/
        hooks.json
      skills/
        workspace/
          SKILL.md
          agents/
            openai.yaml
      bin/
        cli.js
    gemini-nams-hooks/
      bin/
        cli.js
    opencode-nams-hooks/
      nams-hooks.js
      bin/
        cli.js

dist-local/
  claude/
    .claude/
      commands/
        nams/
          workspace.md
      settings.local.json
  codex/
    .codex/
      hooks.json
  gemini/
    .gemini/
      extensions/
        gemini-nams-hooks/
          gemini-extension.json
          commands/
            nams/
              workspace.toml
          hooks/
            hooks.json
  opencode/
    .opencode/
      plugins/
        nams-hooks.js
```

- [ ] **Step 5: Run documentation search for stale paths**

Run:

```bash
rg -n "templates/(claude|codex|gemini)|templates/opencode/plugins|dist/\\.agents|dist/\\.claude-plugin|dist/plugins/nams-hooks|\\.\\/dist" README.md INSTALL.md DEVELOPMENT.md docs/superpowers/specs/2026-05-10-nams-hooks-design.md
```

Expected: output contains no stale instructions that describe marketplace files under `dist/`, no `templates/claude/.claude`, no `templates/codex/hooks.json`, no `templates/opencode/plugins/nams-hooks.js`, and no `dist/plugins/nams-hooks` Claude path.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm run package:check
```

Expected: PASS.

- [ ] **Step 7: Commit docs**

Run:

```bash
git add README.md INSTALL.md DEVELOPMENT.md docs/superpowers/specs/2026-05-10-nams-hooks-design.md
git commit -m "docs: document split dist artifacts" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 7: Final Artifact Inspection

**Files:**
- No source file changes expected.

- [ ] **Step 1: Build all generated outputs**

Run:

```bash
npm run dist
```

Expected: PASS.

- [ ] **Step 2: Inspect generated output roots**

Run:

```bash
find dist dist-marketplace dist-local -maxdepth 8 -type f | sort
```

Expected output includes:

```text
dist/bin/cli.js
dist/package.json
dist-marketplace/.agents/plugins/marketplace.json
dist-marketplace/.claude-plugin/marketplace.json
dist-marketplace/commands/nams/workspace.toml
dist-marketplace/gemini-extension.json
dist-marketplace/hooks/hooks.json
dist-local/claude/.claude/commands/nams/workspace.md
dist-local/claude/.claude/settings.local.json
dist-local/codex/.codex/hooks.json
dist-local/gemini/.gemini/extensions/gemini-nams-hooks/commands/nams/workspace.toml
```

- [ ] **Step 3: Inspect marketplace plugin runtime bundles**

Run:

```bash
find dist-marketplace/plugins -maxdepth 4 -type f | sort
```

Expected output includes:

```text
dist-marketplace/plugins/claude-nams-hooks/bin/cli.js
dist-marketplace/plugins/claude-nams-hooks/commands/nams/workspace.md
dist-marketplace/plugins/codex-nams-hooks/bin/cli.js
dist-marketplace/plugins/codex-nams-hooks/skills/workspace/SKILL.md
dist-marketplace/plugins/gemini-nams-hooks/bin/cli.js
dist-marketplace/plugins/opencode-nams-hooks/bin/cli.js
dist-marketplace/plugins/opencode-nams-hooks/nams-hooks.js
```

- [ ] **Step 4: Verify command-mode separation**

Run:

```bash
node -e 'const fs=require("fs"); const files=["dist-marketplace/hooks/hooks.json","dist-marketplace/commands/nams/workspace.toml","dist-marketplace/plugins/claude-nams-hooks/hooks/hooks.json","dist-marketplace/plugins/codex-nams-hooks/skills/workspace/SKILL.md","dist-local/claude/.claude/settings.local.json","dist-local/gemini/.gemini/extensions/gemini-nams-hooks/commands/nams/workspace.toml","dist-local/codex/.codex/hooks.json"]; for (const file of files) console.log(file + "\\n" + fs.readFileSync(file, "utf8"));'
```

Expected:

- `dist-marketplace/hooks/hooks.json` contains `plugins/gemini-nams-hooks/bin/cli.js`.
- `dist-marketplace/commands/nams/workspace.toml` contains `plugins/gemini-nams-hooks/bin/cli.js`.
- `dist-marketplace/plugins/claude-nams-hooks/hooks/hooks.json` contains `${CLAUDE_PLUGIN_ROOT}/bin/cli.js`.
- `dist-marketplace/plugins/codex-nams-hooks/skills/workspace/SKILL.md` contains `node bin/cli.js workspaces run codex --event CustomCommand`.
- `dist-local/claude/.claude/settings.local.json` contains `nams-hooks workspaces run claude --event UserPromptExpansion`.
- `dist-local/gemini/.gemini/extensions/gemini-nams-hooks/commands/nams/workspace.toml` contains `nams-hooks workspaces run gemini --event CustomCommand`.
- `dist-local/codex/.codex/hooks.json` contains `nams-hooks run codex`.

- [ ] **Step 5: Run final package check**

Run:

```bash
npm run package:check
```

Expected: PASS.

- [ ] **Step 6: Confirm no tracked source changes remain uncommitted**

Run:

```bash
git status --short
```

Expected: clean output because all source, template, script, test, and doc changes were committed in previous tasks. Ignored generated dist trees may exist but must not appear in `git status --short`.
