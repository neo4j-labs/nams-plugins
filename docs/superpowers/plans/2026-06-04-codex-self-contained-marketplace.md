# Codex Self-Contained Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-contained Codex repo marketplace release path whose plugin bundles the compiled NAMS hook runtime and is available for users to install without a global `nams-hooks` executable.

**Architecture:** Keep runtime behavior unchanged and add only release packaging, template, verification, and documentation work. The generated Codex marketplace will point at `./plugins/codex-nams-hooks` so it does not collide with the existing Claude plugin directory at `./plugins/nams-hooks`, which already owns a different `hooks/hooks.json`. The Codex plugin manifest still names the plugin `nams-hooks`; only the distribution source directory is platform-specific.

**Tech Stack:** TypeScript source, Node.js built-ins, Node's `node:test` runner through `tsx`, JSON templates, existing `scripts/build-dist.mjs` and `scripts/check-dist.mjs`, no runtime npm dependencies.

---

## File Structure

- `docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md`: amend the approved spec to use `plugins/codex-nams-hooks` for Codex distribution, avoiding a shared hook file with Claude.
- `test/codex-template.test.ts`: new template-level tests for Codex marketplace, plugin manifest, and bundled hook command shape.
- `templates/codex/.agents/plugins/marketplace.json`: source Codex repo marketplace template.
- `templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json`: source Codex plugin manifest template.
- `templates/codex/plugins/codex-nams-hooks/hooks/hooks.json`: source Codex plugin lifecycle hook template.
- `scripts/build-dist.mjs`: render/copy Codex marketplace templates and copy compiled runtime into `dist/plugins/codex-nams-hooks/bin`.
- `scripts/check-dist.mjs`: verify Codex marketplace files, rendered metadata, hook commands, executable CLI, and packed package contents.
- `README.md`: update release-package wording from Claude-only plugin verification to Claude and Codex marketplace verification.
- `INSTALL.md`: add Codex repo marketplace install instructions and keep project hook settings as the fallback path.
- `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`: update the source-of-truth architecture/distribution design for the Codex marketplace path and generated tree.

---

### Task 1: Correct The Design Path Collision

**Files:**
- Modify: `docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md`

- [x] **Step 1: Edit the Codex plugin directory in the spec**

Replace the generated tree section so Codex uses `plugins/codex-nams-hooks`:

```markdown
dist/
  .agents/
    plugins/
      marketplace.json
  plugins/
    codex-nams-hooks/
      .codex-plugin/
        plugin.json
      hooks/
        hooks.json
      bin/
        cli.js
        platforms/
        runtime/
        generated/
```

Update the adjacent marketplace sentence to:

```markdown
The marketplace file exposes a single plugin named `nams-hooks` with `source.path` set to `./plugins/codex-nams-hooks`. Its policy sets `installation` to `AVAILABLE` and `authentication` to `ON_USE`. It does not make the plugin installed by default, and it does not define Codex plugin NAMS credential prompts. The source directory is platform-specific because the existing Claude plugin release path already uses `dist/plugins/nams-hooks/hooks/hooks.json` for Claude-specific hook commands.
```

- [x] **Step 2: Edit the build integration bullets in the spec**

Replace the Codex template paths in the Build Integration section with:

```markdown
- Render `templates/codex/.agents/plugins/marketplace.json` to `dist/.agents/plugins/marketplace.json`.
- Render `templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json` to `dist/plugins/codex-nams-hooks/.codex-plugin/plugin.json`.
- Render `templates/codex/plugins/codex-nams-hooks/hooks/hooks.json` to `dist/plugins/codex-nams-hooks/hooks/hooks.json`.
- Copy compiled runtime output from `.build/tsc` to `dist/plugins/codex-nams-hooks/bin`.
- Mark the bundled `dist/plugins/codex-nams-hooks/bin/cli.js` executable.
```

- [x] **Step 3: Edit the verification bullet in the spec**

Replace the executable verification bullet with:

```markdown
- Generated `dist/plugins/codex-nams-hooks/bin/cli.js` is executable.
```

- [x] **Step 4: Review the spec diff**

