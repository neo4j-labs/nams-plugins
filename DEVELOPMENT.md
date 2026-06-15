# Development

This guide is for developing and testing `nams-hooks` from a local checkout.
It deliberately uses generated local artifacts under `dist/`,
`dist-marketplace/`, and `dist-local/` rather than the published release branch.

Runtime hook code is compiled from TypeScript to plain JavaScript and uses only
Node.js built-ins. Development tooling, tests, and distribution assembly use
dev dependencies from this repository.

## Prerequisites

- Node.js 20 or newer
- npm
- A NAMS API key, NAMS base URL, and workspace ID unless your harness path can
  auto-select a single available workspace
- The platform CLI you want to test:
  - Gemini CLI
  - Codex
  - Claude Code
  - OpenCode

## Local Setup

Install development dependencies:

```bash
npm install
```

Run the normal verification target:

```bash
npm run check
```

Build all generated distribution trees:

```bash
npm run dist
```

Build and verify generated package/release artifacts:

```bash
npm run package:check
```

Run `npm run check` before release validation. `npm run package:check` builds
`dist/`, `dist-marketplace/`, and `dist-local/`, then verifies all generated
artifacts and packed package contents.

## Runtime Configuration

For local testing, create a user-local config file at `~/.nams/config.json`:

```json
{
  "apiKey": "nams-api-key",
  "workspaceId": "5e5c0535-8d85-491c-b92c-33be13659998",
  "baseUrl": "https://memory.neo4jlabs.com"
}
```

`apiKey` and `baseUrl` are required for NAMS requests. `workspaceId` is required
unless the active harness path can auto-select a single available workspace
before memory starts. `baseUrl` has no built-in runtime or generated-client
default; provide it through JSON config, platform configuration, or
`NAMS_BASE_URL`.

Projects may override any key with `<project>/.nams/config.json`. A common local
setup is a global `apiKey` with project-specific `workspaceId` values:

```json
{
  "workspaceId": "project-workspace-id"
}
```

Environment variables are final overrides:

- `NAMS_API_KEY` overrides `apiKey`.
- `NAMS_WORKSPACE_ID` overrides `workspaceId`.
- `NAMS_BASE_URL` overrides `baseUrl`.

The runtime does not read `.env` files. Keep project `.nams/config.json` local
and gitignored, especially if it contains an API key.

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

## Test Gemini CLI Locally

Build the marketplace extension tree and link it into Gemini:

```bash
npm run dist:marketplace
gemini extensions link ./dist-marketplace
```

The linked extension runs:

```bash
node "${extensionPath}/plugins/gemini-nams-hooks/bin/cli.js" run gemini --event <event>
```

Start Gemini from a project directory with NAMS configuration available through
`~/.nams/config.json`, project `.nams/config.json`, or `NAMS_*` environment
variables.

## Test Gemini Project Config Locally

Use this fallback path when you want to test the project-local Gemini extension
configuration that calls an installed `nams-hooks` executable.

```bash
npm run dist:npm
npm install -g ./dist
cp -R dist-local/gemini/.gemini /path/to/project/.gemini
```

## Test Codex Locally

Build the local Codex repo marketplace:

```bash
npm run dist:marketplace
codex plugin marketplace add ./dist-marketplace
codex plugin marketplace list
```

Restart Codex, open `/plugins`, select the `nams-plugins` marketplace, and
install `NAMS Hooks`. Then use `/hooks` to review and trust the plugin-bundled
hooks when Codex asks for hook review.

The generated Codex marketplace lives at:

```text
dist-marketplace/.agents/plugins/marketplace.json
```

Its plugin source is:

```text
dist-marketplace/plugins/codex-nams-hooks/
```

Codex plugin installs use the normal runtime configuration model from this file.
Codex does not currently define NAMS credentials through plugin install prompts.

## Test Codex Project Hooks Locally

Use this fallback path when you want to test the project-local `.codex/hooks.json`
template rather than the Codex plugin marketplace.

```bash
npm run dist:npm
npm install -g ./dist
cp -R dist-local/codex/.codex /path/to/project/.codex
```

Enable hooks in `~/.codex/config.toml` or project-local `.codex/config.toml`:

```toml
[features]
hooks = true
```

Start Codex from the target project and use `/hooks` to review and trust the new
command hooks. Codex loads project-local `.codex/` configuration only after the
project is trusted.

## Test Claude Code Locally

Build and validate the generated local Claude plugin marketplace:

```bash
npm run dist:marketplace
claude plugin validate ./dist-marketplace
claude plugin marketplace add ./dist-marketplace
claude plugin install nams-hooks@nams-plugins
```

The generated marketplace lives at:

```text
dist-marketplace/.claude-plugin/marketplace.json
```

Its plugin source is:

```text
dist-marketplace/plugins/claude-nams-hooks/
```

Claude Code plugin installs prompt for plugin user configuration:

- `NAMS_API_KEY` is required, marked sensitive, and stored by Claude Code in
  secure storage.
- `NAMS_WORKSPACE_ID` is optional. If omitted, nams-hooks auto-selects a single
  available workspace before memory starts.
- `NAMS_BASE_URL` is optional and defaults to `https://memory.neo4jlabs.com`.

Claude exports those values to hook subprocesses as
`CLAUDE_PLUGIN_OPTION_NAMS_API_KEY`, `CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID`,
and `CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL`. Explicit `NAMS_API_KEY`,
`NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment variables still override
plugin-provided values.

Use `--scope project`, `--scope local`, or `--scope user` on the Claude plugin
commands when you need a specific installation scope.

## Test Claude Project Hooks Locally

Use this fallback path when you want to test project-local
`.claude/settings.local.json` instead of a Claude plugin marketplace install.

```bash
npm run dist:npm
npm install -g ./dist
cp -R dist-local/claude/.claude /path/to/project/.claude
```

If `.claude/settings.local.json` already exists, merge the `hooks` entries from
`dist-local/claude/.claude/settings.local.json` instead of replacing the file.

## Test OpenCode Locally

OpenCode loads project plugins from `.opencode/plugins/`.

```bash
npm run dist:local
mkdir -p /path/to/project/.opencode/plugins
cp dist-local/opencode/.opencode/plugins/nams-hooks.js /path/to/project/.opencode/plugins/nams-hooks.js
```

If `nams-hooks` is not on OpenCode's `PATH`, build and install the npm artifact
before starting OpenCode:

```bash
npm run dist:npm
npm install -g ./dist
```

The OpenCode plugin listens for OpenCode events and routes them through the CLI
gateway, for example:

```bash
nams-hooks run opencode --event SessionStart
```

## Useful Commands

```bash
npm run build
npm test
npm run check
npm run openapi:generate
npm run dist
npm run dist:npm
npm run dist:marketplace
npm run dist:local
npm run dist:check
npm run package:check
```

Use `npm run openapi:generate` when `docs/nams-openapi.json` changes and you need
to refresh `src/generated/nams-client.ts`. The runtime must never fetch or inspect
OpenAPI data while hooks are running.
