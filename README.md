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

For installation steps, see [INSTALL.md](INSTALL.md).

### Prerequisites

- Node.js (v20+)
- A NAMS API key and workspace ID

### Build and Test

```bash
# Compile TypeScript
npm run build

# Run tests (using Node's built-in runner)
npm test

# Run OpenAPI freshness check, build, and tests
npm run check

# Build and verify the generated release package, including Claude plugin files
npm run package:check

# Regenerate and build the OpenAPI client, then run OpenAPI client tests directly
npm run openapi:test
```

### Runtime Configuration And Storage

Runtime configuration is JSON-first: `~/.nams/config.json`, optional project `.nams/config.json`, Claude plugin user configuration when running inside a Claude plugin, then final `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides. `apiKey` and `workspaceId` are required for NAMS requests. Runtime state and logs are user-local under `~/.nams/state/<platform>/` and `~/.nams/logs/<platform>/`.

Gemini and OpenCode write session-scoped JSONL diagnostics. Events for one session are kept in a single file named like:

```text
~/.nams/logs/gemini/session-2026-05-11T15-40-1b11dfee.jsonl
```

Hook payload entries use `kind: "hook.event"` and keep the raw hook payload for local debugging. NAMS HTTP entries use `kind: "nams.request"` and include operation metadata plus logged request and response details. Request headers omit `Authorization`; request and response bodies are kept for debugging.

## Development

`nams-hooks` follows a strict "no runtime dependencies" rule for hook code and release artifacts. Development dependencies are allowed for TypeScript, generation, architecture checks, and tests as long as they stay out of runtime imports and published hook execution paths.

All platform-specific logic should be contained within its respective adapter in `src/platforms/`.

For more details on the design, see `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`.