Run:

```bash
git diff -- docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md
```

Expected: only the Codex plugin source directory changes from `plugins/nams-hooks` to `plugins/codex-nams-hooks`, plus the explanation that this avoids the Claude hook file collision.

- [x] **Step 5: Commit**

Run:

```bash
git add docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md
git commit -m "docs: clarify codex plugin release path" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Add Codex Marketplace Template Tests And Templates

**Files:**
- Create: `test/codex-template.test.ts`
- Create: `templates/codex/.agents/plugins/marketplace.json`
- Create: `templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json`
- Create: `templates/codex/plugins/codex-nams-hooks/hooks/hooks.json`

- [x] **Step 1: Write the failing template test**

Create `test/codex-template.test.ts` with this content:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const marketplacePath = "templates/codex/.agents/plugins/marketplace.json";
const pluginManifestPath = "templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json";
const pluginHooksPath = "templates/codex/plugins/codex-nams-hooks/hooks/hooks.json";
const pluginRoot = "${PLUGIN_ROOT}";

test("Codex repo marketplace template exposes nams-hooks as available", async () => {
  const template = JSON.parse(await readFile(marketplacePath, "utf8"));

  assert.equal(template.name, "nams-plugins");
  assert.equal(template.metadata.description, "Neo4j Agent Memory Service hooks for Codex.");
  assert.equal(template.metadata.version, "__PACKAGE_VERSION__");

  assert.equal(template.plugins.length, 1);

  const plugin = template.plugins[0];
  assert.equal(plugin.name, "nams-hooks");
  assert.deepEqual(plugin.source, {
    source: "local",
    path: "./plugins/codex-nams-hooks",
  });
  assert.deepEqual(plugin.policy, {
    installation: "AVAILABLE",
    authentication: "ON_USE",
  });
  assert.equal(plugin.interface.displayName, "NAMS Hooks");
  assert.equal(plugin.description, "Persistent Neo4j Agent Memory Service hooks for Codex.");
  assert.equal(plugin.version, "__PACKAGE_VERSION__");
  assert.equal(plugin.author.name, "Neo4j Labs");
  assert.equal(plugin.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(plugin.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(plugin.keywords, ["memory", "context", "persistence", "neo4j", "nams"]);
  assert.equal(plugin.category, "Productivity");
});

test("Codex plugin manifest template declares metadata without credential prompts", async () => {
  const template = JSON.parse(await readFile(pluginManifestPath, "utf8"));

  assert.equal(template.name, "nams-hooks");
  assert.equal(template.version, "__PACKAGE_VERSION__");
  assert.equal(template.description, "Persistent Neo4j Agent Memory Service hooks for Codex.");
  assert.equal(template.author.name, "Neo4j Labs");
  assert.equal(template.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(template.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(template.keywords, ["memory", "context", "persistence", "neo4j", "nams"]);
  assert.equal(Object.hasOwn(template, "userConfig"), false);
  assert.equal(Object.hasOwn(template, "authentication"), false);
  assert.equal(Object.hasOwn(template, "hooks"), false);
});

test("Codex plugin hook template invokes the bundled CLI through plugin root", async () => {
  const template = JSON.parse(await readFile(pluginHooksPath, "utf8"));

  assert.deepEqual(codexHookFor(template, "SessionStart"), {
    matcher: "startup|resume",
    type: "command",
    command: `node ${pluginRoot}/bin/cli.js run codex --event SessionStart`,
    statusMessage: "Loading session notes",
  });
  assert.deepEqual(codexHookFor(template, "UserPromptSubmit"), {
    type: "command",
    command: `node ${pluginRoot}/bin/cli.js run codex --event BeforeAgent`,
    statusMessage: "NAMS memory recall",
  });
  assert.deepEqual(codexHookFor(template, "Stop"), {
    type: "command",
    command: `node ${pluginRoot}/bin/cli.js run codex --event AfterAgent`,
    statusMessage: "NAMS assistant persistence",
  });
  assert.deepEqual(codexHookFor(template, "PostToolUse"), {
    type: "command",
    command: `node ${pluginRoot}/bin/cli.js run codex --event AfterTool`,
    statusMessage: "NAMS tool metadata",
  });
});

function codexHookFor(template: any, eventName: string): Record<string, string> {
  const group = template.hooks[eventName]?.[0];
  const handler = group?.hooks?.[0] ?? {};
  return {
    ...(group?.matcher !== undefined ? { matcher: group.matcher } : {}),
    type: handler.type,
    command: handler.command,
    statusMessage: handler.statusMessage,
  };
}
```

