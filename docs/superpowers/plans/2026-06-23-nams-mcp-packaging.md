# NAMS MCP Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the hosted NAMS MCP server as a separate OAuth-first `mcp` integration for Claude Code, Codex, Gemini CLI, and OpenCode inside the existing `nams-plugins` release.

**Architecture:** Keep `nams-hooks` unchanged as the deterministic hook runtime. Add declarative MCP-only templates and projections that point each supported platform at `https://memory.neo4jlabs.com/mcp`, with no copied runtime, no NAMS API key prompts, and no static authorization headers. Use existing template tests and `scripts/check-dist.mjs` to enforce marketplace shape and release separation.

**Tech Stack:** Node.js ESM build scripts using built-ins, JSON platform manifests/configs, TypeScript tests with Node's `node:test` runner through `tsx`, existing `npm run check` and `npm run package:check` verification.

---

## File Structure

- `docs/superpowers/specs/2026-06-23-nams-mcp-packaging-design.md`: approved design source for this plan.
- `templates/marketplace/claude/.claude-plugin/marketplace.json`: add a second marketplace plugin named `mcp`.
- `templates/marketplace/claude/plugins/claude-nams-mcp/.claude-plugin/plugin.json`: new Claude MCP-only plugin manifest.
- `templates/marketplace/codex/.agents/plugins/marketplace.json`: add a second marketplace plugin named `mcp`.
- `templates/marketplace/codex/plugins/codex-nams-mcp/.codex-plugin/plugin.json`: new Codex MCP-only plugin manifest.
- `templates/marketplace/gemini-mcp/gemini-extension.json`: new Gemini MCP-only extension metadata.
- `templates/marketplace/gemini-mcp/settings.json`: new Gemini MCP-only settings.
- `templates/local/gemini-mcp/.gemini/settings.json`: local Gemini MCP config fragment.
- `templates/marketplace/opencode-mcp/opencode.json`: new OpenCode MCP config fragment.
- `templates/local/opencode-mcp/opencode.json`: local OpenCode MCP config fragment.
- `test/claude-template.test.ts`: assert Claude marketplace and MCP plugin template shape.
- `test/codex-template.test.ts`: assert Codex marketplace and MCP plugin template shape.
- `test/gemini-template.test.ts`: assert Gemini MCP template shape and separation.
- `test/opencode-template.test.ts`: assert OpenCode MCP template shape and separation.
- `scripts/build-dist-marketplace.mjs`: project MCP-only marketplace templates into `dist-marketplace/`.
- `scripts/build-dist-local.mjs`: project MCP-only local config fragments into `dist-local/`.
- `scripts/check-dist.mjs`: verify generated MCP artifacts, absence of runtime copies, and OAuth-first config.
- `README.md`: add a short MCP install overview.
- `INSTALL.md`: add platform-specific MCP setup instructions.
- `DEVELOPMENT.md`: add local MCP artifact verification notes.

---

### Task 1: Claude MCP Marketplace Template

**Files:**
- Modify: `test/claude-template.test.ts`
- Modify: `templates/marketplace/claude/.claude-plugin/marketplace.json`
- Create: `templates/marketplace/claude/plugins/claude-nams-mcp/.claude-plugin/plugin.json`

- [ ] **Step 1: Add Claude MCP template tests**

Edit `test/claude-template.test.ts`. Add this constant beside the existing `pluginManifestPath` constant:

```ts
const claudeMcpManifestPath = "templates/marketplace/claude/plugins/claude-nams-mcp/.claude-plugin/plugin.json";
```

Replace the existing test named `Claude marketplace template exposes the nams-hooks plugin source` with this test:

```ts
test("Claude marketplace template exposes hooks and MCP plugins separately", async () => {
  const template = JSON.parse(await readFile(marketplacePath, "utf8"));

  assert.equal(template.name, "nams-plugins");
  assert.equal(template.metadata.version, "__PACKAGE_VERSION__");
  assert.equal(template.plugins.length, 2);

  const hooksPlugin = template.plugins.find((plugin: { name?: string }) => plugin.name === "nams-hooks");
  assert.equal(hooksPlugin.source, "./plugins/claude-nams-hooks");
  assert.equal(hooksPlugin.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(hooksPlugin.version, "__PACKAGE_VERSION__");
  assert.equal(hooksPlugin.license, "__PACKAGE_LICENSE__");

  const mcpPlugin = template.plugins.find((plugin: { name?: string }) => plugin.name === "mcp");
  assert.equal(mcpPlugin.source, "./plugins/claude-nams-mcp");
  assert.equal(mcpPlugin.description, "OAuth-first Neo4j Agent Memory Service MCP tools for Claude Code.");
  assert.equal(mcpPlugin.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(mcpPlugin.version, "__PACKAGE_VERSION__");
  assert.equal(mcpPlugin.license, "__PACKAGE_LICENSE__");
  assert.equal(mcpPlugin.category, "memory");
});
```

Add this new test after the existing Claude plugin manifest test:

