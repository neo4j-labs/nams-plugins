# NAMS Plugins Umbrella Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move repository, package, and marketplace identity to `nams-plugins` while preserving `nams-hooks` as the hooks plugin and CLI executable.

**Architecture:** This is an identity-only migration across package metadata, marketplace templates, verification checks, and user-facing docs. Runtime TypeScript behavior, hook commands, platform adapters, NAMS configuration, state, logs, and generated `dist/` editing remain unchanged. `dist/` must be regenerated through `npm run dist` as part of `npm run package:check`.

**Tech Stack:** Node.js 20+, TypeScript, Node's built-in `node:test`, npm package metadata, Claude Code plugin marketplace templates, Codex repo marketplace templates, Markdown docs.

---

## File Structure

- Modify `package.json`: rename the npm package to `@neo4j-labs/nams-plugins`; keep `bin.nams-hooks`.
- Modify `package-lock.json`: keep the lockfile root package name in sync with `package.json`; keep `packages[""].bin.nams-hooks`.
- Create `test/package-metadata.test.ts`: enforce package name and executable identity.
- Modify `test/claude-template.test.js`: enforce Claude marketplace name `nams-plugins`, plugin name `nams-hooks`, and repository URL `https://github.com/neo4j-labs/nams-plugins`.
- Modify `test/codex-template.test.ts`: enforce Codex marketplace name `nams-plugins`, plugin name `nams-hooks`, and repository URL `https://github.com/neo4j-labs/nams-plugins`.
- Modify `scripts/check-dist.mjs`: enforce generated package and marketplace identity in release artifacts.
- Modify `templates/claude/.claude-plugin/marketplace.json`: rename the marketplace and repository metadata.
- Modify `templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json`: update repository metadata; keep plugin name.
- Modify `templates/codex/.agents/plugins/marketplace.json`: rename the marketplace and repository metadata.
- Modify `templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json`: update repository metadata; keep plugin name.
- Modify `README.md`: update the primary Claude installation example.
- Modify `INSTALL.md`: update Claude, Codex, and Gemini release install commands and marketplace references.
- Modify `DEVELOPMENT.md`: update local marketplace selection/install text and the global package name.
- Modify `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`: update active source-of-truth distribution examples and package references.
- Modify `docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md`: update the active Codex marketplace design references.

### Task 1: Write Red Identity Tests

**Files:**
- Create: `test/package-metadata.test.ts`
- Modify: `test/claude-template.test.js`
- Modify: `test/codex-template.test.ts`

- [ ] **Step 1: Add package metadata tests**

Create `test/package-metadata.test.ts` with:

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

test("package lock root package matches package metadata", async () => {
  const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));

  assert.equal(packageLock.name, "@neo4j-labs/nams-plugins");
  assert.equal(packageLock.packages[""].name, "@neo4j-labs/nams-plugins");
  assert.deepEqual(packageLock.packages[""].bin, {
    "nams-hooks": "dist/bin/cli.js",
  });
});
```

- [ ] **Step 2: Update Claude template expectations**

In `test/claude-template.test.js`, update the marketplace test to assert the new marketplace and repository identity:

```js
test("Claude marketplace template exposes the nams-hooks plugin source", async () => {
  const template = JSON.parse(await readFile("templates/claude/.claude-plugin/marketplace.json", "utf8"));

  assert.equal(template.name, "nams-plugins");
  assert.equal(template.metadata.version, "__PACKAGE_VERSION__");
  assert.equal(template.plugins[0].name, "nams-hooks");
  assert.equal(template.plugins[0].source, "./plugins/nams-hooks");
  assert.equal(template.plugins[0].repository, "https://github.com/neo4j-labs/nams-plugins");
  assert.equal(template.plugins[0].version, "__PACKAGE_VERSION__");
  assert.equal(template.plugins[0].license, "__PACKAGE_LICENSE__");
});
```

In the Claude plugin manifest test, add repository identity after the license assertion:

```js
  assert.equal(template.repository, "https://github.com/neo4j-labs/nams-plugins");
```

- [ ] **Step 3: Update Codex template expectations**

In `test/codex-template.test.ts`, update the Codex marketplace name and repository assertions:

```ts
  assert.equal(template.name, "nams-plugins");
