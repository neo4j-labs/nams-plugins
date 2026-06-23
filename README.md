# nams-hooks

`nams-hooks` is a lightweight-at-runtime Node.js integration layer that connects local AI agent harness hooks to the **Neo4j Agent Memory Service (NAMS)**.

It ensures deterministic memory persistence and context recall across different agent platforms without requiring the agents themselves to manage the memory logic.

## Getting Started

### Gemini CLI

Install the Gemini extension from the generated release branch:

```bash
gemini extensions install https://github.com/neo4j-labs/nams-plugins --ref latest
```

Configure NAMS through Gemini extension settings, JSON config, or `NAMS_*`
environment variables. Gemini exposes workspace selection as:

```text
/nams:workspace use <workspace-id-or-name>
```

### Claude Code

Install the Claude Code marketplace release:

```bash
claude plugin marketplace add neo4j-labs/nams-plugins@latest
claude plugin install nams-hooks@nams-plugins
```

Configure and reload the plugin inside Claude Code:

```text
/plugin configure nams-hooks@nams-plugins
/reload-plugins
```

The Claude plugin prompts for the required NAMS API key, optional workspace ID,
and the NAMS base URL with the standard service URL as its default. Claude Code
exposes workspace selection as:

```text
/nams:workspace use <workspace-id-or-name>
```

### Codex

Add the generated repo marketplace:

```bash
codex plugin marketplace add neo4j-labs/nams-plugins@latest
codex plugin marketplace list
```

Restart Codex, open `/plugins`, select the `nams-plugins` marketplace, and
install `NAMS Hooks`. Then use `/hooks` to review and trust the plugin-bundled
hooks when Codex asks for hook review.

Codex plugin installs use JSON config or `NAMS_*` environment variables for
NAMS credentials. Codex exposes workspace selection as the explicit skill:

```text
$nams:workspace use <workspace-id-or-name>
```

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

### OpenCode

OpenCode uses the project plugin shim and the `nams-hooks` CLI package:

```bash
npm install -g @neo4j-labs/nams-plugins
mkdir -p .opencode/plugins
cp "$(npm root -g)/@neo4j-labs/nams-plugins/templates/opencode/.opencode/plugins/nams-hooks.js" .opencode/plugins/nams-hooks.js
```

Start OpenCode from the project after copying the shim. OpenCode keeps workspace
selection on the explicit shell command because OpenCode markdown commands are
prompt templates:

```bash
nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

OpenCode does not currently provide a Claude-style NAMS credential prompt for
this plugin. Configure NAMS with `~/.nams/config.json`, project
`.nams/config.json`, or by starting OpenCode with `NAMS_API_KEY`,
`NAMS_BASE_URL`, and optional `NAMS_WORKSPACE_ID` environment variables.

For full setup details, local development installs, and fallback project-hook
paths, see [INSTALL.md](INSTALL.md).

## Runtime Configuration And Storage

Use `~/.nams/config.json` for user defaults, or `<project>/.nams/config.json`
for project-specific overrides:

```json
{
  "apiKey": "nams-api-key",
  "workspaceId": "5e5c0535-8d85-491c-b92c-33be13659998",
  "baseUrl": "https://memory.neo4jlabs.com"
}
```

- Configuration is JSON-first. The runtime reads user config, overlays project
  config, overlays platform-discovered values such as Claude plugin user
  configuration, then applies final `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and
  `NAMS_BASE_URL` environment overrides.
- `apiKey` and a resolved `baseUrl` are required for NAMS requests. The standard
  service URL can be supplied by JSON config or platform configuration
  templates.
- `workspaceId` can be omitted when NAMS returns exactly one valid workspace for
  the configured key. That workspace is stored in session state and reused by
  later memory hooks.
- If NAMS returns multiple valid workspaces, memory stays inactive for that turn
  until you select one explicitly. The quickest deterministic fix is a
  session-scoped selection.
- NAMS supports workspace keys and admin keys. `nams-hooks` does not configure a
  key type; it uses the number of workspaces returned by NAMS to decide whether
  a workspace can be auto-selected.
- Claude Code and Gemini installs expose `/nams:workspace use <workspace-id-or-name>`.
  Codex exposes `$nams:workspace use <workspace-id-or-name>`. OpenCode uses the
  explicit shell command because OpenCode markdown commands are prompt templates.
- For all platforms, scripts, and troubleshooting, use the explicit shell
  command from the hook notice:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

- Configure workspace selection at the lifetime that matches the need:

```bash
# User default: writes ~/.nams/config.json
nams-hooks workspaces configure <platform> --scope user --workspace <workspace-id-or-name>

# Project default: writes <project>/.nams/config.json
nams-hooks workspaces configure <platform> --scope project --workspace <workspace-id-or-name>

# Current session only: writes ~/.nams/state/<platform>/...
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

- Runtime state and logs are user-local under per-platform directories:

```text
~/.nams/state/<platform>/
~/.nams/logs/<platform>/
```

- Session-scoped JSONL diagnostics use `kind: "hook.event"` for raw platform
  hook payloads and `kind: "nams.request"` for NAMS HTTP request/response
  metadata. Request headers omit `Authorization`.

## Key Features

- **Deterministic Memory**: Automatically persists user and assistant messages to NAMS.
- **Memory Recall**: Searches and injects relevant past context before the agent responds.
- **Tool Logging**: Records tool-call metadata (name, input, status, duration) for observability.
- **Platform Aware**: Memory-flow support for **Gemini CLI**, **Claude Code**, **Codex**, and **OpenCode**, with platform-specific behavior kept behind clean adapter boundaries.
- **Zero Runtime Dependencies**: The hook runtime and generated distribution use only Node.js built-in modules, so target projects do not need extra package installs for transitive runtime libraries.
- **JSON-First Runtime Storage**: Uses JSON configuration with user-local state and logs.

## Architecture

- `src/cli.ts`: Entry point that dispatches events to platform adapters.
- `src/platforms/`: Contains adapter logic for Claude, Gemini, Codex, and OpenCode.
- `src/interfaces.ts`: Shared contracts and hook event definitions.
- `templates/`: Configuration templates for various harnesses.

## Development

`nams-hooks` follows a strict "no runtime dependencies" rule for hook code and release artifacts. Development dependencies are allowed for TypeScript, generation, architecture checks, and tests as long as they stay out of runtime imports and published hook execution paths.

All platform-specific logic should be contained within its respective adapter in `src/platforms/`.

For more details on the design, see `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`.

For local development and generated artifact testing, see [DEVELOPMENT.md](DEVELOPMENT.md).

### Prerequisites

- Node.js (v20+)
- A NAMS API key, NAMS base URL such as `https://memory.neo4jlabs.com`, and, unless your harness path supports auto-resolution, a workspace ID

### Build and Test

```bash
# Compile TypeScript
npm run build

# Run tests (using Node's built-in runner)
npm test

# Run OpenAPI freshness check, build, and tests
npm run check

# Build and verify all generated artifacts: npm dist, marketplace dist, and local config dist
npm run package:check

# Regenerate and build the OpenAPI client, then run OpenAPI client tests directly
npm run openapi:test
```
