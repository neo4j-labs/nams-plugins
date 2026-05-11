# Gemini CLI Memory Flow Design

Date: 2026-05-11
Status: Approved design
Repository: nams-hooks

## Summary

This design completes the Gemini CLI memory flow in phases. Phase 1 implements the core conversation loop: create a NAMS conversation when the first user utterance arrives, recall relevant memory before the first response, persist user prompts, and persist assistant responses best-effort. Later phases add exposed reasoning summaries, tool metadata, and resume resilience.

Gemini hook payloads are the primary source for current-turn data. The Gemini transcript at `transcript_path` is a durable fallback and catch-up source, not the first choice when hook payload fields are present.

## Source Inputs

- Behavioral reference: `docs/nams-skill.md`
- Approved hook architecture: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- OpenAPI client contract: `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`
- Gemini transcript sample supplied during design review
- Gemini hook documentation: `https://geminicli.com/docs/hooks/reference/`
- Gemini command documentation: `https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md`
- ArchUnitTS documentation: `https://github.com/LukasNiessen/ArchUnitTS`

## Goals

- Make Gemini CLI the first complete memory-flow implementation.
- Keep memory writes deterministic and owned by the hook runner.
- Create NAMS conversations only when the first user utterance is observed.
- Use Gemini `session_id` as the primary session key, with cwd fallback.
- Search memory before the first assistant response and on known session resume.
- Persist user prompts reliably.
- Persist assistant responses from `prompt_response` when present, with transcript fallback.
- Persist exposed Gemini transcript `thoughts` as reasoning steps in the NAMS Reasoning Memory API after the core message flow is stable.
- Keep runtime dependencies limited to Node.js built-ins.
- Add architecture tests to prevent platform modules from importing each other or upstream layers.

## Non-Goals

- Eager conversation creation during `SessionStart`.
- Direct entity creation from hooks.
- Persisting private or unexposed hidden reasoning, token counts, or raw tool output.
- Live NAMS or live Gemini CLI testing as a Phase 1 completion gate.
- `NAMS_USER_ID` or `NAMS_CONTEXT_LIMIT` configuration in Phase 1.

## Phased Delivery

### Phase 1: Core Conversation Memory

Phase 1 implements the memory loop needed for normal Gemini CLI conversations.

`SessionStart` initializes local state only. It must not create a NAMS conversation. Conversation creation happens lazily in `BeforeAgent`, when the first user prompt is available.

`BeforeAgent` resolves the Gemini session, creates the NAMS conversation if local state does not yet have one, searches memory before the first response or when resuming a known conversation, stores the current user prompt, and returns Gemini-safe `additionalContext` when recall finds useful context. If recall fails, the hook allows Gemini to continue without injected memory.

`AfterAgent` stores the assistant response. The primary source is `prompt_response` from the hook payload. If `prompt_response` is absent or empty, the runtime reads `transcript_path` and stores unseen transcript entries with `type: "gemini"`.

Transcript fallback can also recover missed user turns when hook payloads are incomplete, but hook payload fields remain the preferred source for the current turn.

### Phase 2: Reasoning And Tool Metadata

Phase 2 records exposed Gemini transcript `thoughts` through the NAMS Reasoning Memory API. These entries are visible in Gemini transcripts as structured summaries with a subject, description, and timestamp. They are not treated as assistant messages, and they are not hidden reasoning invented or inferred by the hook runtime.

The runtime maps each exposed thought summary to a reasoning step:

- `conversationId`: current NAMS conversation id
- `reasoning`: thought `description`
- `actionTaken`: thought `subject`
- `result`: absent unless Gemini exposes a clear, safe result summary

Phase 2 also records tool metadata from both Gemini `AfterTool` hook payloads and transcript `toolCalls[]`. The runtime records metadata only:

- tool name
- sanitized and capped input
- optional step id
- status
- duration when available

