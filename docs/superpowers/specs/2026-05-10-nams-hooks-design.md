# NAMS Hooks Design

Date: 2026-05-10
Status: Approved design
Repository: nams-hooks

## Summary

`nams-hooks` is a standalone, dependency-free Node.js integration layer that connects local agent harness hooks to the Neo4j Agent Memory Service (NAMS) REST API. The first iteration supports macOS project-level installs for Codex, Claude Code, and Gemini CLI.

The hook runner owns deterministic memory persistence. Agents receive recalled context, but they are not responsible for deciding whether to write memory. The runner stores conversation messages, recalls relevant memory before agent work, and records limited tool metadata through NAMS REST endpoints.

## Source Inputs

- Behavioral reference: `docs/nams-skill.md`
- NAMS OpenAPI contract: `https://memory.neo4jlabs.com/openapi.json`
- Local OpenAPI copy inspected from nearby NAMS repo: `services/nams-api/docs/swagger.json`
- Claude Code hooks reference: `https://code.claude.com/docs/en/hooks`
- Gemini CLI hooks reference: `https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md`
- Codex hooks behavior note: `https://github.com/openai/codex/issues/16486`

## Goals

- Provide deterministic memory behavior through harness hooks and REST API calls.
- Support Codex, Claude Code, and Gemini CLI on macOS in v1.
- Install per project, not globally.
- Use plain Node.js built-in modules only. No npm dependencies.
- Persist standard user and assistant messages as the primary memory stream.
- Recall memory before agent responses and inject concise context plus a short operating instruction.
- Store tool-call metadata without storing tool output.
- Keep secrets and state local to `.nams/`.

## Non-Goals For v1

- Windows support.
- Global user-level install.
- MCP-driven memory writes.
- Explicit entity creation from hook logic.
- Full raw tool input/output capture.
- Guaranteed assistant response capture for every harness if the harness does not expose it cleanly.

## Approach

Use a single shared Node.js runtime with thin per-harness project hook configurations.

Generated hook configs call the same entry point:

```bash
node .nams/runtime/nams-hooks.mjs claude
node .nams/runtime/nams-hooks.mjs codex
node .nams/runtime/nams-hooks.mjs gemini
```

The runtime reads hook JSON from `stdin`, detects the event from the payload when possible, and routes internally. Harness configuration should stay small and declarative.

This approach avoids per-harness logic drift while still respecting each platform's hook event names and JSON shapes.

## Project Layout

```text
nams-hooks/
  bin/
    nams-hooks.mjs
  install.mjs
  templates/
    claude/
      settings.local.json
    codex/
      hooks.json
    gemini/
      settings.json
  docs/
    nams-skill.md
    superpowers/specs/2026-05-10-nams-hooks-design.md
```

Installed project layout:

```text
target-project/
  .nams/
    .env
    .env.example
    runtime/
      nams-hooks.mjs
    state/
      sessions/
        claude/
        codex/
        gemini/
    logs/
  .claude/settings.local.json
  .codex/hooks.json
  .gemini/settings.json
```

## Configuration

Configuration is loaded from `.nams/.env` first. Real environment variables are used as fallback for missing values.

Required:

- `NAMS_API_KEY`: NAMS workspace API key, sent as `Authorization: Bearer <key>`.

Optional:

- `NAMS_BASE_URL`: defaults to `https://memory.neo4jlabs.com`.
- `NAMS_USER_ID`: optional user identifier for conversation creation.
- `NAMS_CREATE_CONVERSATION_ON_SESSION_START`: defaults to false; otherwise conversation is created on first prompt.
- `NAMS_CONTEXT_LIMIT`: maximum recalled context size for injected context.
- `NAMS_TOOL_INPUT_LIMIT`: maximum serialized tool input size.
- `NAMS_LOG_LEVEL`: default `info`.

Secrets remain outside committed harness configs. The installer adds `.nams/.env`, `.nams/state/`, and `.nams/logs/` to `.gitignore`.

## Session State

Do not rely on the agent harness as a mutable variable store. Harness IDs are keys, not storage.

