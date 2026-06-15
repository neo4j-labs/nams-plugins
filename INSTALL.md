# Installation

Use this guide to install `nams-hooks` from generated release artifacts.
Marketplace installs are built from `dist-marketplace/`. Local project
configurations are built from `dist-local/`. The npm-installable package is
built from `dist/`.
For local development and generated artifact testing, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Prerequisites

- Node.js 20 or newer
- A NAMS API key
- A NAMS base URL, for example `https://memory.neo4jlabs.com`
- A NAMS workspace ID, unless your harness path supports auto-resolution
- The agent platform CLI you want to use:
  - Claude Code
  - Codex
  - Gemini CLI
  - OpenCode

## Runtime Configuration

Runtime configuration is JSON-first: `~/.nams/config.json`, optional project `.nams/config.json`, optional platform discovery such as Claude plugin user configuration, then final `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides. `apiKey` and `baseUrl` are required for NAMS requests. When `workspaceId` is omitted, nams-hooks calls `GET /v1/users/me/workspaces` before memory creation. If exactly one valid workspace is returned, that workspace is stored in session state and reused by later memory hooks. If multiple valid workspaces are returned, memory stays inactive for that turn until you select one explicitly. The quickest deterministic fix is a session-scoped selection; see Workspace Selection below. Runtime state and logs are user-local under per-platform directories in `~/.nams/state/` and `~/.nams/logs/`.

The portable configuration path is a user-local config file:

```json
{
  "apiKey": "nams-api-key",
  "workspaceId": "5e5c0535-8d85-491c-b92c-33be13659998",
  "baseUrl": "https://memory.neo4jlabs.com"
}
```

`baseUrl` has no built-in runtime or generated-client default. Provide the
standard service URL through JSON config, platform user configuration defaults,
or `NAMS_BASE_URL`.

Projects can override any key with `<project>/.nams/config.json`. A common setup
is a global API key plus project-specific workspace IDs:

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

### Workspace Selection

NAMS supports workspace keys and admin keys. Both key scopes can list available
workspaces through NAMS. Workspace keys return exactly one workspace from that
list; admin keys may return multiple workspaces.

All memory adapters can auto-select a workspace before memory starts when NAMS
returns exactly one valid workspace. When NAMS returns multiple valid
workspaces, hooks notify that memory is inactive for the turn, continue agent
execution, and skip memory writes until you configure a workspace explicitly.

Workspace selection has three lifetimes:

- `session`: writes the selected workspace into one harness session state file.
- `project`: writes durable project configuration in `<project>/.nams/config.json`.
- `user`: writes durable user configuration in `~/.nams/config.json`.

For multi-workspace inactive memory notices, the recommended quick fix is a
session selection.

When the platform command is installed, Claude Code and Gemini expose the direct
slash command:

```text
# Claude Code and Gemini CLI
/nams:workspace use <workspace-id-or-name>
```

Codex exposes the same namespace as an explicit skill:

```text
$nams:workspace use <workspace-id-or-name>
```

These command surfaces wrap the explicit shell command. OpenCode currently uses
the explicit shell command because OpenCode markdown commands are prompt
templates and do not expose a Claude-style model-invocation disable flag. Keep
using the shell command for scripts, troubleshooting, OpenCode sessions, and any
session where the platform command cannot resolve the current session:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

For OpenCode, the same session selection can be run explicitly as:

```bash
nams-hooks workspaces configure opencode --scope session --session-id session-1 --workspace Engineering
```

For every scope, `--workspace` accepts either an exact workspace ID or an exact
workspace name. If multiple workspaces have the same name, pass the workspace
ID.

To configure a durable project workspace for Codex, run:

```bash
nams-hooks workspaces configure codex --scope project --workspace Engineering
```

Replace `codex` with `gemini`, `opencode`, or `claude` to configure a different
platform path. Use `--scope user` to write `~/.nams/config.json` instead of the
project `.nams/config.json`.

If you omit `--workspace`, the configure command writes the workspace
automatically only when NAMS returns a single valid workspace. This is the
normal path for workspace keys. When NAMS returns multiple valid workspaces,
which is common for admin keys, the command prints the available choices and
exits without changing config until you pass an explicit selection.

## Claude Code

Claude Code installs `nams-hooks` as a plugin marketplace entry. The plugin
bundles the compiled runtime, hook configuration, and credential prompts.

The generated Claude marketplace lives at
`dist-marketplace/.claude-plugin/marketplace.json`. Its plugin source is
`dist-marketplace/plugins/claude-nams-hooks/`.

Add the release marketplace and install the plugin:

```bash
claude plugin marketplace add neo4j-labs/nams-plugins@latest
claude plugin install nams-hooks@nams-plugins
```

After installation, configure and reload the plugin inside Claude Code:

```text
/plugin configure nams-hooks@nams-plugins
/reload-plugins
```

Claude prompts for:

- `NAMS_API_KEY`: required, sensitive, stored by Claude Code in secure storage.
- `NAMS_WORKSPACE_ID`: optional, non-sensitive. If omitted, nams-hooks
  auto-selects a single available workspace before memory starts.
- `NAMS_BASE_URL`: optional, non-sensitive, defaults to
  `https://memory.neo4jlabs.com`.