```ts
test("Claude MCP plugin manifest template declares OAuth-first remote MCP only", async () => {
  const template = JSON.parse(await readFile(claudeMcpManifestPath, "utf8"));

  assert.equal(template.name, "mcp");
  assert.equal(template.version, "__PACKAGE_VERSION__");
  assert.equal(template.description, "OAuth-first Neo4j Agent Memory Service MCP tools for Claude Code.");
  assert.equal(template.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(template.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(template.mcpServers, {
    nams: {
      type: "http",
      url: "https://memory.neo4jlabs.com/mcp",
    },
  });
  assert.equal(Object.hasOwn(template, "hooks"), false);
  assert.equal(Object.hasOwn(template, "userConfig"), false);
  assert.doesNotMatch(JSON.stringify(template), /NAMS_API_KEY|Authorization|Bearer/);
});
```

- [ ] **Step 2: Run the focused Claude template test and verify it fails**

Run:

```bash
node --import=tsx --test test/claude-template.test.ts
```

Expected: FAIL because the marketplace has only one plugin and `templates/marketplace/claude/plugins/claude-nams-mcp/.claude-plugin/plugin.json` does not exist.

- [ ] **Step 3: Add the Claude marketplace `mcp` entry**

Edit `templates/marketplace/claude/.claude-plugin/marketplace.json` so its `plugins` array contains both existing `nams-hooks` entry and this second entry:

```json
    {
      "name": "mcp",
      "source": "./plugins/claude-nams-mcp",
      "description": "OAuth-first Neo4j Agent Memory Service MCP tools for Claude Code.",
      "version": "__PACKAGE_VERSION__",
      "author": {
        "name": "Neo4j Labs"
      },
      "repository": "https://github.com/neo4j-labs/nams-plugins",
      "license": "__PACKAGE_LICENSE__",
      "keywords": [
        "memory",
        "mcp",
        "neo4j",
        "nams"
      ],
      "category": "memory",
      "tags": [
        "memory",
        "mcp"
      ]
    }
```

Keep the existing `nams-hooks` entry unchanged.

- [ ] **Step 4: Create the Claude MCP plugin manifest**

Create `templates/marketplace/claude/plugins/claude-nams-mcp/.claude-plugin/plugin.json` with this exact content:

```json
{
  "name": "mcp",
  "version": "__PACKAGE_VERSION__",
  "description": "OAuth-first Neo4j Agent Memory Service MCP tools for Claude Code.",
  "author": {
    "name": "Neo4j Labs"
  },
  "repository": "https://github.com/neo4j-labs/nams-plugins",
  "license": "__PACKAGE_LICENSE__",
  "keywords": [
    "memory",
    "mcp",
    "neo4j",
    "nams"
  ],
  "mcpServers": {
    "nams": {
      "type": "http",
      "url": "https://memory.neo4jlabs.com/mcp"
    }
  }
}
```

- [ ] **Step 5: Run the focused Claude template test and verify it passes**

Run:

```bash
node --import=tsx --test test/claude-template.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the Claude MCP template**

Run:

```bash
git add test/claude-template.test.ts templates/marketplace/claude/.claude-plugin/marketplace.json templates/marketplace/claude/plugins/claude-nams-mcp/.claude-plugin/plugin.json
git commit -m "feat: add claude nams mcp marketplace template" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Codex MCP Marketplace Template

**Files:**
- Modify: `test/codex-template.test.ts`
- Modify: `templates/marketplace/codex/.agents/plugins/marketplace.json`
- Create: `templates/marketplace/codex/plugins/codex-nams-mcp/.codex-plugin/plugin.json`

- [ ] **Step 1: Add Codex MCP template tests**

Edit `test/codex-template.test.ts`. Add this constant beside `pluginManifestPath`:

```ts
const mcpPluginManifestPath = "templates/marketplace/codex/plugins/codex-nams-mcp/.codex-plugin/plugin.json";
```

Replace the existing test named `Codex repo marketplace template exposes nams-hooks as available` with this test:

```ts
test("Codex repo marketplace template exposes hooks and MCP plugins separately", async () => {
  const template = JSON.parse(await readFile(marketplacePath, "utf8"));

  assert.equal(template.name, "nams-plugins");
  assert.equal(template.metadata.description, "Neo4j Agent Memory Service hooks for Codex.");
  assert.equal(template.metadata.version, "__PACKAGE_VERSION__");
  assert.equal(template.plugins.length, 2);

  const hooksPlugin = template.plugins.find((plugin: { name?: string }) => plugin.name === "nams-hooks");
  assert.deepEqual(hooksPlugin.source, {
    source: "local",
    path: "./plugins/codex-nams-hooks",
  });
  assert.deepEqual(hooksPlugin.policy, {
    installation: "AVAILABLE",
    authentication: "ON_USE",
  });
  assert.equal(hooksPlugin.interface.displayName, "NAMS Hooks");
  assert.equal(hooksPlugin.description, "Persistent Neo4j Agent Memory Service hooks for Codex.");
  assert.equal(hooksPlugin.version, "__PACKAGE_VERSION__");
  assert.equal(hooksPlugin.author.name, "Neo4j Labs");
  assert.equal(hooksPlugin.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(hooksPlugin.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(hooksPlugin.keywords, ["memory", "context", "persistence", "neo4j", "nams"]);
  assert.equal(hooksPlugin.category, "Productivity");

  const mcpPlugin = template.plugins.find((plugin: { name?: string }) => plugin.name === "mcp");
  assert.deepEqual(mcpPlugin.source, {
    source: "local",
    path: "./plugins/codex-nams-mcp",
  });
  assert.deepEqual(mcpPlugin.policy, {
    installation: "AVAILABLE",
    authentication: "ON_USE",
  });
  assert.equal(mcpPlugin.interface.displayName, "NAMS MCP");
  assert.equal(mcpPlugin.description, "OAuth-first Neo4j Agent Memory Service MCP tools for Codex.");
  assert.equal(mcpPlugin.version, "__PACKAGE_VERSION__");
  assert.equal(mcpPlugin.author.name, "Neo4j Labs");
  assert.equal(mcpPlugin.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(mcpPlugin.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(mcpPlugin.keywords, ["memory", "mcp", "neo4j", "nams"]);
  assert.equal(mcpPlugin.category, "Productivity");
});
```

Add this new test after the existing Codex plugin manifest test:

```ts
test("Codex MCP plugin manifest template declares OAuth-first remote MCP only", async () => {
  const template = JSON.parse(await readFile(mcpPluginManifestPath, "utf8"));

  assert.equal(template.name, "mcp");
  assert.equal(template.version, "__PACKAGE_VERSION__");
  assert.equal(template.description, "OAuth-first Neo4j Agent Memory Service MCP tools for Codex.");
  assert.equal(template.author.name, "Neo4j Labs");
  assert.equal(template.repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(template.license, "__PACKAGE_LICENSE__");
  assert.deepEqual(template.keywords, ["memory", "mcp", "neo4j", "nams"]);
  assert.deepEqual(template.mcpServers, {
    nams: {
      url: "https://memory.neo4jlabs.com/mcp",
    },
  });
  assert.equal(Object.hasOwn(template, "hooks"), false);
  assert.equal(Object.hasOwn(template, "skills"), false);
  assert.equal(Object.hasOwn(template, "userConfig"), false);
  assert.equal(Object.hasOwn(template, "authentication"), false);
  assert.doesNotMatch(JSON.stringify(template), /NAMS_API_KEY|Authorization|Bearer/);
});
```

- [ ] **Step 2: Run the focused Codex template test and verify it fails**

Run:

```bash
node --import=tsx --test test/codex-template.test.ts
```

Expected: FAIL because the marketplace has only one plugin and `templates/marketplace/codex/plugins/codex-nams-mcp/.codex-plugin/plugin.json` does not exist.

- [ ] **Step 3: Add the Codex marketplace `mcp` entry**

Edit `templates/marketplace/codex/.agents/plugins/marketplace.json` so its `plugins` array contains both the existing `nams-hooks` entry and this second entry:

```json
    {
      "name": "mcp",
      "source": {
        "source": "local",
        "path": "./plugins/codex-nams-mcp"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_USE"
      },
      "interface": {
        "displayName": "NAMS MCP"
      },
      "description": "OAuth-first Neo4j Agent Memory Service MCP tools for Codex.",
      "version": "__PACKAGE_VERSION__",
      "author": {
        "name": "Neo4j Labs"
      },
      "repository": "https://github.com/neo4j-labs/nams-plugins",
      "license": "__PACKAGE_LICENSE__",
      "keywords": [
        "memory",
        "mcp",
        "neo4j",
        "nams"
      ],
      "category": "Productivity"
    }
```

Keep the existing `nams-hooks` entry unchanged.

- [ ] **Step 4: Create the Codex MCP plugin manifest**

Create `templates/marketplace/codex/plugins/codex-nams-mcp/.codex-plugin/plugin.json` with this exact content:

```json
{
  "name": "mcp",
  "version": "__PACKAGE_VERSION__",
  "description": "OAuth-first Neo4j Agent Memory Service MCP tools for Codex.",
  "author": {
    "name": "Neo4j Labs"
  },
  "repository": "https://github.com/neo4j-labs/nams-plugins",
  "license": "__PACKAGE_LICENSE__",
  "keywords": [
    "memory",
    "mcp",
    "neo4j",
    "nams"
  ],
  "mcpServers": {
    "nams": {
      "url": "https://memory.neo4jlabs.com/mcp"
    }
  }
}
```

- [ ] **Step 5: Run the focused Codex template test and verify it passes**

Run:

```bash
node --import=tsx --test test/codex-template.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the Codex MCP template**

Run:

```bash
git add test/codex-template.test.ts templates/marketplace/codex/.agents/plugins/marketplace.json templates/marketplace/codex/plugins/codex-nams-mcp/.codex-plugin/plugin.json
git commit -m "feat: add codex nams mcp marketplace template" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Gemini MCP Config Templates

