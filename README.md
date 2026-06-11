# nams-hooks

`nams-hooks` is a lightweight-at-runtime Node.js integration layer that connects local AI agent harness hooks to the **Neo4j Agent Memory Service (NAMS)**.

It ensures deterministic memory persistence and context recall across different agent platforms without requiring the agents themselves to manage the memory logic.

## Key Features

- **Deterministic Memory**: Automatically persists user and assistant messages to NAMS.
- **Memory Recall**: Searches and injects relevant past context before the agent responds.
- **Tool Logging**: Records tool-call metadata (name, input, status, duration) for observability.
- **Platform Aware**: Memory-flow support for **Gemini CLI**, **Claude Code**, **Codex**, and **OpenCode**, with platform-specific behavior kept behind clean adapter boundaries.
- **Zero Runtime Dependencies**: The hook runtime and generated distribution use only Node.js built-in modules, so target projects do not need extra package installs for transitive runtime libraries.
- **JSON-First Runtime Storage**: Uses JSON configuration with user-local state and logs.

## Platform Support (v1)

- **OS**: macOS
- **Harnesses**:
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli)
  - [Codex](https://chatgpt.com/codex/)
  - [OpenCode](https://opencode.ai/docs/) 
  - [Claude Code](https://claude.ai)

## Architecture

- `src/cli.ts`: Entry point that dispatches events to platform adapters.
- `src/platforms/`: Contains adapter logic for Claude, Gemini, Codex, and OpenCode.
- `src/interfaces.ts`: Shared contracts and hook event definitions.
- `templates/`: Configuration templates for various harnesses.

## Getting Started

Install the Claude Code marketplace release:

```bash
claude plugin marketplace add neo4j-labs/nams-plugins@latest
claude plugin install nams-hooks@nams-plugins
```

The Claude plugin prompts for the required NAMS API key and optional workspace
ID, and ships a configurable default base URL for the standard NAMS service. For
Gemini, Codex, OpenCode, and full setup details, see [INSTALL.md](INSTALL.md).

### Runtime Configuration And Storage

Runtime configuration is JSON-first: `~/.nams/config.json`, optional project `.nams/config.json`, optional platform discovery such as Claude plugin user configuration, then final `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides. `apiKey` and a resolved `baseUrl` are required for NAMS requests; the standard service URL can be supplied by JSON config or platform configuration templates. NAMS supports workspace keys and admin keys. `nams-hooks` does not configure a key type; it uses the number of workspaces returned by NAMS to decide whether a workspace can be auto-selected. When `workspaceId` is omitted, nams-hooks calls `GET /v1/users/me/workspaces` before memory creation. If exactly one valid workspace is returned, that workspace is stored in session state and reused by later memory hooks. If multiple valid workspaces are returned, memory stays inactive for that turn until you select one explicitly. The quickest deterministic fix is a session-scoped selection. Claude Code project template installs expose `/nams-hooks workspaces use <workspace-id-or-name>`, Claude plugin installs expose `/nams-hooks:nams-hooks workspaces use <workspace-id-or-name>`, and OpenCode plugin installs expose `/nams-hooks workspaces use <workspace-id-or-name>`. For all platforms, scripts, and troubleshooting, use the explicit shell command from the hook notice: `nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>`. Hook notices include the current session ID when the harness exposes it, so usually only `--workspace <workspace-id-or-name>` needs editing. Durable project and user defaults use the same selector, for example `nams-hooks workspaces configure <platform> --scope project --workspace <workspace-id-or-name>`. Runtime state and logs are user-local under per-platform directories in `~/.nams/state/` and `~/.nams/logs/`.

Codex plugin installs use the same JSON and `NAMS_*` environment configuration path; Codex does not currently define NAMS credentials through plugin install prompts.

Gemini and OpenCode write session-scoped JSONL diagnostics. Events for one session are kept in a single file named like:

```text
~/.nams/logs/gemini/session-2026-05-11T15-40-1b11dfee.jsonl
```

Hook payload entries use `kind: "hook.event"` and keep the raw hook payload for local debugging. NAMS HTTP entries use `kind: "nams.request"` and include operation metadata plus logged request and response details. Request headers omit `Authorization`; request and response bodies are kept for debugging.

## Development

`nams-hooks` follows a strict "no runtime dependencies" rule for hook code and release artifacts. Development dependencies are allowed for TypeScript, generation, architecture checks, and tests as long as they stay out of runtime imports and published hook execution paths.

All platform-specific logic should be contained within its respective adapter in `src/platforms/`.

For more details on the design, see `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`.

For local development and generated marketplace testing, see [DEVELOPMENT.md](DEVELOPMENT.md).

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

# Build and verify the generated release package, including Claude and Codex plugin files
npm run package:check

# Regenerate and build the OpenAPI client, then run OpenAPI client tests directly
npm run openapi:test
```