- [x] **Step 2: Run the test to verify it fails**

Run:

```bash
node --import=tsx --test test/codex-template.test.ts
```

Expected: FAIL with an `ENOENT` error for `templates/codex/.agents/plugins/marketplace.json`.

- [x] **Step 3: Create the Codex marketplace template**

Create `templates/codex/.agents/plugins/marketplace.json`:

```json
{
  "name": "nams-plugins",
  "metadata": {
    "description": "Neo4j Agent Memory Service hooks for Codex.",
    "version": "__PACKAGE_VERSION__"
  },
  "plugins": [
    {
      "name": "nams-hooks",
      "source": {
        "source": "local",
        "path": "./plugins/codex-nams-hooks"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_USE"
      },
      "interface": {
        "displayName": "NAMS Hooks"
      },
      "description": "Persistent Neo4j Agent Memory Service hooks for Codex.",
      "version": "__PACKAGE_VERSION__",
      "author": {
        "name": "Neo4j Labs"
      },
      "repository": "https://github.com/neo4j-labs/nams-plugins",
      "license": "__PACKAGE_LICENSE__",
      "keywords": [
        "memory",
        "context",
        "persistence",
        "neo4j",
        "nams"
      ],
      "category": "Productivity"
    }
  ]
}
```

- [x] **Step 4: Create the Codex plugin manifest template**

Create `templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json`:

```json
{
  "name": "nams-hooks",
  "version": "__PACKAGE_VERSION__",
  "description": "Persistent Neo4j Agent Memory Service hooks for Codex.",
  "author": {
    "name": "Neo4j Labs"
  },
  "repository": "https://github.com/neo4j-labs/nams-plugins",
  "license": "__PACKAGE_LICENSE__",
  "keywords": [
    "memory",
    "context",
    "persistence",
    "neo4j",
    "nams"
  ]
}
```

- [x] **Step 5: Create the Codex plugin hook template**

Create `templates/codex/plugins/codex-nams-hooks/hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "node ${PLUGIN_ROOT}/bin/cli.js run codex --event SessionStart",
            "statusMessage": "Loading session notes"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${PLUGIN_ROOT}/bin/cli.js run codex --event BeforeAgent",
            "statusMessage": "NAMS memory recall"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${PLUGIN_ROOT}/bin/cli.js run codex --event AfterAgent",
            "statusMessage": "NAMS assistant persistence"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${PLUGIN_ROOT}/bin/cli.js run codex --event AfterTool",
            "statusMessage": "NAMS tool metadata"
          }
        ]
      }
    ]
  }
}
```

- [x] **Step 6: Run the template test to verify it passes**

Run:

```bash
node --import=tsx --test test/codex-template.test.ts
```

Expected: PASS for all three Codex template tests.

- [x] **Step 7: Run the full test suite**

Run:

```bash
npm run check
```

Expected: PASS. Existing Codex project hook template tests in `test/cli-session-start.test.ts` still expect `templates/codex/hooks.json` to call the global `nams-hooks` command and should remain unchanged.

- [x] **Step 8: Commit**

Run:

```bash
git add test/codex-template.test.ts templates/codex/.agents/plugins/marketplace.json templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json templates/codex/plugins/codex-nams-hooks/hooks/hooks.json
git commit -m "feat: add codex marketplace templates" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Wire Codex Templates Into Distribution Build And Checks

**Files:**
- Modify: `scripts/build-dist.mjs`
- Modify: `scripts/check-dist.mjs`

- [x] **Step 1: Extend `check-dist.mjs` with failing Codex artifact checks**

In `scripts/check-dist.mjs`, add these constants below the Claude constants:

```js
const codexMarketplacePath = path.join(root, "dist", ".agents", "plugins", "marketplace.json");
const codexPluginManifestPath = path.join(root, "dist", "plugins", "codex-nams-hooks", ".codex-plugin", "plugin.json");
const codexPluginHooksPath = path.join(root, "dist", "plugins", "codex-nams-hooks", "hooks", "hooks.json");
const codexPluginCliPath = path.join(root, "dist", "plugins", "codex-nams-hooks", "bin", "cli.js");
```

Add this call immediately after `await verifyClaudePluginFiles();`:

```js
await verifyCodexPluginFiles();
```

Add this function after `verifyClaudePluginFiles()`:

```js
async function verifyCodexPluginFiles() {
  await access(codexMarketplacePath);
  await access(codexPluginManifestPath);
  await access(codexPluginHooksPath);
  await assertExecutable(codexPluginCliPath);

  const packageJson = JSON.parse(await readFile(rootPackagePath, "utf8"));
  const marketplace = JSON.parse(await readFile(codexMarketplacePath, "utf8"));
  const plugin = JSON.parse(await readFile(codexPluginManifestPath, "utf8"));
  const hooks = JSON.parse(await readFile(codexPluginHooksPath, "utf8"));

  if (marketplace.name !== "nams-plugins") {
    throw new Error("dist/.agents/plugins/marketplace.json must name the marketplace nams-plugins.");
  }

  const marketplacePlugin = marketplace.plugins?.[0];
  if (marketplacePlugin?.name !== "nams-hooks") {
    throw new Error("Codex marketplace must expose the nams-hooks plugin.");
  }
  if (marketplacePlugin.source?.source !== "local" || marketplacePlugin.source?.path !== "./plugins/codex-nams-hooks") {
    throw new Error("Codex marketplace must expose nams-hooks from ./plugins/codex-nams-hooks.");
  }
  if (marketplacePlugin.policy?.installation !== "AVAILABLE") {
    throw new Error("Codex marketplace must mark nams-hooks as available for installation.");
  }
  if (marketplacePlugin.policy?.authentication !== "ON_USE") {
    throw new Error("Codex marketplace must defer marketplace authentication policy until first use.");
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
  if (plugin.license !== packageJson.license) {
    throw new Error("Codex plugin manifest license must match package.json.");
  }
  if (Object.hasOwn(plugin, "userConfig") || Object.hasOwn(plugin, "authentication")) {
    throw new Error("Codex plugin manifest must not define NAMS credential prompts.");
  }

  assertCodexHookCommand(hooks, "SessionStart", "SessionStart", "Loading session notes", "startup|resume");
  assertCodexHookCommand(hooks, "UserPromptSubmit", "BeforeAgent", "NAMS memory recall");
  assertCodexHookCommand(hooks, "Stop", "AfterAgent", "NAMS assistant persistence");
  assertCodexHookCommand(hooks, "PostToolUse", "AfterTool", "NAMS tool metadata");
}
```

Add this helper after `assertClaudeHookCommand()`:

```js
function assertCodexHookCommand(hooks, eventName, namsEvent, statusMessage, matcher) {
  const group = hooks.hooks?.[eventName]?.[0];
  const handler = group?.hooks?.[0];
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
```

Update `checkPackedPackage()` so it checks both Claude and Codex expected files:

```js
  for (const expectedFile of [...claudePackedFiles(packageDir), ...codexPackedFiles(packageDir)]) {
    if (!packedFiles.includes(expectedFile)) {
      throw new Error(`packed package is missing plugin file: ${expectedFile}`);
    }
  }
```

Add this function after `claudePackedFiles()`:

```js
function codexPackedFiles(packageDir) {
  const prefix = packageDir === root ? "dist/" : "";
  return [
    `${prefix}.agents/plugins/marketplace.json`,
    `${prefix}plugins/codex-nams-hooks/.codex-plugin/plugin.json`,
    `${prefix}plugins/codex-nams-hooks/hooks/hooks.json`,
    `${prefix}plugins/codex-nams-hooks/bin/cli.js`,
  ];
}
```

- [x] **Step 2: Run dist verification to verify it fails before build wiring**

Run:

```bash
npm run dist
npm run dist:check
```

Expected: `npm run dist` succeeds, then `npm run dist:check` fails because `dist/.agents/plugins/marketplace.json` is missing.

- [x] **Step 3: Wire Codex templates into `build-dist.mjs`**

In `scripts/build-dist.mjs`, add a Codex plugin directory constant below `claudePluginDir`:

```js
const codexPluginDir = path.join(distDir, "plugins", "codex-nams-hooks");
```

In `main()`, add `await writeCodexTemplates(source);` immediately after `await writeClaudeTemplates(source);`:

```js
  await writeClaudeTemplates(source);
  await writeCodexTemplates(source);
  await writeReleasePackageJson(source);
```

Add this function after `writeClaudeTemplates()`:

```js
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
```

- [x] **Step 4: Run dist verification to verify it passes**

Run:

```bash
npm run dist
npm run dist:check
```

Expected: both commands PASS. `dist/.agents/plugins/marketplace.json`, `dist/plugins/codex-nams-hooks/.codex-plugin/plugin.json`, `dist/plugins/codex-nams-hooks/hooks/hooks.json`, and `dist/plugins/codex-nams-hooks/bin/cli.js` exist.

- [x] **Step 5: Run the full package check**

Run:

```bash
npm run package:check
```

Expected: PASS. This verifies OpenAPI freshness, TypeScript build, typecheck, tests, dist generation, dist checks, executable bits, and dry-run package contents.

- [x] **Step 6: Commit**

Run:

```bash
git add scripts/build-dist.mjs scripts/check-dist.mjs
git commit -m "feat: bundle codex marketplace in dist" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Update User-Facing Installation And Architecture Docs

**Files:**
- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`

- [x] **Step 1: Update the README release-package command description**

In `README.md`, replace:

```markdown
# Build and verify the generated release package, including Claude plugin files
npm run package:check
```

with:

```markdown
# Build and verify the generated release package, including Claude and Codex plugin files
npm run package:check
```

- [x] **Step 2: Update the README runtime configuration paragraph**

In `README.md`, replace the first sentence under `### Runtime Configuration And Storage` with:

```markdown
Runtime configuration is JSON-first: `~/.nams/config.json`, optional project `.nams/config.json`, Claude plugin user configuration when running inside a Claude plugin, then final `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides. Codex plugin installs use the same JSON and `NAMS_*` environment configuration path; Codex does not currently define NAMS credentials through plugin install prompts. `apiKey` and `workspaceId` are required for NAMS requests.
```

Keep the rest of the paragraph about state and logs.

- [x] **Step 3: Update INSTALL prerequisites for Codex**

In `INSTALL.md`, replace:

```markdown
- Codex, for project-level Codex hooks
```

with:

```markdown
- Codex, for the Codex repo marketplace path or project-level Codex hooks
```

- [x] **Step 4: Add the Codex marketplace install path to INSTALL**

In `INSTALL.md`, replace the first Codex section through the local development copy command block with this text:

````markdown
## Codex

Codex can install `nams-hooks` from a repo marketplace. The Codex plugin bundles the compiled runtime under its own plugin directory, so marketplace installs do not require a global `nams-hooks` executable.

Codex plugin installs use the Configuration section above for NAMS credentials. Unlike Claude Code plugin installs, Codex does not currently provide a documented custom plugin secret prompt for `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, or `NAMS_BASE_URL`.

### From A Generated Marketplace

Use this path when testing the generated release tree locally:

```bash
npm install
npm run dist
codex plugin marketplace add ./dist
codex plugin marketplace list
```

Restart Codex, open the plugin directory with `/plugins`, select the `nams-plugins` marketplace, and install `NAMS Hooks`. Then use `/hooks` to review and trust the plugin-bundled hooks when Codex asks for hook review.

The generated Codex marketplace lives at `dist/.agents/plugins/marketplace.json`. Its plugin source is `dist/plugins/codex-nams-hooks/`, with standard hook configuration at `hooks/hooks.json` and the compiled CLI at `bin/cli.js`.

For a published generated release branch, add the repository marketplace instead of the local `./dist` directory:

```bash
codex plugin marketplace add neo4j-labs/nams-plugins@latest
```

Restart Codex, open `/plugins`, select the repository marketplace, and install `NAMS Hooks`.

### From Project Hook Settings

Use this fallback path when you want a project-local `.codex/hooks.json` hook file instead of a Codex plugin marketplace install.

Codex loads project hook settings from `.codex/hooks.json`. Hook execution is controlled by the `hooks` feature flag in Codex config.

Install the package so `nams-hooks` is on `PATH`, then copy the Codex hook template into the target project:

```bash
npm install -g @neo4j-labs/nams-plugins
mkdir -p .codex
cp "$(npm root -g)/@neo4j-labs/nams-plugins/templates/codex/hooks.json" .codex/hooks.json
```

If `.codex/hooks.json` already exists, merge the `hooks` entries from `templates/codex/hooks.json` instead of replacing the file.

For local development from this repository:

```bash
npm install
npm run dist
npm install -g ./dist
mkdir -p /path/to/project/.codex
cp templates/codex/hooks.json /path/to/project/.codex/hooks.json
```
````

Keep the existing `[features] hooks = true` and `/hooks` trust text after this replacement.

- [x] **Step 5: Update the architecture summary**

In `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`, replace the current summary sentence that says Codex uses project-level installs with:

```markdown
`nams-hooks` is a standalone Node.js integration layer that connects local agent harness hooks to the Neo4j Agent Memory Service (NAMS) REST API. Its hook runtime and generated release artifacts have zero runtime npm dependencies and use Node.js built-ins only, while the source repository may use dev-only build, generation, and test tooling. The first iteration supports macOS for Codex, Claude Code, Gemini CLI, and OpenCode. Gemini uses extension distribution. Claude Code can use a generated Claude plugin marketplace artifact, with project-level settings as a fallback path. Codex can use a generated repo marketplace plugin artifact, with project-level hooks as a fallback path. OpenCode uses a project-level plugin install. Runtime configuration, state, and logs live under user-level `~/.nams/`, with optional project overrides in `.nams/config.json`.
```

- [x] **Step 6: Update the generated dist tree in the architecture design**

In `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`, update the `dist/` tree in the Build And Distribution section so it contains the Codex marketplace and plugin:

```text
dist/
  .agents/
    plugins/
      marketplace.json
  .claude-plugin/
    marketplace.json
  gemini-extension.json
  hooks/
    hooks.json
  bin/
    cli.js
    platforms/
    runtime/
    generated/
      nams-client.js
  plugins/
    codex-nams-hooks/
      .codex-plugin/
        plugin.json
      hooks/
        hooks.json
      bin/
        cli.js
        platforms/
        runtime/
        generated/
          nams-client.js
    nams-hooks/
      .claude-plugin/
        plugin.json
      hooks/
        hooks.json
      bin/
        cli.js
        platforms/
        runtime/
        generated/
          nams-client.js
  package.json
```

- [x] **Step 7: Add the Codex marketplace release paragraph in the architecture design**

In `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`, replace the paragraph that starts `Codex and OpenCode distribution use the released CLI package` with:

````markdown
Codex users can add the generated release tree as a repo marketplace and install the available `nams-hooks` plugin. The Codex marketplace lives at `.agents/plugins/marketplace.json` and points to `./plugins/codex-nams-hooks`. The plugin bundles its own compiled `bin/cli.js` and standard `hooks/hooks.json`, with hook commands using `${PLUGIN_ROOT}/bin/cli.js`, so Codex marketplace installs do not require a global `nams-hooks` executable. Codex marketplace policy uses `authentication: "ON_USE"` as marketplace auth timing metadata, but plugin installs do not define NAMS credential values or prompts through plugin metadata; they use the existing `.nams/config.json` and `NAMS_*` environment configuration model:

```bash
codex plugin marketplace add neo4j-labs/nams-plugins@latest
```

OpenCode distribution uses the released CLI package and project-level plugin. Codex and Claude Code can still use project-level settings fallbacks when plugin marketplace installs are not desired:

```bash
npm install -g @neo4j-labs/nams-plugins
nams-hooks install --harness codex,claude,opencode
```
````

- [x] **Step 8: Update the architecture rules bullets**

In the same design document, replace:

```markdown
- Codex, Claude, and OpenCode npm releases are produced from the same validated artifact.
- `npm run package:check` must verify that Claude marketplace and plugin files are present in `dist/` and included by npm dry-run packing.
```

with:

```markdown
- Codex, Claude, and OpenCode npm releases are produced from the same validated artifact.
- `npm run package:check` must verify that Claude and Codex marketplace/plugin files are present in `dist/` and included by npm dry-run packing.
```

- [x] **Step 9: Update the Codex platform-specific distribution bullets**

In the Codex subsection near the platform notes, add this bullet before the project-level `.codex/hooks.json` bullet:

```markdown
- Use generated Codex repo marketplace distribution by default for releases. The marketplace root contains `.agents/plugins/marketplace.json`, the plugin root is `plugins/codex-nams-hooks/`, and plugin hooks reference `${PLUGIN_ROOT}` rather than a global executable.
```

Keep the existing project-level `.codex/hooks.json` bullet as the fallback path.

- [x] **Step 10: Run checks**

Run:

```bash
npm run check
npm run package:check
```

Expected: both commands PASS.

- [x] **Step 11: Commit**

Run:

```bash
git add README.md INSTALL.md docs/superpowers/specs/2026-05-10-nams-hooks-design.md
git commit -m "docs: document codex marketplace install" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Final Verification And Release Artifact Inspection

**Files:**
- No source file changes expected.

- [x] **Step 1: Run the complete verification target**

Run:

```bash
npm run package:check
```

Expected: PASS.

- [x] **Step 2: Inspect the generated Codex marketplace files**

Run:

```bash
find dist/.agents dist/plugins/codex-nams-hooks -maxdepth 4 -type f | sort
```

Expected output includes:

```text
dist/.agents/plugins/marketplace.json
dist/plugins/codex-nams-hooks/.codex-plugin/plugin.json
dist/plugins/codex-nams-hooks/bin/cli.js
dist/plugins/codex-nams-hooks/hooks/hooks.json
```

- [x] **Step 3: Inspect the generated Codex marketplace JSON**

Run:

```bash
node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync("dist/.agents/plugins/marketplace.json","utf8")); const p=m.plugins[0]; console.log(JSON.stringify({name:m.name, plugin:p.name, source:p.source, policy:p.policy, version:p.version}, null, 2));'
```

Expected output:

```json
{
  "name": "nams-plugins",
  "plugin": "nams-hooks",
  "source": {
    "source": "local",
    "path": "./plugins/codex-nams-hooks"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_USE"
  },
  "version": "0.1.0"
}
```

- [x] **Step 4: Inspect the generated Codex hook commands**

Run:

```bash
node -e 'const fs=require("fs"); const hooks=JSON.parse(fs.readFileSync("dist/plugins/codex-nams-hooks/hooks/hooks.json","utf8")).hooks; for (const [event, groups] of Object.entries(hooks)) console.log(event + ": " + groups[0].hooks[0].command);'
```

Expected output:

```text
SessionStart: node ${PLUGIN_ROOT}/bin/cli.js run codex --event SessionStart
UserPromptSubmit: node ${PLUGIN_ROOT}/bin/cli.js run codex --event BeforeAgent
Stop: node ${PLUGIN_ROOT}/bin/cli.js run codex --event AfterAgent
PostToolUse: node ${PLUGIN_ROOT}/bin/cli.js run codex --event AfterTool
```

- [x] **Step 5: Confirm the worktree only has expected generated output**

Run:

```bash
git status --short
```

Expected: clean output, because `dist/` is ignored and all source/doc changes were committed in earlier tasks.

If `git status --short` shows tracked source changes, stop and run `git diff --name-status` plus `git diff` to identify the unexpected files before continuing.