```

```ts
  assert.equal(plugin.repository, "https://github.com/neo4j-labs/nams-plugins");
```

```ts
  assert.equal(template.repository, "https://github.com/neo4j-labs/nams-plugins");
```

- [ ] **Step 4: Run targeted tests to verify red**

Run:

```bash
node --import=tsx --test test/package-metadata.test.ts test/claude-template.test.js test/codex-template.test.ts
```

Expected: FAIL. The failures should mention the current legacy package,
marketplace, or repository values.

### Task 2: Update Package And Marketplace Metadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `templates/claude/.claude-plugin/marketplace.json`
- Modify: `templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json`
- Modify: `templates/codex/.agents/plugins/marketplace.json`
- Modify: `templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json`

- [ ] **Step 1: Rename the npm package and keep the executable**

In `package.json`, change only the package `name`. Keep `bin.nams-hooks` unchanged:

```json
{
  "name": "@neo4j-labs/nams-plugins",
  "version": "0.1.0",
  "description": "Neo4j Agent Memory Service hooks for agent harnesses.",
  "type": "module",
  "bin": {
    "nams-hooks": "./dist/bin/cli.js"
  }
}
```

The rest of `package.json` stays as it is.

- [ ] **Step 2: Update the lockfile root package name**

In `package-lock.json`, update the root package name in both places and keep the existing root `bin` value:

```json
{
  "name": "@neo4j-labs/nams-plugins",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "@neo4j-labs/nams-plugins",
      "version": "0.1.0",
      "license": "Apache-2.0",
      "bin": {
        "nams-hooks": "dist/bin/cli.js"
      }
    }
  }
}
```

Do not change dependency versions, integrity hashes, or package entries under `node_modules/`.

- [ ] **Step 3: Update Claude marketplace template**

In `templates/claude/.claude-plugin/marketplace.json`, change the marketplace name and plugin repository:

```json
{
  "name": "nams-plugins",
  "plugins": [
    {
      "name": "nams-hooks",
      "source": "./plugins/nams-hooks",
      "repository": "https://github.com/neo4j-labs/nams-plugins"
    }
  ]
}
```

Keep the existing owner, metadata, description, version placeholder, license placeholder, keywords, category, and tags.

- [ ] **Step 4: Update Claude plugin manifest repository**

In `templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json`, keep `"name": "nams-hooks"` and change only the repository URL:

```json
{
  "name": "nams-hooks",
  "repository": "https://github.com/neo4j-labs/nams-plugins"
}
```

Keep the current `userConfig` block unchanged.

- [ ] **Step 5: Update Codex marketplace template**

In `templates/codex/.agents/plugins/marketplace.json`, change the marketplace name and plugin repository:

```json
{
  "name": "nams-plugins",
  "plugins": [
    {
      "name": "nams-hooks",
      "source": {
        "source": "local",
        "path": "./plugins/codex-nams-hooks"
      },
      "repository": "https://github.com/neo4j-labs/nams-plugins"
    }
  ]
}
```

Keep the current policy, interface, description, version placeholder, license placeholder, keywords, and category.

- [ ] **Step 6: Update Codex plugin manifest repository**

In `templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json`, keep `"name": "nams-hooks"` and change only the repository URL:

```json
{
  "name": "nams-hooks",
  "repository": "https://github.com/neo4j-labs/nams-plugins"
}
```

- [ ] **Step 7: Run the targeted tests to verify green**

Run:

```bash
node --import=tsx --test test/package-metadata.test.ts test/claude-template.test.js test/codex-template.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit metadata and template changes**

Run:

```bash
git add package.json package-lock.json test/package-metadata.test.ts test/claude-template.test.js test/codex-template.test.ts templates/claude/.claude-plugin/marketplace.json templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json templates/codex/.agents/plugins/marketplace.json templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json
git commit -m "chore: rename release package to nams-plugins" -m "Co-authored-by: Codex <codex@openai.com>"
```

### Task 3: Update Distribution Checks

**Files:**
- Modify: `scripts/check-dist.mjs`

- [ ] **Step 1: Add package identity checks**