**Files:**
- Modify: `test/gemini-template.test.ts`
- Create: `templates/marketplace/gemini-mcp/gemini-extension.json`
- Create: `templates/marketplace/gemini-mcp/settings.json`
- Create: `templates/local/gemini-mcp/.gemini/settings.json`

- [ ] **Step 1: Add Gemini MCP template tests**

Edit `test/gemini-template.test.ts`. Add these constants near the existing marketplace constants:

```ts
const marketplaceMcpExtensionPath = path.join(repoRoot, "templates", "marketplace", "gemini-mcp", "gemini-extension.json");
const marketplaceMcpSettingsPath = path.join(repoRoot, "templates", "marketplace", "gemini-mcp", "settings.json");
const localMcpSettingsPath = path.join(repoRoot, "templates", "local", "gemini-mcp", ".gemini", "settings.json");
```

Add these tests after `Gemini extension template exposes NAMS environment settings in order`:

```ts
test("Gemini MCP marketplace template is separate from nams-hooks extension", async () => {
  const extension = JSON.parse(await readFile(marketplaceMcpExtensionPath, "utf8"));
  const settings = JSON.parse(await readFile(marketplaceMcpSettingsPath, "utf8"));

  assert.equal(extension.name, "nams-mcp");
  assert.equal(extension.version, "__PACKAGE_VERSION__");
  assert.equal(extension.description, "OAuth-first Neo4j Agent Memory Service MCP tools for Gemini CLI.");
  assert.equal(Object.hasOwn(extension, "settings"), false);
  assert.deepEqual(settings, {
    mcpServers: {
      nams: {
        httpUrl: "https://memory.neo4jlabs.com/mcp",
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(settings), /NAMS_API_KEY|Authorization|Bearer|hooks|commands/);
});

test("Gemini MCP local template is a settings-only config fragment", async () => {
  const settings = JSON.parse(await readFile(localMcpSettingsPath, "utf8"));

  assert.deepEqual(settings, {
    mcpServers: {
      nams: {
        httpUrl: "https://memory.neo4jlabs.com/mcp",
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(settings), /NAMS_API_KEY|Authorization|Bearer|hooks|commands/);
});
```

- [ ] **Step 2: Run the focused Gemini template test and verify it fails**

Run:

```bash
node --import=tsx --test test/gemini-template.test.ts
```

Expected: FAIL because the `templates/marketplace/gemini-mcp/` and `templates/local/gemini-mcp/` files do not exist.

- [ ] **Step 3: Create Gemini MCP marketplace extension metadata**

Create `templates/marketplace/gemini-mcp/gemini-extension.json` with this exact content:

```json
{
  "name": "nams-mcp",
  "version": "__PACKAGE_VERSION__",
  "description": "OAuth-first Neo4j Agent Memory Service MCP tools for Gemini CLI."
}
```

- [ ] **Step 4: Create Gemini MCP marketplace settings**

Create `templates/marketplace/gemini-mcp/settings.json` with this exact content:

```json
{
  "mcpServers": {
    "nams": {
      "httpUrl": "https://memory.neo4jlabs.com/mcp"
    }
  }
}
```

- [ ] **Step 5: Create Gemini MCP local settings**

Create `templates/local/gemini-mcp/.gemini/settings.json` with this exact content:

```json
{
  "mcpServers": {
    "nams": {
      "httpUrl": "https://memory.neo4jlabs.com/mcp"
    }
  }
}
```

- [ ] **Step 6: Run the focused Gemini template test and verify it passes**

Run:

```bash
node --import=tsx --test test/gemini-template.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the Gemini MCP templates**

Run:

```bash
git add test/gemini-template.test.ts templates/marketplace/gemini-mcp/gemini-extension.json templates/marketplace/gemini-mcp/settings.json templates/local/gemini-mcp/.gemini/settings.json
git commit -m "feat: add gemini nams mcp config templates" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: OpenCode MCP Config Templates

**Files:**
- Modify: `test/opencode-template.test.ts`
- Create: `templates/marketplace/opencode-mcp/opencode.json`
- Create: `templates/local/opencode-mcp/opencode.json`

- [ ] **Step 1: Add OpenCode MCP template tests**

Edit `test/opencode-template.test.ts`. Add these constants after `repoRoot`:

```ts
const marketplaceMcpConfigPath = path.join(repoRoot, "templates", "marketplace", "opencode-mcp", "opencode.json");
const localMcpConfigPath = path.join(repoRoot, "templates", "local", "opencode-mcp", "opencode.json");
```

Add these tests after `opencode template does not package workspace command markdown prompt`:

```ts
test("opencode MCP marketplace template is a remote OAuth config fragment", async () => {
  const config = JSON.parse(await readFile(marketplaceMcpConfigPath, "utf8"));

  assert.deepEqual(config, {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      nams: {
        type: "remote",
        url: "https://memory.neo4jlabs.com/mcp",
        enabled: true,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(config), /NAMS_API_KEY|Authorization|Bearer|nams-hooks|nams-hooks\.js/);
});

test("opencode MCP local template is a remote OAuth config fragment", async () => {
  const config = JSON.parse(await readFile(localMcpConfigPath, "utf8"));

  assert.deepEqual(config, {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      nams: {
        type: "remote",
        url: "https://memory.neo4jlabs.com/mcp",
        enabled: true,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(config), /NAMS_API_KEY|Authorization|Bearer|nams-hooks|nams-hooks\.js/);
});
```

- [ ] **Step 2: Run the focused OpenCode template test and verify it fails**

Run:

```bash
node --import=tsx --test test/opencode-template.test.ts
```

Expected: FAIL because the `templates/marketplace/opencode-mcp/` and `templates/local/opencode-mcp/` files do not exist.

- [ ] **Step 3: Create OpenCode MCP marketplace config**

Create `templates/marketplace/opencode-mcp/opencode.json` with this exact content:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "nams": {
      "type": "remote",
      "url": "https://memory.neo4jlabs.com/mcp",
      "enabled": true
    }
  }
}
```

- [ ] **Step 4: Create OpenCode MCP local config**

Create `templates/local/opencode-mcp/opencode.json` with this exact content:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "nams": {
      "type": "remote",
      "url": "https://memory.neo4jlabs.com/mcp",
      "enabled": true
    }
  }
}
```

- [ ] **Step 5: Run the focused OpenCode template test and verify it passes**

Run:

```bash
node --import=tsx --test test/opencode-template.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the OpenCode MCP templates**

Run:

```bash
git add test/opencode-template.test.ts templates/marketplace/opencode-mcp/opencode.json templates/local/opencode-mcp/opencode.json
git commit -m "feat: add opencode nams mcp config templates" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: MCP Projection Scripts And Generated Artifact Checks

**Files:**
- Modify: `scripts/build-dist-marketplace.mjs`
- Modify: `scripts/build-dist-local.mjs`
- Modify: `scripts/check-dist.mjs`

- [ ] **Step 1: Add failing generated-artifact checks**

Edit `scripts/check-dist.mjs`. In `verifyMarketplaceDist()`, add this call after `await verifyOpenCodeMarketplaceFiles();`:

```js
  await verifyMcpMarketplaceFiles();
```

In `verifyLocalDist()`, add this call after the OpenCode local plugin check:

```js
  await verifyLocalMcpFiles();
```

Add these functions after `verifyOpenCodeMarketplaceFiles()`:

