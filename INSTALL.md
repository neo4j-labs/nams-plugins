# Installation

Use this guide to install `nams-hooks` from the generated `latest` branch.
For local development, generated artifact testing, and `./dist` workflows, see
[DEVELOPMENT.md](DEVELOPMENT.md).

## Prerequisites

- Node.js 20 or newer
- A NAMS API key
- A NAMS workspace ID
- The agent platform CLI you want to use:
  - Claude Code
  - Codex
  - Gemini CLI

## Runtime Configuration

Runtime configuration is JSON-first: `~/.nams/config.json`, optional project `.nams/config.json`, optional platform discovery such as Claude plugin user configuration, then final `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides. `apiKey` and `workspaceId` are required for NAMS requests. Runtime state and logs are user-local under `~/.nams/state/<platform>/` and `~/.nams/logs/<platform>/`.

The portable configuration path is a user-local config file:

```json
{
  "apiKey": "nams-api-key",
  "workspaceId": "5e5c0535-8d85-491c-b92c-33be13659998",
  "baseUrl": "https://memory.neo4jlabs.com"
}
```

`baseUrl` is optional and defaults to `https://memory.neo4jlabs.com`.

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

## Claude Code

Claude Code installs `nams-hooks` as a plugin marketplace entry. The plugin
bundles the compiled runtime, hook configuration, and credential prompts.

Add the release marketplace and install the plugin:

```bash
claude plugin marketplace add kubamarchwicki/nams-hooks@latest
claude plugin install nams-hooks@neo4j-nams-hooks
```

After installation, configure and reload the plugin inside Claude Code:

```text
/plugin configure nams-hooks@neo4j-nams-hooks
/reload-plugins
```

Claude prompts for:

- `NAMS_API_KEY`: required, sensitive, stored by Claude Code in secure storage.
- `NAMS_WORKSPACE_ID`: required, non-sensitive.
- `NAMS_BASE_URL`: optional, defaults to `https://memory.neo4jlabs.com`.

Claude exposes those values to hook subprocesses as
`CLAUDE_PLUGIN_OPTION_NAMS_API_KEY`, `CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID`,
and `CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL`. Explicit `NAMS_API_KEY`,
`NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment variables still override
plugin-provided values.

Use `--scope project`, `--scope local`, or `--scope user` on Claude plugin
commands when you need a specific installation scope.

## Codex

Codex installs `nams-hooks` from the generated repo marketplace. The plugin
bundles the compiled runtime and hook configuration.

Add the release marketplace:

```bash
codex plugin marketplace add kubamarchwicki/nams-hooks@latest
codex plugin marketplace list
```

Restart Codex, open `/plugins`, select the `neo4j-nams-hooks` marketplace, and
install `NAMS Hooks`. Then use `/hooks` to review and trust the plugin-bundled
hooks when Codex asks for hook review.

Codex plugin installs do not currently define a custom NAMS credential prompt.
Configure NAMS through `~/.nams/config.json`, project `.nams/config.json`, or the
`NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment variables.

## Gemini CLI

Gemini CLI installs `nams-hooks` as a Gemini extension from the latest branch.
The extension bundles the compiled runtime and hook configuration.

Install the release extension:

```bash
gemini extensions install https://github.com/kubamarchwicki/nams-hooks --ref latest
```

The Gemini extension declares these settings:

- `NAMS_API_KEY`: required for NAMS requests and marked sensitive.
- `NAMS_WORKSPACE_ID`: required for NAMS requests.
- `NAMS_BASE_URL`: optional, defaults to `https://memory.neo4jlabs.com` when not
  set.

You can provide those values through Gemini extension settings, through
`~/.nams/config.json`, through project `.nams/config.json`, or through the
`NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment variables.

## Verify Runtime Logs

After installing a platform integration, start the agent from a project directory
and run a short prompt. Runtime state and logs are written under:

```text
~/.nams/state/<platform>/
~/.nams/logs/<platform>/
```

Session log entries use `kind: "hook.event"` for raw platform hook payloads and
`kind: "nams.request"` for sanitized NAMS HTTP request/response diagnostics.
