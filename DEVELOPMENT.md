# Development

This guide is for developing and testing `nams-hooks` from a local checkout.
It deliberately uses the generated development distribution trees:
`dist/`, `dist-marketplace/`, and `dist-local/`.

Runtime hook code is compiled from TypeScript to plain JavaScript and uses only
Node.js built-ins. Development tooling, tests, and distribution assembly use
dev dependencies from this repository.

## Prerequisites

- Node.js 20 or newer
- npm
- A NAMS API key, NAMS base URL, and workspace ID unless your harness path can
  auto-select a single available workspace
- The platform CLI you want to test:
  - Antigravity
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

- `dist/`: npm-installable package output with `bin/cli.js` and
  `package.json`. Use this for `npm install -g ./dist`.
- `dist-marketplace/`: self-contained marketplace output for Gemini,
  Claude Code, Codex, OpenCode, and Antigravity. Most marketplace hooks call
  bundled runtime files under `dist-marketplace/plugins/<platform>-nams-hooks/bin/`;
  Antigravity uses `dist-marketplace/antigravity/plugins/nams-hooks/bin/`.
- `dist-local/`: project-shaped local configuration output for Gemini,
  Claude Code, Codex, OpenCode, and Antigravity. These files call an installed
  `nams-hooks` executable and do not include compiled runtime files.

Use target-specific commands when you only need one tree:

```bash
npm run dist:npm
npm run dist:marketplace
npm run dist:local
```

`dist-local/` is intended for quick local project testing. You can symlink its
platform folders into a scratch project so rebuilding `dist-local/` updates the
project configuration in place:

```bash
npm run dist:npm
npm install -g ./dist
npm run dist:local

ln -sF <repository-root-or-worktree>/dist-local/gemini/.gemini /path/to/project/.gemini
ln -sF <repository-root-or-worktree>/dist-local/codex/.codex /path/to/project/.codex
ln -sF <repository-root-or-worktree>/dist-local/claude/.claude /path/to/project/.claude
ln -sF <repository-root-or-worktree>/dist-local/opencode/.opencode /path/to/project/.opencode
ln -sF <repository-root-or-worktree>/dist-local/antigravity/.agents /path/to/project/.agents
```

Only replace a target project folder when it is disposable. If the project
already has platform configuration, merge the generated hook, command, skill, or
plugin entries from `dist-local/` instead of replacing the whole folder.

Do not hand-edit generated dist trees; change TypeScript source, templates, or
build scripts instead.

## New Platform Checklist

Use this checklist before adding support for another agent harness. It is the
high-level onboarding guide; the task-by-task plan lives in
`docs/superpowers/plans/2026-06-09-new-platform-onboarding.md`.

### Intake And Scope

Start with the platform contract, not code. Record the stable platform id,
supported OS scope, native hook lifecycle, session identity fields, project
directory field, install model, configuration surface, stdout contract, and
unsupported lifecycle events. Capture whether the platform exposes user prompts,
assistant responses, tool completion metadata, safe context injection, and any
documented transcript source.

Map native hooks into the semantic NAMS lifecycle:
`SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`. Native event names
belong in templates, payload parsers, tests, and platform-specific output only.
The CLI command must always pass a typed `--event <NAMS event>` value, and
runtime routing must never infer `invocation.event` from payload fields.

### Runtime Boundaries

Keep `src/cli.ts` as a gateway. It should parse the command, platform, typed
event, and opaque stdin JSON, then dispatch through the static platform
registry. Do not add platform payload parsing, OpenAPI handling, or dynamic
adapter discovery to the CLI.

Put platform-specific code under `src/platforms/<platform>/`. The normal shape
is `index.ts` for memory orchestration, `payload.ts` for typed extraction from
raw hook JSON, `workspaces.ts` for install-time workspace configuration and
native workspace commands, and `transcript.ts` only when a documented transcript
source is needed. Shared contracts stay in `src/interfaces.ts`, and concrete
adapters are registered in `src/platforms/index.ts` as singleton exports.

Keep configuration, state, logging, duplicate suppression, workspace
resolution, NAMS HTTP behavior, hashing, and provenance in shared runtime
modules. Add a new shared abstraction only when more than one platform needs
it, or when it preserves a clear adapter boundary.

### Memory Behavior

Implement memory flow incrementally and test each stage. Start with a log-only
`SessionStart` that initializes local state and session-scoped raw hook logs
without creating a NAMS conversation. Then add `BeforeAgent` behavior that
resolves workspace readiness, recalls memory, stores exposed user prompts once,
and injects recalled context only through the platform's safe context channel.

Assistant responses and tool metadata are best-effort. Store assistant text only
when the platform exposes completed assistant content cleanly. Store tool name,
sanitized input, exposed output, status, duration, and optional step id only
when those fields are available through the documented platform contract. Never
store hidden chain-of-thought, infer internal reasoning, or scrape unsupported
payload fields.

### Tests First

Write parser and gateway tests before implementation. Cover documented payload
fields, project-directory fallback, blank strings, unsupported aliases, typed
event routing, and the rule that native payload event-name fields never drive
routing. Add memory-flow tests with mocked NAMS calls for workspace selection,
conversation creation, recall, user message persistence, assistant persistence,
tool metadata, duplicate suppression, sanitized logs, and fail-open behavior.

Keep tests under `node:test`, temp directories, and mocks. Tests must not touch
repository `.nams/` state, make network calls, or assert README and docs prose
unless the task explicitly targets documentation behavior.

### Templates And Distribution