```js
async function verifyMcpMarketplaceFiles() {
  await verifyClaudeMcpMarketplaceFiles();
  await verifyCodexMcpMarketplaceFiles();
  await verifyGeminiMcpMarketplaceFiles();
  await verifyOpenCodeMcpMarketplaceFiles();
}

async function verifyClaudeMcpMarketplaceFiles() {
  const marketplacePath = path.join(marketplaceDistDir, ".claude-plugin", "marketplace.json");
  const manifestPath = path.join(marketplaceDistDir, "plugins", "claude-nams-mcp", ".claude-plugin", "plugin.json");

  await access(manifestPath);

  const packageJson = JSON.parse(await readFile(rootPackagePath, "utf8"));
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  const plugin = JSON.parse(await readFile(manifestPath, "utf8"));
  const marketplacePlugin = marketplace.plugins?.find((entry) => entry?.name === "mcp");

  if (marketplacePlugin?.source !== "./plugins/claude-nams-mcp") {
    throw new Error("Claude marketplace must expose mcp from ./plugins/claude-nams-mcp.");
  }
  if (marketplacePlugin.version !== packageJson.version || marketplacePlugin.license !== packageJson.license) {
    throw new Error("Claude MCP marketplace plugin version and license must match package.json.");
  }
  if (plugin.name !== "mcp" || plugin.version !== packageJson.version) {
    throw new Error("Claude MCP plugin manifest must name mcp and match package.json version.");
  }
  assertOAuthFirstMcpServer(plugin.mcpServers?.nams, "Claude MCP");
  assertNoMcpRuntime(path.join(marketplaceDistDir, "plugins", "claude-nams-mcp"), "Claude MCP");
  assertNoStaticMcpSecrets(plugin, "Claude MCP");
  if (Object.hasOwn(plugin, "hooks") || Object.hasOwn(plugin, "userConfig")) {
    throw new Error("Claude MCP plugin must not define hooks or userConfig.");
  }
}

async function verifyCodexMcpMarketplaceFiles() {
  const marketplacePath = path.join(marketplaceDistDir, ".agents", "plugins", "marketplace.json");
  const manifestPath = path.join(marketplaceDistDir, "plugins", "codex-nams-mcp", ".codex-plugin", "plugin.json");

  await access(manifestPath);

  const packageJson = JSON.parse(await readFile(rootPackagePath, "utf8"));
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  const plugin = JSON.parse(await readFile(manifestPath, "utf8"));
  const marketplacePlugin = marketplace.plugins?.find((entry) => entry?.name === "mcp");

  if (marketplacePlugin?.source?.source !== "local" || marketplacePlugin.source?.path !== "./plugins/codex-nams-mcp") {
    throw new Error("Codex marketplace must expose mcp from ./plugins/codex-nams-mcp.");
  }
  if (marketplacePlugin.policy?.installation !== "AVAILABLE" || marketplacePlugin.policy?.authentication !== "ON_USE") {
    throw new Error("Codex MCP marketplace plugin must be available with authentication ON_USE.");
  }
  if (marketplacePlugin.version !== packageJson.version || marketplacePlugin.license !== packageJson.license) {
    throw new Error("Codex MCP marketplace plugin version and license must match package.json.");
  }
  if (plugin.name !== "mcp" || plugin.version !== packageJson.version) {
    throw new Error("Codex MCP plugin manifest must name mcp and match package.json version.");
  }
  assertOAuthFirstMcpServer(plugin.mcpServers?.nams, "Codex MCP");
  assertNoMcpRuntime(path.join(marketplaceDistDir, "plugins", "codex-nams-mcp"), "Codex MCP");
  assertNoStaticMcpSecrets(plugin, "Codex MCP");
  if (Object.hasOwn(plugin, "hooks") || Object.hasOwn(plugin, "skills") || Object.hasOwn(plugin, "userConfig") || Object.hasOwn(plugin, "authentication")) {
    throw new Error("Codex MCP plugin must not define hooks, skills, userConfig, or authentication.");
  }
}

async function verifyGeminiMcpMarketplaceFiles() {
  const extensionPath = path.join(marketplaceDistDir, "gemini-mcp", "gemini-extension.json");
  const settingsPath = path.join(marketplaceDistDir, "gemini-mcp", "settings.json");

  await access(extensionPath);
  await access(settingsPath);

  const packageJson = JSON.parse(await readFile(rootPackagePath, "utf8"));
  const extension = JSON.parse(await readFile(extensionPath, "utf8"));
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));

  if (extension.name !== "nams-mcp" || extension.version !== packageJson.version) {
    throw new Error("Gemini MCP extension must name nams-mcp and match package.json version.");
  }
  assertGeminiOAuthFirstMcpServer(settings.mcpServers?.nams, "Gemini MCP");
  assertNoMcpRuntime(path.join(marketplaceDistDir, "gemini-mcp"), "Gemini MCP");
  assertNoStaticMcpSecrets(settings, "Gemini MCP");
  if (Object.hasOwn(settings, "hooks") || Object.hasOwn(settings, "commands")) {
    throw new Error("Gemini MCP settings must not define hooks or commands.");
  }
}

async function verifyOpenCodeMcpMarketplaceFiles() {
  const configPath = path.join(marketplaceDistDir, "opencode-mcp", "opencode.json");

  await access(configPath);

  const config = JSON.parse(await readFile(configPath, "utf8"));
  assertOpenCodeOAuthFirstMcpServer(config.mcp?.nams, "OpenCode MCP");
  assertNoMcpRuntime(path.join(marketplaceDistDir, "opencode-mcp"), "OpenCode MCP");
  assertNoStaticMcpSecrets(config, "OpenCode MCP");
}

async function verifyLocalMcpFiles() {
  const geminiSettingsPath = path.join(localDistDir, "gemini-mcp", ".gemini", "settings.json");
  const opencodeConfigPath = path.join(localDistDir, "opencode-mcp", "opencode.json");

  await access(geminiSettingsPath);
  await access(opencodeConfigPath);

  const geminiSettings = JSON.parse(await readFile(geminiSettingsPath, "utf8"));
  const opencodeConfig = JSON.parse(await readFile(opencodeConfigPath, "utf8"));

  assertGeminiOAuthFirstMcpServer(geminiSettings.mcpServers?.nams, "local Gemini MCP");
  assertOpenCodeOAuthFirstMcpServer(opencodeConfig.mcp?.nams, "local OpenCode MCP");
  assertNoStaticMcpSecrets(geminiSettings, "local Gemini MCP");
  assertNoStaticMcpSecrets(opencodeConfig, "local OpenCode MCP");
}

function assertOAuthFirstMcpServer(server, label) {
  if (server?.url !== "https://memory.neo4jlabs.com/mcp") {
    throw new Error(`${label} must point at https://memory.neo4jlabs.com/mcp.`);
  }
  if (server.type !== undefined && server.type !== "http") {
    throw new Error(`${label} must use http type when a type is declared.`);
  }
  if (Object.hasOwn(server, "headers") || Object.hasOwn(server, "http_headers") || Object.hasOwn(server, "bearer_token_env_var")) {
    throw new Error(`${label} must not configure static MCP authorization headers.`);
  }
}

function assertGeminiOAuthFirstMcpServer(server, label) {
  if (server?.httpUrl !== "https://memory.neo4jlabs.com/mcp") {
    throw new Error(`${label} must point at https://memory.neo4jlabs.com/mcp.`);
  }
  if (Object.hasOwn(server, "headers") || Object.hasOwn(server, "httpHeaders") || Object.hasOwn(server, "oauth")) {
    throw new Error(`${label} must not configure static MCP authorization headers.`);
  }
}