The runtime persists session state under `.nams/state/sessions/<harness>/<session-key>.json`:

```json
{
  "harness": "claude",
  "harnessSessionId": "abc123",
  "conversationId": "nams-conversation-uuid",
  "createdAt": "2026-05-10T09:00:00.000Z",
  "lastPromptHash": "sha256",
  "lastAssistantHash": "sha256",
  "lastStepId": null
}
```

Session key strategy:

- Claude Code: prefer `session_id`; retain `transcript_path` and `cwd` as supporting metadata.
- Codex: prefer `session_id` when present; use `cwd` and payload metadata as fallback. The `doctor` command should report detected Codex hook support because this surface is still moving.
- Gemini CLI: prefer a session field if present; otherwise use project path plus stable request metadata from hook payloads.

If no state exists on a user prompt event, the runtime creates a NAMS conversation and stores the mapping locally.

## NAMS REST Mapping

Conversation creation:

- `POST /v1/conversations`
- Body: `{ "userId": "<NAMS_USER_ID if configured>", "metadata": {} }`

Message persistence:

- `POST /v1/conversations/{conversationId}/messages`
- User body: `{ "role": "user", "content": "<prompt>" }`
- Assistant body: `{ "role": "assistant", "content": "<response>" }`

Bulk message persistence may be used only when a harness exposes both user and assistant messages together and duplicate suppression remains reliable:

- `POST /v1/conversations/{conversationId}/messages/bulk`

Recall:

- Prefer `GET /v1/conversations/{conversationId}/context` when a conversation already exists.
- Use `POST /v1/entities/search` or `POST /v1/conversations/{conversationId}/search` when the prompt provides useful query terms.

Tool metadata:

- `POST /v1/reasoning/tool-calls`
- Body fields:
  - `stepId`: optional, from local state when available
  - `toolName`
  - `input`: sanitized and capped serialized tool input
  - `output`: empty string
  - `status`
  - `durationMs`

Reasoning steps:

- v1 may support `POST /v1/reasoning/steps` for operational summaries when a harness exposes a clean summary. It must not store hidden chain-of-thought. This is secondary to message and tool-call persistence.

Entity persistence:

- v1 does not call entity creation endpoints directly. It relies on NAMS async entity extraction from stored messages.

## Hook Event Behavior

Session start:

- Load config.
- Initialize local state if a stable session key is available.
- Optionally create the NAMS conversation early if configured.
- Return harness-specific empty or context-safe JSON.

User prompt submit or before-agent:

- Resolve or create session state and NAMS conversation.
- Recall relevant memory.
- Store the user prompt using the messages endpoint.
- Return harness-specific `additionalContext` with:
  - relevant memory context
  - a short instruction that the agent should use the context silently and avoid narrating memory mechanics

Tool completion:

- Record tool metadata when the harness exposes a post-tool event.
- Persist `toolName`, sanitized `input`, optional `stepId`, status, and duration.
- Do not persist actual output.

Assistant complete or stop:

- Store assistant response when available from hook payload or transcript.
- Use local hashes to suppress duplicate assistant messages.
- If response capture is not clean for a harness, skip it and log a diagnostic.

Session end:

- Flush local logs/state.
- Do not delete remote NAMS data.

## Harness Notes

Claude Code:

- Strong v1 support because hook inputs include `session_id`, `transcript_path`, `cwd`, and event-specific fields.
- Use project-level `.claude/settings.local.json` by default so generated local commands and secrets do not need to be committed.
- Use `UserPromptSubmit`, `PostToolUse`, and `Stop`.

Gemini CLI:

- Use project-level `.gemini/settings.json`.
- Use `SessionStart`, `BeforeAgent`, `AfterTool`, and `AfterAgent` where available.
- `BeforeAgent` can inject relevant memory context.
- `AfterAgent` can persist assistant responses when `prompt_response` or equivalent is present.

Codex:

- Use project-level `.codex/hooks.json`.
- Use `SessionStart`, `UserPromptSubmit`, and `Stop`.
- Tool-level capture is included only if the installed Codex version exposes supported tool hooks.
- `doctor` should identify missing or partial Codex hook support and report it clearly.

## Duplicate Suppression

Hooks may replay or expose the same text through multiple events. The runtime uses SHA-256 hashes stored in session state to suppress duplicate user and assistant messages.

The hash input includes:

- harness
- session key
- role
- normalized message content
- event timestamp bucket or turn index when available

Suppression is local-only. It should avoid duplicate writes without requiring a NAMS query before every message.

## Error Handling

Hooks are non-blocking by default.

If NAMS is unavailable, the API key is missing, or a REST call fails:

- log the failure under `.nams/logs/`
- do not expose API keys or secrets in logs
- return normal allow or empty JSON to the harness
- let agent work continue

If recall fails, the prompt proceeds without injected memory context.

Installer errors are stricter. The installer should refuse unsafe overwrites and should create timestamped backups before modifying existing harness configs.

## Security And Privacy

- `.nams/.env`, `.nams/state/`, and `.nams/logs/` are local and gitignored.
- API keys are never printed to stdout or logs.
- Tool outputs are not stored in v1.
- Tool inputs are serialized conservatively and capped.
- Standard messages are persisted as authored because they are the canonical memory stream.
- The hook runner writes only harness-specific JSON to stdout. Diagnostics go to logs or stderr depending on harness tolerance.

## Installer Behavior

`node install.mjs --harness claude,gemini,codex` installs into the current project by default.

The installer:

- creates `.nams/runtime/`, `.nams/state/`, and `.nams/logs/`
- copies or references `bin/nams-hooks.mjs`
- creates `.nams/.env.example`
- ensures `.nams/.env`, `.nams/state/`, and `.nams/logs/` are gitignored
- writes or merges harness hook configs
- backs up existing config files before changing them
- prints next steps for setting `NAMS_API_KEY`

Future installer commands may include:

- `doctor`
- `uninstall`
- `status`

## Testing Plan

Unit tests:

- config precedence: `.nams/.env` values are primary and environment variables fill missing values
- session-state creation and lookup
- REST request shaping
- duplicate message suppression
- harness payload parsing
- harness output formatting
- tool input sanitization and size capping

Fixture tests:

- Claude: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`
- Gemini: `SessionStart`, `BeforeAgent`, `AfterTool`, `AfterAgent`
- Codex: `SessionStart`, `UserPromptSubmit`, `Stop`; tool hooks only when supported by the installed version

Installer tests:

- creates `.nams` structure
- merges or backs up existing configs
- updates `.gitignore` idempotently
- reports installed harnesses

Manual validation:

- run `node bin/nams-hooks.mjs doctor`
- install into a throwaway macOS project
- start each harness and send a prompt
- confirm one NAMS conversation is created
- confirm user messages persist
- confirm assistant messages persist where exposed
- run a tool call and confirm metadata persists without output
- restart or resume a harness and confirm conversation reuse when the harness session ID matches

## Open Risks

- Codex hook support is still evolving. v1 should degrade gracefully and make `doctor` explicit about supported events.
- Gemini session identity may require fallback keys if the hook payload lacks a stable session ID.
- Assistant response capture may be best-effort for some harness versions.
- Prompt/context injection may be visible in some harness UIs even when intended as model context.
- NAMS REST API shape may drift from the local OpenAPI copy. Tests should read fixture contracts from the hosted OpenAPI where possible.

## Approval Record

Approved decisions from brainstorming:

- Standalone `nams-hooks` repo.
- First iteration: Codex, Claude Code, Gemini CLI on macOS.
- Project-level installation.
- Plain Node.js with built-in modules only.
- `.nams/.env` plus real environment variables, with environment variables as fallback.
- Deterministic REST writes from hook runner, not MCP-driven writes.
- Persist user messages and assistant responses as the core memory stream.
- Store assistant responses in v1 where harnesses expose them cleanly.
- Store tool-call metadata without actual output.
- Rely on NAMS async entity extraction from stored messages.