Tool output is not persisted. Transcript `toolCalls[]` fields such as `result`, `resultDisplay`, and `functionResponse` are treated as output and are ignored. This preserves the v1 privacy boundary from the approved hook design.

### Phase 3: Resume And Transcript Resilience

Phase 3 hardens `/chat save`, `/chat resume`, and chat-list resume behavior. Gemini keeps a stable session id for saved and resumed chats; the runtime should use that `session_id` to reconnect to the same local state and NAMS conversation.

If local `.nams/state` is missing but the transcript header contains a stable `sessionId`, the runtime may rebuild enough local state to continue safely. Rebuild should remain conservative: it can recover transcript entry ids and create new local state, but it must not assume a remote NAMS conversation id unless that id is present in local state or another trusted local mapping.

### Phase 4: Trace Polish

Phase 4 may improve trace grouping and explanation support by associating tool calls with the nearest relevant reasoning step when Gemini payloads make that relationship clear. It must not infer hidden reasoning or fabricate reasoning steps that Gemini did not expose.

## Components

### Gemini Adapter And Parser

Gemini-specific code stays under `src/platforms/gemini/`. The adapter entrypoint is `src/platforms/gemini/index.ts`, and Gemini-only parser helpers live beside it. It extracts:

- `session_id`
- `cwd`
- `transcript_path`
- current prompt
- `prompt_response`
- tool fields in Phase 2

The CLI remains a gateway. It parses the typed event and dispatches through the static platform registry. It does not interpret Gemini payload fields.

### Config Loader

Phase 1 config supports only:

- `NAMS_API_KEY`, required for NAMS requests
- `NAMS_BASE_URL`, optional, defaulting to the generated client's default

Configuration loads `.nams/.env` first, then process environment variables as fallback. Missing `NAMS_API_KEY` is non-blocking for Gemini; the runtime logs a sanitized diagnostic and returns allow output.

### Session State Store

Session state lives under:

```text
.nams/state/sessions/gemini/<session-key>.json
```

Gemini session key selection:

1. Use hook `session_id` when present.
2. Fall back to a stable cwd-derived key when `session_id` is absent.

State shape:

```json
{
  "harness": "gemini",
  "harnessSessionId": "d8967d61-21a6-405f-bc44-b832df010b54",
  "sessionKey": "d8967d61-21a6-405f-bc44-b832df010b54",
  "projectDirectory": "/path/to/project",
  "conversationId": "nams-conversation-id",
  "createdAt": "2026-05-11T11:31:07.448Z",
  "lastMemorySearchAt": "2026-05-11T11:31:13.875Z",
  "lastUserMessageHash": "sha256...",
  "lastAssistantMessageHash": "sha256...",
  "seenTranscriptEntryIds": ["ac407eb2-...", "b1e76a69-..."],
  "seenReasoningStepHashes": ["sha256..."],
  "seenToolCallIds": ["google_web_search_1778501515807_1"]
}
```

`conversationId` is absent until the first `BeforeAgent` prompt creates the NAMS conversation.

### Session Logging

Gemini observability logs are session-scoped. All hook events and diagnostics for the same Gemini session append to one JSONL file:

```text
.nams/logs/session-2026-05-11T15-40-1b11dfee.jsonl
```

The timestamp segment comes from local session state `createdAt`, so later hooks reuse the same log file. The suffix is a short stable session-key part; cwd fallback sessions use a short hash rather than a long project path. If a platform cannot resolve session metadata, logging may fall back to the older event-scoped filename, but Gemini should use session-scoped logs whenever it has local state.

Platform logs preserve user prompt fields (`prompt`, `user_prompt`, `userPrompt`) to support local debugging. Redaction remains active for API keys, authorization headers, tokens, passwords, request/response bodies, assistant responses, tool outputs/results, and generic content fields. Diagnostic logs must not include raw exception text from failed NAMS calls.

### NAMS Memory Service

The memory service is a thin wrapper around `NamsClient`. It should expose hook-safe operations:

- create conversation
- recall before first response
- store user message
- store assistant message
- record reasoning step in Phase 2
- record tool metadata in Phase 2

Conversation creation sends minimal metadata:

```json
{
  "metadata": {
    "harness": "gemini",
    "projectDirectory": "/path/to/project"
  }
}
```

### Transcript Reader

The transcript reader parses newline-delimited JSON from `transcript_path`.

It handles:

- header records containing `sessionId`, `projectHash`, and timestamps
- `type: "user"` message entries
- `type: "gemini"` assistant entries
- exposed `thoughts` on `type: "gemini"` entries
- exposed `toolCalls` on `type: "gemini"` entries
- `type: "info"` lifecycle metadata
- `$set` update records

It ignores `$set`, token counts, and `info` records for memory writes by default. Transcript `thoughts` are not message content; Phase 2 processes them separately as reasoning-step candidates. Transcript `toolCalls[]` are not message content; Phase 2 processes them separately as tool metadata candidates. Transcript entry ids are used for duplicate suppression when available.

## Data Flow

### SessionStart

1. Parse hook payload in the Gemini adapter.
2. Resolve project directory.
3. Resolve session key from `session_id` or cwd fallback.
4. Create or refresh local state without `conversationId` if no conversation exists yet.
5. Return Gemini-safe allow output.

`SessionStart` never calls NAMS.

### BeforeAgent

1. Parse current prompt from the hook payload.
2. Resolve local session state.
3. If state has no `conversationId`, create the NAMS conversation.
4. If this is the first response for the conversation, search relevant memory using the first user prompt.
5. If resuming a known conversation, retrieve conversation context before responding.
6. Persist the user prompt unless duplicate suppression says it was already stored.
7. Update local state.
8. Return `additionalContext` when recall produced useful context.

The injected context should be concise and should instruct Gemini to use the context silently without narrating memory mechanics.

### AfterAgent

1. Resolve local session state.
2. Prefer `prompt_response` as the assistant response.
3. If `prompt_response` is missing or empty, read `transcript_path`.
4. Persist unseen `type: "gemini"` transcript entries.
5. Update assistant hashes and seen transcript ids.
6. Return Gemini-safe allow output.

### AfterTool

Phase 2 records sanitized tool metadata only. It must not persist raw tool output. When Gemini exposes both reasoning thoughts and tool calls in the same transcript turn, the runtime may attach the tool call to the nearest stored reasoning step. If the relationship is unclear, the tool call is recorded without a step id.

### Reasoning Step Capture

Phase 2 processes exposed transcript `thoughts` during transcript fallback or explicit trace-processing hooks. Each thought is deduplicated by transcript entry id, thought timestamp, subject, and description. Stored reasoning step ids may be retained in local state so later tool metadata can be associated when the relationship is clear.

### Tool Call Capture

Phase 2 processes tool calls from Gemini `AfterTool` hook payloads and transcript `toolCalls[]`.

Transcript tool calls map to NAMS tool-call records:

- `toolName`: `toolCall.name`
- `input`: sanitized and capped JSON serialization of `toolCall.args`
- `status`: `toolCall.status`
- `durationMs`: omitted unless Gemini exposes enough timing data for a reliable duration
- `stepId`: nearest stored reasoning step id from the same transcript entry when deterministic
- `output`: empty string or omitted

The runtime must not persist transcript tool output fields, including `result`, `resultDisplay`, `functionResponse`, and nested response output. Transcript tool calls are deduplicated by `toolCall.id` when present and by a stable hash of transcript entry id, tool name, args, status, and timestamp when no id exists.

### SessionEnd

Session end is not required for Phase 1. Future support may flush diagnostics or mark local state timestamps, but it must not delete local state or remote NAMS data.

## Duplicate Suppression

Duplicate suppression uses the most stable identifiers available:

1. Transcript entry ids for transcript-derived messages.
2. Hook event ids if Gemini exposes them.
3. Content hashes as fallback.

Hashes include:

- harness
- session key
- role
- normalized content

Local duplicate suppression should prevent repeated writes caused by hook replay or transcript fallback. It should not require querying NAMS before every message.

## Error Handling

Hooks are non-blocking by default.

If `NAMS_API_KEY` is missing:

- log a sanitized diagnostic under `.nams/logs/`
- return normal allow output
- do not print secrets or raw config values

If a NAMS call fails:

- log status and endpoint category
- avoid logging secrets and full message bodies
- allow Gemini to continue

If recall fails:

- continue without `additionalContext`
- still attempt user prompt persistence if possible

If assistant persistence fails:

- log the failure
- keep state conservative so duplicate suppression does not permanently hide an unstored response

If transcript reading fails:

- log the failure
- skip transcript fallback for that hook

## Privacy Rules

- Persist standard user and assistant messages as the canonical memory stream.
- Do not create entities directly from hooks.
- Do not store private or unexposed hidden reasoning.
- Persist Gemini transcript `thoughts` only when they are explicitly exposed in the transcript and only as NAMS reasoning steps, not as conversation messages.
- Do not persist raw tool output.
- Do not persist transcript `toolCalls[].result`, `resultDisplay`, `functionResponse`, or nested tool response output.
- Keep `.nams/.env`, `.nams/state/`, and `.nams/logs/` local and gitignored.
- Write only harness-specific JSON to stdout.

## Architecture Tests

Add ArchUnitTS as a dev dependency. Architecture tests should run under Node's built-in `node:test` runner through the existing `npm test` command.

The architectural dependency flow is downstream only:

```text
gateway -> registry -> adapters -> runtime -> generated client
```

Rules:

- Platform adapters must not import other platform adapters.
- `src/cli.ts` imports the platform registry, not concrete adapters.
- `src/platforms/index.ts` is the only module that imports all concrete adapters.
- `src/runtime/**` must not depend on `src/platforms/**` or `src/cli.ts`.
- `src/generated/**` must not depend on `src/runtime/**`, `src/platforms/**`, `src/cli.ts`, scripts, or docs.
- Platform adapters must not depend on `src/cli.ts`.

These tests guard against accidental architecture drift, such as Gemini code importing Codex behavior directly.

## Test Plan

Phase 1 tests are fixture-driven and mocked. No live NAMS or live Gemini CLI run is required to call Phase 1 complete.

Unit and fixture tests:

- Gemini `SessionStart` initializes local state without creating a NAMS conversation.
- Gemini `BeforeAgent` creates a NAMS conversation on the first prompt.
- Gemini `BeforeAgent` searches memory before the first response and injects `additionalContext`.
- Gemini `BeforeAgent` persists the user prompt.
- Gemini `AfterAgent` persists `prompt_response`.
- Gemini `AfterAgent` falls back to transcript `type: "gemini"` entries when `prompt_response` is missing.
- Transcript reader ignores `$set`, `info`, and token counts for memory writes.
- Phase 2 stores exposed transcript `thoughts` as reasoning steps without storing token counts or private reasoning.
- Phase 2 stores transcript `toolCalls[]` metadata while ignoring result/output fields.
- Session key selection uses `session_id` first and cwd fallback second.
- Duplicate suppression prevents repeat user and assistant writes.
- Missing `NAMS_API_KEY` and failed NAMS calls are logged without blocking Gemini.
- ArchUnitTS rules enforce downstream-only module dependencies.

Mocking strategy:

- Use injected fetch or a test double around the generated `NamsClient`.
- Use OS temp directories for `.nams/` state, logs, and transcript fixtures.
- Avoid network calls in all automated tests.

## Implementation Notes

- Capture representative Gemini hook payload fixtures before implementing the event parser, and pin field names in tests.
- Keep resume reconstruction from transcript headers conservative unless a trusted local NAMS conversation mapping exists.
- Capture representative `AfterTool` payload fixtures before implementing Phase 2 tool metadata.