function assertOpenCodeOAuthFirstMcpServer(server, label) {
  if (server?.type !== "remote" || server.url !== "https://memory.neo4jlabs.com/mcp" || server.enabled !== true) {
    throw new Error(`${label} must declare enabled remote MCP at https://memory.neo4jlabs.com/mcp.`);
  }
  if (Object.hasOwn(server, "headers") || Object.hasOwn(server, "authorization") || Object.hasOwn(server, "bearerToken")) {
    throw new Error(`${label} must not configure static MCP authorization headers.`);
  }
}

async function assertNoMcpRuntime(rootPath, label) {
  const files = await listFiles(rootPath);
  if (files.some((file) => /^bin\/cli\.js$/.test(file) || /^package\.json$/.test(file))) {
    throw new Error(`${label} must not include copied runtime or package metadata.`);
  }
}

function assertNoStaticMcpSecrets(value, label) {
  if (/NAMS_API_KEY|Authorization|Bearer/.test(JSON.stringify(value))) {
    throw new Error(`${label} must not include static credential configuration.`);
  }
}
```

- [ ] **Step 2: Build current dist trees and verify the new check fails**

Run:

```bash
npm run dist
node scripts/check-dist.mjs
```

Expected: `npm run dist` succeeds, then `node scripts/check-dist.mjs` fails because `dist-marketplace/plugins/claude-nams-mcp/.claude-plugin/plugin.json` and the other MCP generated artifacts do not exist.

- [ ] **Step 3: Project MCP marketplace templates**

Edit `scripts/build-dist-marketplace.mjs`. Add these projection entries after the existing Claude, Codex, Gemini, and OpenCode hook projections are present:

```js
  { kind: "template", platform: "claude", from: "templates/marketplace/claude/plugins/claude-nams-mcp", to: "plugins/claude-nams-mcp", renderPackage: true },
  { kind: "template", platform: "codex", from: "templates/marketplace/codex/plugins/codex-nams-mcp", to: "plugins/codex-nams-mcp", renderPackage: true },
  { kind: "template", platform: "gemini-mcp", from: "templates/marketplace/gemini-mcp", to: "gemini-mcp", renderPackage: true },
  { kind: "template", platform: "opencode-mcp", from: "templates/marketplace/opencode-mcp", to: "opencode-mcp", renderPackage: false },
```

Do not add `packageJson` or `runtime` projections for MCP directories.

- [ ] **Step 4: Project MCP local templates**

Edit `scripts/build-dist-local.mjs`. Add these projection entries before the OpenCode hook shim projection or after it:

```js
  { kind: "template", platform: "gemini-mcp", from: "templates/local/gemini-mcp", to: "gemini-mcp", renderPackage: false },
  { kind: "template", platform: "opencode-mcp", from: "templates/local/opencode-mcp", to: "opencode-mcp", renderPackage: false },
```

Do not add runtime projections for MCP directories.

- [ ] **Step 5: Build dist trees and verify generated-artifact checks pass**

Run:

```bash
npm run dist
node scripts/check-dist.mjs
```

Expected: both commands exit 0.

- [ ] **Step 6: Run the full package check**

Run:

```bash
npm run package:check
```

Expected: PASS, including `npm run check`, `npm run dist`, and `node scripts/check-dist.mjs`.

- [ ] **Step 7: Commit projections and generated-artifact checks**

Run:

```bash
git add scripts/build-dist-marketplace.mjs scripts/build-dist-local.mjs scripts/check-dist.mjs
git commit -m "test: verify nams mcp distribution artifacts" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 6: MCP Documentation

**Files:**
- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `DEVELOPMENT.md`

- [ ] **Step 1: Update README with MCP overview**

Edit `README.md`. After the existing Codex section and before the OpenCode section, add:

````md
### NAMS MCP

`nams-plugins` also ships a separate OAuth-first MCP integration for the hosted
NAMS MCP server at `https://memory.neo4jlabs.com/mcp`. Install it separately
from `nams-hooks` when you want agent-controlled NAMS tools in addition to, or
instead of, deterministic hook persistence.

Claude Code installs the MCP plugin from the same marketplace:

```bash
claude plugin marketplace add neo4j-labs/nams-plugins@latest
claude plugin install mcp@nams-plugins
```

Codex users add the same marketplace, then install `NAMS MCP` from `/plugins`.
Gemini CLI and OpenCode use the generated MCP config artifacts described in
`INSTALL.md`.
````

- [ ] **Step 2: Update INSTALL with platform MCP instructions**

Edit `INSTALL.md`. After the existing Codex section and before the Gemini CLI section, add:

````md
## NAMS MCP

The hosted NAMS MCP server is packaged separately from `nams-hooks`. Use it when
you want platform-native MCP tools backed by Neo4j Agent Memory Service. The
generated MCP artifacts are OAuth-first and do not include static
`Authorization` headers or `NAMS_API_KEY` prompts.