Add templates only after the native install model and hook command shape are
known. Use `templates/local/<platform>/` for project-local config that calls an
installed `nams-hooks` executable. Use `templates/marketplace/<platform>/` for
self-contained marketplace or extension artifacts that call bundled runtime
files. Use `templates/<platform>/` only for fragments deliberately shared by
both outputs.

Wire generated artifacts through the split distribution scripts. Local
templates belong in `scripts/build-dist-local.mjs` and generate under
`dist-local/<platform>/`. Marketplace or extension templates belong in
`scripts/build-dist-marketplace.mjs` and generate under `dist-marketplace/`.
Leave `dist/` npm-only unless the package runtime shape itself changes.

Extend `scripts/check-dist.mjs` for the chosen install model. Checks should
prove marketplace commands use bundled runtime paths, local commands use
installed `nams-hooks`, `dist-local/` has no compiled runtime, `dist/` stays
npm-only, OpenAPI artifacts are absent, generated CLI files are executable, and
plugin or extension metadata versions match `package.json`.

### Documentation And Validation

Update `README.md`, `INSTALL.md`, this guide, and
`docs/superpowers/specs/2026-05-10-nams-hooks-design.md` when the platform
becomes official. Create a dedicated platform design spec only when the platform
introduces a new architecture, distribution model, blocking behavior, workspace
interaction, configuration source, or payload source.

Verify targeted platform tests first, then run `npm run check`. Run
`npm run package:check` when templates, distribution scripts, package metadata,
or distribution checks changed. Manual harness validation should use a
throwaway project or temp HOME and must not write `.nams/` artifacts into this
repository.

Live validation in `live-tests/` is optional and outside the default Node
verification path. Add it only when the platform can run non-interactively in
Docker, credentials can be supplied safely, generated `dist/` and `dist-local/`
artifacts can be consumed without rewriting hook commands, and the test can
assert real NAMS persistence without becoming part of `npm run check`.

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

Use this fallback path when you want to test the project-local Gemini
configuration that calls an installed `nams-hooks` executable. The generated
`.gemini` folder is project-shaped and symlinkable from a test project for fast
exploration.

```bash
npm run dist:npm
npm install -g ./dist
npm run dist:local
ln -sF <repository-root-or-worktree>/dist-local/gemini/.gemini /path/to/project/.gemini
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

Use this fallback path when you want to test the project-local `.codex/`
configuration rather than the Codex plugin marketplace. The generated folder
contains `hooks.json` and the local `nams:workspace` skill.

```bash
npm run dist:npm
npm install -g ./dist
npm run dist:local
ln -sF <repository-root-or-worktree>/dist-local/codex/.codex /path/to/project/.codex
```

Enable hooks in `~/.codex/config.toml` or project-local `.codex/config.toml`:

```toml
[features]
hooks = true
```

Start Codex from the target project and use `/hooks` to review and trust the new
command hooks. Codex loads project-local `.codex/` configuration only after the
project is trusted. If the project already has `.codex/` content, merge the
generated hook and skill entries instead of replacing the folder.

## Test Antigravity Artifacts Locally

Build and verify the generated Antigravity artifacts:

```bash
npm run package:check
```

The project-local Antigravity plugin lives at:

```text
dist-local/antigravity/.agents/plugins/nams-hooks/
```

It calls an installed `nams-hooks` executable. For a disposable Antigravity test
project, build and install the npm artifact, then link or copy the generated
project-local plugin:

```bash
npm run dist:npm
npm install -g ./dist
npm run dist:local
ln -sF <repository-root-or-worktree>/dist-local/antigravity/.agents /path/to/project/.agents
```

If the target project already has `.agents/` content, merge only
`dist-local/antigravity/.agents/plugins/nams-hooks/` into
`/path/to/project/.agents/plugins/nams-hooks/` instead of replacing the whole
folder.

The generated local hooks route:

```bash
nams-hooks run antigravity --event BeforeAgent
nams-hooks run antigravity --event AfterAgent
nams-hooks run antigravity --event AfterTool
```

The self-contained Antigravity CLI plugin is generated at:

```text
dist-marketplace/antigravity/plugins/nams-hooks/
```

Build and stage it at the Antigravity CLI plugin path used by the generated
hook commands:

```bash
npm run dist:marketplace
mkdir -p "$HOME/.gemini/antigravity-cli/plugins"
cp -R dist-marketplace/antigravity/plugins/nams-hooks "$HOME/.gemini/antigravity-cli/plugins/"
```

It bundles `bin/cli.js` and hook commands call that install location:

```bash
node "$HOME/.gemini/antigravity-cli/plugins/nams-hooks/bin/cli.js" run antigravity --event BeforeAgent
```

Manual validation against a live local Antigravity CLI or IDE install is still
pending. Until that is complete, treat these steps as generated artifact
inspection and staging instructions, not proof of live platform behavior.

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
npm run dist:local
ln -sF <repository-root-or-worktree>/dist-local/claude/.claude /path/to/project/.claude
```

If `.claude/settings.local.json` already exists, merge the `hooks` entries from
`dist-local/claude/.claude/settings.local.json` and the generated command under
`dist-local/claude/.claude/commands/` instead of replacing the folder.

## Test OpenCode Locally

OpenCode loads project plugins from `.opencode/plugins/`.

```bash
npm run dist:local
ln -sF <repository-root-or-worktree>/dist-local/opencode/.opencode /path/to/project/.opencode
```

If `nams-hooks` is not on OpenCode's `PATH`, build and install the npm artifact
before starting OpenCode:

```bash
npm run dist:npm
npm install -g ./dist
```

If the target project already has `.opencode/`, keep that folder and symlink or
copy only `dist-local/opencode/.opencode/plugins/nams-hooks.js` into
`/path/to/project/.opencode/plugins/nams-hooks.js`.

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
