# Installation

`nams-hooks` is built from TypeScript and distributed as generated JavaScript. Runtime hook code uses Node.js built-ins only.

## Prerequisites

- Node.js 20 or newer
- A NAMS API key and workspace ID
- Gemini CLI, for the Gemini local extension path
- Codex, for project-level Codex hooks
- Claude Code, for project-level Claude hooks
- OpenCode, for the OpenCode project plugin path

## Configuration

Create a user-local config file at `~/.nams/config.json`:

```json
{
  "apiKey": "nams-api-key",
  "workspaceId": "5e5c0535-8d85-491c-b92c-33be13659998",
  "baseUrl": "https://memory.neo4jlabs.com"
}
```

`apiKey` and `workspaceId` are required for NAMS requests. `baseUrl` is optional and defaults to the runtime client's built-in NAMS URL.

Projects may override any key with `<project>/.nams/config.json`. A common setup is a global `apiKey` with project-specific `workspaceId` values.

```json
{
  "workspaceId": "project-workspace-id"
}
```

Keep project `.nams/config.json` local and gitignored, especially if it contains an API key. Prefer `~/.nams/config.json` or `NAMS_API_KEY` for secrets that apply across projects.

Environment variables are final overrides:

- `NAMS_API_KEY` overrides `apiKey`.
- `NAMS_WORKSPACE_ID` overrides `workspaceId`.
- `NAMS_BASE_URL` overrides `baseUrl`.

Claude plugin installs also prompt for plugin user configuration:

- `NAMS_API_KEY` is required, marked sensitive, and stored by Claude Code in secure storage.
- `NAMS_WORKSPACE_ID` is required and routes memory requests to the selected NAMS workspace.
- `NAMS_BASE_URL` is optional and defaults to `https://memory.neo4jlabs.com`.

Claude exports those plugin values to hook subprocesses as `CLAUDE_PLUGIN_OPTION_NAMS_API_KEY`, `CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID`, and `CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL`. Explicit `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment variables still override plugin-provided values.

The runtime does not read `.env` files.

## Gemini CLI

### From A Local Build

Use this path when developing or testing the extension from a checkout.

```bash
npm install
npm run dist
gemini extensions link ./dist
```

This builds the generated Gemini extension tree under `dist/` and links it into Gemini CLI.

### From Repository

Repository-hosted Gemini installation is not published yet. For now, use the local build path above when testing Gemini CLI.

## Codex

Codex loads project hook settings from `.codex/hooks.json`. Hook execution is controlled by the `hooks` feature flag in Codex config.

Install the package so `nams-hooks` is on `PATH`, then copy the Codex hook template into the target project:

```bash
npm install -g @neo4j-labs/nams-hooks
mkdir -p .codex
cp "$(npm root -g)/@neo4j-labs/nams-hooks/templates/codex/hooks.json" .codex/hooks.json
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

Add the hooks feature flag to `~/.codex/config.toml` or project-local `.codex/config.toml`:

```toml
[features]
hooks = true
```

If `.codex/config.toml` already exists, merge `hooks = true` into its existing `[features]` table instead of replacing the file.

Start Codex from the target project and use `/hooks` to review and trust the new command hooks. Codex loads project-local `.codex/` configuration only after the project is trusted.

## OpenCode

OpenCode loads project plugins from `.opencode/plugins/`.

OpenCode uses the same NAMS configuration hierarchy as other harnesses: `~/.nams/config.json`, optional project `.nams/config.json`, then final `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides.

Install the package so `nams-hooks` is on `PATH`:

```bash
npm install -g @neo4j-labs/nams-hooks
mkdir -p .opencode/plugins
cp "$(npm root -g)/@neo4j-labs/nams-hooks/templates/opencode/plugins/nams-hooks.js" .opencode/plugins/nams-hooks.js
```

If your global npm root is customized, run `npm root -g` first and copy the template from the reported package directory.

For local development from this repository:

```bash
npm install
npm run dist
mkdir -p /path/to/project/.opencode/plugins
cp templates/opencode/plugins/nams-hooks.js /path/to/project/.opencode/plugins/nams-hooks.js
```

If `nams-hooks` is not on OpenCode's `PATH`, set `NAMS_HOOKS_COMMAND` to the executable path before starting OpenCode. For a local checkout, use the generated executable:

```bash
export NAMS_HOOKS_COMMAND=/absolute/path/to/nams-hooks/dist/bin/cli.js
```

The plugin listens for OpenCode events and routes them through the CLI gateway, for example `nams-hooks run opencode --event SessionStart`.

## Claude Code

Claude Code can install `nams-hooks` as a Claude plugin marketplace entry. The plugin bundles the compiled runtime under its own plugin directory, so hook commands do not require a global `nams-hooks` install.

### From A Generated Marketplace

Use this path when testing the generated release tree locally:

```bash
npm install
npm run dist
claude plugin validate ./dist
claude plugin marketplace add ./dist
claude plugin install nams-hooks@neo4j-nams-hooks
```

The generated marketplace lives at `dist/.claude-plugin/marketplace.json`. Its plugin source is `dist/plugins/nams-hooks/`, with standard hook configuration at `hooks/hooks.json`, the compiled CLI at `bin/cli.js`, and NAMS credential prompts in `.claude-plugin/plugin.json`. Claude loads the standard `hooks/hooks.json` file automatically, so the plugin manifest intentionally omits a `hooks` field.

For a published generated release branch, add the repository marketplace instead of the local `./dist` directory:

```bash
claude plugin marketplace add neo4j-labs/nams-hooks@master
claude plugin install nams-hooks@neo4j-nams-hooks
```

Use `--scope project`, `--scope local`, or `--scope user` on the Claude plugin commands when you need a specific installation scope.

### From Project Hook Settings

Use this fallback path when you want a project-local `.claude/settings.local.json` hook file instead of a Claude plugin marketplace install.

Install the package so `nams-hooks` is on `PATH`, then copy the Claude hook template into the target project:

```bash
npm install -g @neo4j-labs/nams-hooks
mkdir -p .claude
cp "$(npm root -g)/@neo4j-labs/nams-hooks/templates/claude/.claude/settings.local.json" .claude/settings.local.json
```

If `.claude/settings.local.json` already exists, merge the `hooks` entries from `templates/claude/.claude/settings.local.json` instead of replacing the file.

For local development from this repository:

```bash
npm install
npm run dist
npm install -g ./dist
mkdir -p /path/to/project/.claude
cp templates/claude/.claude/settings.local.json /path/to/project/.claude/settings.local.json
```

Use the Configuration section above for NAMS credentials.