### Claude Code MCP

```bash
claude plugin marketplace add neo4j-labs/nams-plugins@latest
claude plugin install mcp@nams-plugins
```

On first MCP use, Claude Code starts its native OAuth flow for the NAMS MCP
server.

### Codex MCP

```bash
codex plugin marketplace add neo4j-labs/nams-plugins@latest
```

Restart Codex, open `/plugins`, select the `nams-plugins` marketplace, and
install `NAMS MCP`. Use `/mcp` in Codex to inspect the connected server.

### Gemini CLI MCP

The v1 generated artifact is an MCP-only config root:

```text
dist-marketplace/gemini-mcp/
```

Link or copy that directory as a separate Gemini extension/config root. It
declares:

```json
{
  "mcpServers": {
    "nams": {
      "httpUrl": "https://memory.neo4jlabs.com/mcp"
    }
  }
}
```

The later `npx @neo4j-labs/nams-plugins install mcp` workstream will provide a
one-command Gemini setup.

### OpenCode MCP

The v1 generated artifact is a mergeable `opencode.json` fragment:

```text
dist-marketplace/opencode-mcp/opencode.json
```

Merge its `mcp.nams` entry into your project or user `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "nams": {
      "type": "remote",
      "url": "https://memory.neo4jlabs.com/mcp",
      "enabled": true
    }
  }
}
```

The later `npx @neo4j-labs/nams-plugins install mcp` workstream will provide a
safe config merge command.
````

- [ ] **Step 3: Update DEVELOPMENT with local MCP artifact checks**

Edit `DEVELOPMENT.md`. After the section that describes validating `dist-marketplace`, add:

````md
### MCP packaging checks

The MCP integration is declarative and separate from `nams-hooks`. After
running `npm run dist`, check these generated files when changing MCP
packaging:

```text
dist-marketplace/plugins/claude-nams-mcp/.claude-plugin/plugin.json
dist-marketplace/plugins/codex-nams-mcp/.codex-plugin/plugin.json
dist-marketplace/gemini-mcp/settings.json
dist-marketplace/opencode-mcp/opencode.json
dist-local/gemini-mcp/.gemini/settings.json
dist-local/opencode-mcp/opencode.json
```

MCP artifacts must point at `https://memory.neo4jlabs.com/mcp`, must not include
`Authorization` headers or `NAMS_API_KEY`, and must not include copied
`bin/cli.js` runtime files.
````

- [ ] **Step 4: Run docs-free verification commands**

Run:

```bash
npm run check
npm run package:check
```

Expected: both commands exit 0. Documentation content is not asserted by tests, matching the repository testing rule that docs content should not be tested.

- [ ] **Step 5: Commit documentation**

Run:

```bash
git add README.md INSTALL.md DEVELOPMENT.md
git commit -m "docs: document nams mcp packaging" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 7: Final Verification And Review Handoff

**Files:**
- Inspect: all files changed by Tasks 1-6

- [ ] **Step 1: Verify no unintended runtime changes**

Run:

```bash
git diff --name-only devel HEAD
```

Expected: output includes template, test, docs, and build/check script files only. It must not include `src/`, `src/generated/`, or runtime platform files.

- [ ] **Step 2: Run final verification**

Run:

```bash
npm run check
npm run package:check
```

Expected: both commands exit 0.

- [ ] **Step 3: Inspect generated MCP artifacts**

Run:

```bash
npm run dist
find dist-marketplace -path '*claude-nams-mcp*' -print -o -path '*codex-nams-mcp*' -print -o -path '*gemini-mcp*' -print -o -path '*opencode-mcp*' -print
```

Expected output includes:

```text
dist-marketplace/plugins/claude-nams-mcp/.claude-plugin/plugin.json
dist-marketplace/plugins/codex-nams-mcp/.codex-plugin/plugin.json
dist-marketplace/gemini-mcp/gemini-extension.json
dist-marketplace/gemini-mcp/settings.json
dist-marketplace/opencode-mcp/opencode.json
```

- [ ] **Step 4: Inspect for static MCP credentials**

Run:

```bash
rg -n "NAMS_API_KEY|Authorization|Bearer" templates/marketplace/claude/plugins/claude-nams-mcp templates/marketplace/codex/plugins/codex-nams-mcp templates/marketplace/gemini-mcp templates/marketplace/opencode-mcp templates/local/gemini-mcp templates/local/opencode-mcp dist-marketplace/gemini-mcp dist-marketplace/opencode-mcp
```

Expected: no matches.

- [ ] **Step 5: Confirm worktree status**

Run:

```bash
git status --short
```

Expected: no output.

- [ ] **Step 6: Report implementation summary**

Report:

```text
Implemented separate OAuth-first NAMS MCP packaging for Claude, Codex, Gemini, and OpenCode.
Verification: npm run check and npm run package:check both passed.
Generated MCP artifacts contain no copied runtime and no static MCP credentials.
```