In `scripts/check-dist.mjs`, after `await verifyRootPackageFiles(rootPackagePath);`, add a source package identity check:

```js
await verifySourcePackageIdentity(rootPackagePath);
```

Add this function near the other verification helpers:

```js
async function verifySourcePackageIdentity(packagePath) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (packageJson.name !== "@neo4j-labs/nams-plugins") {
    throw new Error("package.json name must be @neo4j-labs/nams-plugins.");
  }
  if (packageJson.bin?.["nams-hooks"] !== "./dist/bin/cli.js") {
    throw new Error("package.json must expose the nams-hooks executable at ./dist/bin/cli.js.");
  }
}
```

- [ ] **Step 2: Update Claude generated marketplace checks**

In `verifyClaudePluginFiles()`, change the marketplace name assertion to:

```js
  if (marketplace.name !== "nams-plugins") {
    throw new Error("dist/.claude-plugin/marketplace.json must name the marketplace nams-plugins.");
  }
```

After the existing Claude marketplace source assertion, add:

```js
  if (marketplace.plugins[0].repository !== "https://github.com/neo4j-labs/nams-plugins") {
    throw new Error("Claude marketplace plugin repository must point to neo4j-labs/nams-plugins.");
  }
  if (plugin.repository !== "https://github.com/neo4j-labs/nams-plugins") {
    throw new Error("Claude plugin manifest repository must point to neo4j-labs/nams-plugins.");
  }
```

- [ ] **Step 3: Update Codex generated marketplace checks**

In `verifyCodexPluginFiles()`, change the marketplace name assertion to:

```js
  if (marketplace.name !== "nams-plugins") {
    throw new Error("dist/.agents/plugins/marketplace.json must name the marketplace nams-plugins.");
  }
```

After the existing Codex marketplace plugin source assertion, add:

```js
  if (marketplacePlugin.repository !== "https://github.com/neo4j-labs/nams-plugins") {
    throw new Error("Codex marketplace plugin repository must point to neo4j-labs/nams-plugins.");
  }
```

After the Codex plugin name/version assertion, add:

```js
  if (plugin.repository !== "https://github.com/neo4j-labs/nams-plugins") {
    throw new Error("Codex plugin manifest repository must point to neo4j-labs/nams-plugins.");
  }
```

- [ ] **Step 4: Check generated package identity in packed package helper**

In `checkPackedPackage(packageDir, binTarget)`, after reading `packageJson`, add:

```js
  if (packageJson.name !== "@neo4j-labs/nams-plugins") {
    throw new Error(`${path.relative(root, packageDir) || "."}/package.json name must be @neo4j-labs/nams-plugins.`);
  }
```

Keep the existing `bin.nams-hooks` assertion unchanged.

- [ ] **Step 5: Run check-dist before rebuilding dist to verify the check is meaningful**

Run:

```bash
node scripts/check-dist.mjs
```

Expected: FAIL if `dist/` still contains old generated marketplace names or package metadata. If `dist/` is missing, the command may fail on a missing `dist` path; that is acceptable at this stage because `dist/` is generated output.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
node --import=tsx --test test/package-metadata.test.ts test/claude-template.test.js test/codex-template.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit distribution checks**

Run:

```bash
git add scripts/check-dist.mjs
git commit -m "test: enforce nams-plugins release identity" -m "Co-authored-by: Codex <codex@openai.com>"
```

### Task 4: Update User Documentation

**Files:**
- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `DEVELOPMENT.md`

- [ ] **Step 1: Update README install commands**

In `README.md`, replace the Claude install example with:

```bash
claude plugin marketplace add neo4j-labs/nams-plugins@latest
claude plugin install nams-hooks@nams-plugins
```

Keep references to the hooks product as `nams-hooks`.

- [ ] **Step 2: Update INSTALL Claude commands and configure command**

In `INSTALL.md`, replace the Claude install and configure commands with:

```bash
claude plugin marketplace add neo4j-labs/nams-plugins@latest
claude plugin install nams-hooks@nams-plugins
```

```text
/plugin configure nams-hooks@nams-plugins
/reload-plugins
```

- [ ] **Step 3: Update INSTALL Codex marketplace command and selection text**

