# nams-hooks

`nams-hooks` is a dependency-light Node.js integration layer that connects local AI agent harness hooks to the **Neo4j Agent Memory Service (NAMS)**.

It ensures deterministic memory persistence and context recall across different agent platforms without requiring the agents themselves to manage the memory logic.

## Key Features

- **Deterministic Memory**: Automatically persists user and assistant messages to NAMS.
- **Memory Recall**: Searches and injects relevant past context before the agent responds.
- **Tool Logging**: Records tool-call metadata (name, input, status, duration) for observability.
- **Platform Aware**: Native support for **Claude Code**, **Gemini CLI**, and **Codex** via a clean adapter architecture.
- **Zero Runtime Dependencies**: Built using only Node.js built-in modules for maximum portability and security.
- **Local-First Configuration**: Stores secrets and state in a local `.nams/` directory.

## Platform Support (v1)

- **OS**: macOS
- **Harnesses**:
  - [Claude Code](https://code.claude.com/docs/en/hooks)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli)
  - Codex

## Architecture

- `src/cli.ts`: Entry point that dispatches events to platform adapters.
- `src/platforms/`: Contains adapter logic for Claude, Gemini, and Codex.
- `src/interfaces.ts`: Shared contracts and hook event definitions.
- `templates/`: Configuration templates for various harnesses.

## Getting Started

### Prerequisites

- Node.js (v20+)
- A NAMS API Key

### Installation

1. Clone the repository.
2. Install development dependencies:
   ```bash
   npm install
   ```
3. Configure your environment:
   Create a `.nams/.env` file with your NAMS API key:
   ```env
   NAMS_API_KEY=your_api_key_here
   ```

### Build and Test

```bash
# Compile TypeScript
npm run build

# Run tests (using Node's built-in runner)
npm test

# Run build and tests
npm run check

# Regenerate the OpenAPI client and run OpenAPI client tests
npm run openapi:test

# Generate distribution artifacts and link for Gemini CLI
npm run dist
gemini extensions link ./dist
```

### Runtime Logs

Gemini writes local JSONL diagnostics under the project `.nams/logs/` directory. Events for one Gemini session are kept in a single file named like:

```text
.nams/logs/session-2026-05-11T15-40-1b11dfee.jsonl
```

Hook payload entries use `kind: "hook.event"` and keep the raw hook payload for local debugging. NAMS HTTP entries use `kind: "nams.request"` and include operation metadata plus logged request and response details. Request headers omit `Authorization`; request and response bodies are kept for debugging.

## Development

`nams-hooks` follows a strict "no runtime dependencies" rule. All platform-specific logic should be contained within its respective adapter in `src/platforms/`.

For more details on the design, see `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`.