Claude exposes those values to hook subprocesses as
`CLAUDE_PLUGIN_OPTION_NAMS_API_KEY`, `CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID`,
and `CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL`. Explicit `NAMS_API_KEY`,
`NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment variables still override
plugin-provided values.

Use `--scope project`, `--scope local`, or `--scope user` on Claude plugin
commands when you need a specific installation scope.

The workspace selection command is direct in both the Claude project template
and Claude plugin:

```text
/nams:workspace use <workspace-id-or-name>
```

It wraps the explicit Claude session command:

```bash
nams-hooks workspaces configure claude --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

## Codex

Codex installs `nams-hooks` from the generated repo marketplace. The plugin
bundles the compiled runtime and hook configuration.

The generated Codex marketplace lives at
`dist-marketplace/.agents/plugins/marketplace.json`. Its plugin source is
`dist-marketplace/plugins/codex-nams-hooks/`, with standard hook configuration
at `hooks/hooks.json` and the compiled CLI at `bin/cli.js`.

Add the release marketplace:

```bash
codex plugin marketplace add neo4j-labs/nams-plugins@latest
codex plugin marketplace list
```

Restart Codex, open `/plugins`, select the `nams-plugins` marketplace, and
install `NAMS Hooks`. Then use `/hooks` to review and trust the plugin-bundled
hooks when Codex asks for hook review.

Codex plugin installs do not currently define a custom NAMS credential prompt.
Configure NAMS through `~/.nams/config.json`, project `.nams/config.json`, or the
`NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment variables.

Codex exposes workspace selection as the explicit skill:

```text
$nams:workspace use <workspace-id-or-name>
```

The explicit skill asks Codex to run the bundled workspace command for the
current session. If the current active NAMS session cannot be resolved, use the
explicit shell command from the hook notice:

```bash
nams-hooks workspaces configure codex --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

## Gemini CLI

Gemini CLI installs `nams-hooks` as a Gemini extension from the latest branch.
The extension bundles the compiled runtime and hook configuration.

Install the release extension:

```bash
gemini extensions install https://github.com/neo4j-labs/nams-plugins --ref latest
```

The Gemini extension declares these settings:

- `NAMS_API_KEY`: required for NAMS requests and marked sensitive.
- `NAMS_WORKSPACE_ID`: optional for Gemini runtime auto-resolution when NAMS
  returns exactly one valid workspace; required when the key can see multiple
  workspaces.
- `NAMS_BASE_URL`: optional when another configuration source supplies
  `baseUrl`; use `https://memory.neo4jlabs.com` for the standard service.

You can provide those values through Gemini extension settings, through
`~/.nams/config.json`, through project `.nams/config.json`, or through the
`NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment variables.

Gemini exposes workspace selection through the extension custom command:

```text
/nams:workspace use <workspace-id-or-name>
```

The custom command resolves the recent active Gemini session recorded by the
workspace ambiguity hook. If the active session is missing or ambiguous, use the
explicit shell command from the hook notice:

```bash
nams-hooks workspaces configure gemini --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

## OpenCode

OpenCode uses the generated plugin shim for hook execution. OpenCode markdown
commands are prompt templates, so nams-hooks does not package
`.opencode/commands/nams:workspace.md`; that file would configure the workspace
and then still send a prompt to the model. Use the explicit OpenCode session
command from the hook notice:

```bash
nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

## Verify Runtime Logs

After installing a platform integration, start the agent from a project directory
and run a short prompt. Runtime state and logs are written under:

```text
~/.nams/state/<platform>/
~/.nams/logs/<platform>/
```

Session log entries use `kind: "hook.event"` for raw platform hook payloads and
`kind: "nams.request"` for sanitized NAMS HTTP request/response diagnostics.