In `INSTALL.md`, replace the Codex marketplace command with:

```bash
codex plugin marketplace add neo4j-labs/nams-plugins@latest
codex plugin marketplace list
```

Replace the Codex marketplace selection sentence with:

```markdown
Restart Codex, open `/plugins`, select the `nams-plugins` marketplace, and
install `NAMS Hooks`. Then use `/hooks` to review and trust the plugin-bundled
hooks when Codex asks for hook review.
```

- [ ] **Step 4: Update INSTALL Gemini release URL**

In `INSTALL.md`, replace the Gemini release extension command with:

```bash
gemini extensions install https://github.com/neo4j-labs/nams-plugins --ref latest
```

The Gemini extension name remains `nams-hooks`; only the repository URL changes.

- [ ] **Step 5: Update DEVELOPMENT Codex local marketplace selection text**

In `DEVELOPMENT.md`, replace the local Codex marketplace selection sentence with:

```markdown
Restart Codex, open `/plugins`, select the `nams-plugins` marketplace, and
install `NAMS Hooks`. Then use `/hooks` to review and trust the plugin-bundled
hooks when Codex asks for hook review.
```

- [ ] **Step 6: Update DEVELOPMENT Claude local install command**

In `DEVELOPMENT.md`, replace the legacy Claude marketplace install command
with:

```bash
claude plugin install nams-hooks@nams-plugins
```

- [ ] **Step 7: Update DEVELOPMENT global package references**

In `DEVELOPMENT.md`, replace legacy global npm package examples with
`@neo4j-labs/nams-plugins`, while keeping the executable command
`nams-hooks`.

Use this replacement in examples:

```bash
npm install -g @neo4j-labs/nams-plugins
```

For npm-root copy examples, use:

```bash
cp "$(npm root -g)/@neo4j-labs/nams-plugins/templates/codex/hooks.json" .codex/hooks.json
```

- [ ] **Step 8: Run stale user-doc install search**

Run:

```bash
rg -n "<legacy identity regex>" README.md INSTALL.md DEVELOPMENT.md
```

Expected: no output.

- [ ] **Step 9: Commit user documentation**

Run:

```bash
git add README.md INSTALL.md DEVELOPMENT.md
git commit -m "docs: update nams-plugins install docs" -m "Co-authored-by: Codex <codex@openai.com>"
```

### Task 5: Update Active Design Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- Modify: `docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md`

- [ ] **Step 1: Update active architecture repository identity**

In `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`, change the header repository line to:

```markdown
Repository: nams-plugins
```

Keep the document title `NAMS Hooks Design` because the runtime product is still `nams-hooks`.

- [ ] **Step 2: Add a short umbrella naming note to the architecture design**

After the first summary paragraph in `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`, add:

```markdown
As of the umbrella rename, repository, npm package, and marketplace identity use
`nams-plugins`; the hooks plugin and CLI executable remain `nams-hooks`.
```

- [ ] **Step 3: Update architecture install examples**

In `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`, replace the release examples with:

```bash
gemini extensions install https://github.com/neo4j-labs/nams-plugins --ref latest
```

```bash
claude plugin marketplace add neo4j-labs/nams-plugins@latest
claude plugin install nams-hooks@nams-plugins
```

```bash
codex plugin marketplace add neo4j-labs/nams-plugins@latest
```

```bash
npm install -g @neo4j-labs/nams-plugins
nams-hooks install --harness codex,claude,opencode
```

- [ ] **Step 4: Update Codex marketplace design repository identity**

In `docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md`, change the header repository line to:

```markdown
Repository: nams-plugins
```

After the summary paragraph, add:

```markdown
After the umbrella rename, the Codex marketplace name is `nams-plugins`, while
the installable plugin remains `nams-hooks`.
```

- [ ] **Step 5: Update Codex marketplace design details**

In `docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md`,
replace legacy marketplace names with `nams-plugins`. Replace repository
metadata examples with:

```json
"repository": "https://github.com/neo4j-labs/nams-plugins"
```

Replace release install examples with:

```bash
codex plugin marketplace add neo4j-labs/nams-plugins@latest
```

Keep plugin name examples as:

```json
"name": "nams-hooks"
```

- [ ] **Step 6: Run stale active-spec install search**

Run:

```bash
rg -n "<legacy identity regex>" docs/superpowers/specs/2026-05-10-nams-hooks-design.md docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md
```

Expected: no output.

- [ ] **Step 7: Commit active design docs**

Run:

```bash
git add docs/superpowers/specs/2026-05-10-nams-hooks-design.md docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md
git commit -m "docs: update nams-plugins architecture references" -m "Co-authored-by: Codex <codex@openai.com>"
```

### Task 6: Run Full Verification

**Files:**
- Verify generated output only; do not hand-edit `dist/`

- [ ] **Step 1: Run package verification**

Run:

```bash
npm run package:check
```

Expected: PASS. This should run `npm run check`, build `dist/`, run `scripts/check-dist.mjs`, verify packed package contents, and confirm generated Claude/Codex marketplaces use `nams-plugins`.

- [ ] **Step 2: Inspect generated package metadata**

Run:

```bash
node -e 'const fs=require("fs"); for (const file of ["dist/package.json","dist/.claude-plugin/marketplace.json","dist/.agents/plugins/marketplace.json","dist/plugins/nams-hooks/.claude-plugin/plugin.json","dist/plugins/codex-nams-hooks/.codex-plugin/plugin.json"]) { const json=JSON.parse(fs.readFileSync(file,"utf8")); console.log(file + ": " + JSON.stringify({name: json.name, packageName: json.name, repository: json.repository, plugin: json.plugins?.[0]?.name, pluginRepository: json.plugins?.[0]?.repository, bin: json.bin}, null, 0)); }'
```

Expected output should show:

```text
dist/package.json: {"name":"@neo4j-labs/nams-plugins","bin":{"nams-hooks":"./bin/cli.js"}}
dist/.claude-plugin/marketplace.json: {"name":"nams-plugins","plugin":"nams-hooks","pluginRepository":"https://github.com/neo4j-labs/nams-plugins"}
dist/.agents/plugins/marketplace.json: {"name":"nams-plugins","plugin":"nams-hooks","pluginRepository":"https://github.com/neo4j-labs/nams-plugins"}
dist/plugins/nams-hooks/.claude-plugin/plugin.json: {"name":"nams-hooks","repository":"https://github.com/neo4j-labs/nams-plugins"}
dist/plugins/codex-nams-hooks/.codex-plugin/plugin.json: {"name":"nams-hooks","repository":"https://github.com/neo4j-labs/nams-plugins"}
```

- [ ] **Step 3: Run final stale identity search**

Run:

```bash
rg -n "<legacy identity regex>" README.md INSTALL.md DEVELOPMENT.md docs/superpowers/specs/2026-05-10-nams-hooks-design.md docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md package.json package-lock.json templates test scripts
```

Expected: no output.

- [ ] **Step 4: Check the worktree**

Run:

```bash
git status --short
```

Expected: only intentional generated `dist/` output should appear if `dist/` is unignored in the current branch. On `devel`, `dist/` is ignored and should not need staging.

- [ ] **Step 5: Commit any missed verification-source changes**

If Task 6 revealed a required source-doc or check adjustment, stage and commit only those source files:

```bash
git add README.md INSTALL.md DEVELOPMENT.md docs/superpowers/specs/2026-05-10-nams-hooks-design.md docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md package.json package-lock.json templates test scripts
git commit -m "chore: finalize nams-plugins rename verification" -m "Co-authored-by: Codex <codex@openai.com>"
```

Expected: if all earlier tasks were complete, this step has nothing to commit.

## Self-Review

- Spec coverage: Tasks cover package identity, lockfile identity, Claude marketplace identity, Codex marketplace identity, repository metadata, docs, active source-of-truth specs, generated release checks, and final package verification. Runtime behavior is intentionally untouched.
- Placeholder scan: The plan contains no placeholder markers, incomplete sections, or vague "handle later" steps. Every file edit has explicit target values.
- Type consistency: The package name is consistently `@neo4j-labs/nams-plugins`; marketplace name is consistently `nams-plugins`; plugin and executable names remain `nams-hooks`; repository URL is consistently `https://github.com/neo4j-labs/nams-plugins`.
