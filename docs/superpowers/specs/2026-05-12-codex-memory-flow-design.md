# Codex Memory Flow Design

Date: 2026-05-12
Status: Implemented design
Repository: nams-hooks

## Summary

This design brings Codex to the same practical NAMS integration level as the current Gemini CLI implementation: initialize local session state, recall relevant memory before model work, persist user prompts, persist assistant responses best-effort, and record exposed tool metadata.

The implementation reuses the existing shared runtime modules and keeps Codex-specific parsing under `src/platforms/codex/`. `src/cli.ts` remains a gateway: it validates the explicit typed `--event`, reads stdin JSON as an opaque object, and dispatches through the static platform registry. It must not infer the event from Codex payload fields.

## Source Inputs

- Approved hook architecture: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- OpenAPI client contract: `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`
- Gemini implementation reference: `src/platforms/gemini/`, `src/runtime/`, and `test/gemini/`
- Behavioral reference: `docs/nams-skill.md`
- Current Codex hook source, checked 2026-05-12:
  - `https://github.com/openai/codex/blob/main/codex-rs/hooks/src/schema.rs`
  - `https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/output_parser.rs`
  - `https://github.com/openai/codex/blob/main/codex-rs/core/src/hook_runtime.rs`
  - `https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/session_start.rs`
  - `https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/user_prompt_submit.rs`
  - `https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/stop.rs`
  - `https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/post_tool_use.rs`
  - `https://github.com/openai/codex/blob/main/codex-rs/config/src/hook_config.rs`

## Current State

Codex now implements the NAMS memory-flow integration for `SessionStart`, `UserPromptSubmit`, `Stop`, and `PostToolUse`. The template maps Codex-native hook names to generic NAMS lifecycle events, while Codex-specific parsing and transcript fallback remain under `src/platforms/codex/`.

The repository Codex hook template should use the known-working Codex command-hook shape, not the older short-form command object:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run codex --event SessionStart",
            "statusMessage": "Loading session notes"
          }
        ]
      }
    ]
  }
}
```

Future Codex memory hooks should extend this shape by adding event groups beside `SessionStart`. They should not reintroduce the stale `SessionStart` object that contains only `command`.

Gemini already implements the full memory loop through:

- `src/platforms/gemini/index.ts`
- `src/platforms/gemini/payload.ts`
- `src/platforms/gemini/transcript.ts`
- shared runtime modules for config, hashing, logging, session state, and NAMS REST calls

The Codex integration should mirror those boundaries rather than copying Gemini field names into shared code.

## Goals

- Keep Codex behavior behind the Codex adapter boundary.
- Keep `src/interfaces.ts` and `src/cli.ts` platform-agnostic by preserving the NAMS event vocabulary: `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- Use Codex `session_id` as the primary session key, with cwd fallback.
- Persist user-local state under `~/.nams/state/codex/<session-hash>.json`.
- Use session-scoped `~/.nams/logs/codex/session-<created-at>-<session-part>.jsonl` logs for Codex, matching the shared observability model.
- Create a NAMS conversation lazily on the first NAMS `BeforeAgent` event mapped from Codex `UserPromptSubmit`.
- Recall memory before the first response and inject it through Codex `UserPromptSubmit` additional context.
- Persist each user prompt from Codex `UserPromptSubmit` while handling it as NAMS `BeforeAgent`.
- Persist assistant responses from Codex `Stop.last_assistant_message` while handling it as NAMS `AfterAgent`, with transcript fallback when safe.
- Record Codex `PostToolUse` metadata while handling it as NAMS `AfterTool`, with sanitized input, exposed output, status, duration when available, and deterministic duplicate suppression.
- Keep hooks non-blocking when config is missing or NAMS calls fail.
- Preserve raw Codex hook payload logs for local debugging.

## Non-Goals

- Supporting Windows in this Codex plan.
- Using Codex `PreToolUse` to make policy decisions.
- Using `PermissionRequest`, `PreCompact`, or `PostCompact` for memory writes.
- Inferring hidden reasoning or scraping private chain-of-thought.
- Creating NAMS entities directly from hooks.
- Depending on live Codex or live NAMS in automated tests.
- Adding runtime npm dependencies.

## Codex Hook Surface

As of 2026-05-12, the public Codex source defines command hook inputs for `SessionStart`, `UserPromptSubmit`, `Stop`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, and `PostCompact`.

This design uses:

- `SessionStart`: initialize user-local state and write raw hook diagnostics. Codex may expose `source` values such as `startup`, `resume`, and `clear`, but the repository template intentionally matches the verified `startup|resume` flow until `clear` behavior is validated separately.
- `UserPromptSubmit`: parse `prompt`, recall memory, persist the user message, and inject additional context.
- `Stop`: parse `last_assistant_message` and persist the assistant response.
- `PostToolUse`: parse tool metadata and persist a NAMS reasoning step plus tool call.

The shared TypeScript interfaces model NAMS lifecycle events, not every platform's native hook names. Codex native hooks are translated at the Codex boundary:

| Codex hook | NAMS event | Purpose |
| --- | --- | --- |
| `SessionStart` | `SessionStart` | Initialize user-local session state and raw hook logging. |
| `UserPromptSubmit` | `BeforeAgent` | Recall relevant memory, create the NAMS conversation lazily, and persist the submitted user prompt before Codex responds. |
| `Stop` | `AfterAgent` | Persist the assistant response exposed by Codex after the turn completes. |
| `PostToolUse` | `AfterTool` | Persist exposed tool metadata, sanitized input, and exposed output after a Codex tool finishes. |

`src/cli.ts` continues to validate and route only the generic NAMS events. The Codex hook template performs the static hook-name translation by invoking commands such as `nams-hooks run codex --event BeforeAgent` from the Codex `UserPromptSubmit` hook. Inside the Codex adapter, `invocation.event` remains the source of truth for NAMS routing. Codex `hook_event_name` is parsed only as platform metadata and, when useful, for diagnostics or Codex-specific output fields; it must not be used to infer the NAMS event.

## Approaches Considered

### Recommended: NAMS Event Interface With Codex Translation

Keep `src/interfaces.ts` limited to NAMS events and implement Codex-specific translation in `templates/codex/hooks.json` plus `src/platforms/codex/`. The Codex hook template calls:

```bash
nams-hooks run codex --event BeforeAgent
nams-hooks run codex --event AfterAgent
nams-hooks run codex --event AfterTool
```

This is the clearest path for this repository because the CLI, shared contracts, tests, and future platforms stay aligned to NAMS lifecycle semantics. Codex's actual hook names remain visible in the Codex template, payload parser, logs, and Codex-specific output.

### Alternative: Add Codex-Native Events To Shared Interfaces

Add `UserPromptSubmit`, `Stop`, and `PostToolUse` to the shared typed event list and implement matching optional methods on `PlatformAdapter`. This preserves Codex names in the CLI, but it makes `src/interfaces.ts` a union of platform hook surfaces instead of a NAMS contract and pushes platform vocabulary outside the adapter boundary.

### Alternative: Transcript-First Capture

Ignore most hook payload fields and reconstruct memory from the Codex rollout transcript. This would reduce hook-event branching, but it would make first-response recall late or unreliable and would require more assumptions about transcript internals.

## Phased Delivery

### Phase 1: Core Conversation Memory

`SessionStart` initializes Codex local session state and session-scoped logging. It does not create a NAMS conversation. This matches Gemini's current behavior and avoids creating empty remote conversations for sessions that never receive a prompt.

Codex `UserPromptSubmit` maps to NAMS `BeforeAgent`. It resolves session state, creates a NAMS conversation if needed, recalls conversation context plus entity search context before the first response, persists the submitted user prompt unless it is a duplicate, and returns Codex-safe additional context:

```json
{
  "continue": true,
  "suppressOutput": true,
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Relevant memory context:\n..."
  }
}
```

The `additionalContext` property is the correct JSON field for this injection path. In the current Codex source, `UserPromptSubmitHookSpecificOutputWire` uses serde `rename_all = "camelCase"` with an internal `additional_context` field, `output_parser.rs` extracts it from `hookSpecificOutput`, and `hook_runtime.rs` records it as additional developer context for the model.

If recall is empty, the hook returns only the allow output. If NAMS is unavailable or `apiKey` is missing after JSON config and environment overlays, the hook logs a sanitized diagnostic and allows Codex to continue.

`SessionStart` and `UserPromptSubmit` may run close together on the first prompt in some Codex versions. `UserPromptSubmit` must be able to create initial state when `SessionStart` has not written it yet.

### Phase 2: Assistant Response Persistence

Codex `Stop` maps to NAMS `AfterAgent`. It persists the assistant response from `last_assistant_message` when it is a non-empty string. This is the primary assistant capture path because Codex exposes it directly in the hook input.

When `last_assistant_message` is missing, the adapter may read `transcript_path` and persist unseen assistant message entries from the Codex rollout JSONL. Transcript parsing is a fallback and should be conservative. It should accept only clear assistant message shapes, ignore developer/system messages, ignore compacted summaries as assistant messages, and leave state unchanged when parsing fails.

`stop_hook_active` is used only to avoid accidental continuation loops. NAMS persistence should still be best-effort and non-blocking.

### Phase 3: Tool Metadata

Codex `PostToolUse` maps to NAMS `AfterTool` and records exposed tool metadata. Codex currently provides:

- `tool_name`
- `tool_use_id`
- `tool_input`
- `tool_response`
- common fields such as `session_id`, `turn_id`, `cwd`, `transcript_path`, `model`, and `permission_mode`

The adapter creates a safe operational reasoning step, for example:

```text
Codex ran <tool_name> for the current turn.
```

Then it records the tool call through `NamsMemoryService.recordToolCall` with sanitized and capped input. Exposed `tool_response` may be stored as tool-call output when it is present in the hook payload, serialized safely, and capped. This is exposed post-tool data, not hidden reasoning.

Duplicate suppression uses Codex `tool_use_id` first. If absent, it falls back to a hash of session key, turn id, tool name, and normalized input.

Some Codex built-in tools, including web search in current Codex CLI rollouts, may be exposed as transcript `response_item` records instead of `PostToolUse` hook payloads. The Codex adapter may read `transcript_path` during `AfterAgent` and record conservative tool metadata from clear `web_search_call` response items. These entries use `web_search` as the NAMS tool name, store the exposed `action` object as sanitized input, store exposed status when present, and do not infer or persist page contents that Codex did not expose as tool output.

### Phase 4: Resume And Doctor Polish

Resume support uses the same `session_id` mapping as normal sessions. If user-local state exists, a resumed Codex `UserPromptSubmit` mapped to NAMS `BeforeAgent` continues the existing NAMS conversation. If user-local state is missing, the adapter may create a new conversation and should not guess an old remote `conversationId` from transcript content.

Installer and `doctor` behavior are outside this plan, but the design expects a later doctor command to report Codex hook availability, trusted project-hook status, and whether the installed Codex version supports `PostToolUse`.

## Components

### Codex Adapter

`src/platforms/codex/index.ts` orchestrates Codex events and owns Codex-specific behavior. It should reuse the Gemini orchestration pattern but not import Gemini modules.

Adapter methods:

- `startConversation(invocation: HookInvocation<"SessionStart">)`
- `beforeAgent?(invocation: HookInvocation<"BeforeAgent">)`
- `afterAgent?(invocation: HookInvocation<"AfterAgent">)`
- `afterTool?(invocation: HookInvocation<"AfterTool">)`

The Codex adapter owns the mapping from NAMS events back to Codex hook semantics:

- `beforeAgent` expects payloads from Codex `UserPromptSubmit`, reads `prompt`, and returns `hookSpecificOutput.hookEventName: "UserPromptSubmit"` when injecting `additionalContext`.
- `afterAgent` expects payloads from Codex `Stop`, reads `last_assistant_message`, and may read clear transcript tool-call records from `transcript_path`.
- `afterTool` expects payloads from Codex `PostToolUse` and reads `tool_name`, `tool_use_id`, `tool_input`, and `tool_response`.

### Codex Payload Parser

`src/platforms/codex/payload.ts` extracts Codex fields from `rawPayload`:

- `session_id`
- `turn_id`
- `cwd`
- `transcript_path`
- `hook_event_name`
- `prompt`
- `last_assistant_message`
- `stop_hook_active`
- `source`
- `tool_name`
- `tool_use_id`
- `tool_input`
- `tool_response`
- `model`
- `permission_mode`

The parser can read these fields by name, but it must not decide which NAMS event is being handled. `invocation.event` remains the source of truth for event routing.

### Codex Transcript Reader

`src/platforms/codex/transcript.ts` reads Codex rollout JSONL conservatively. It extracts user and assistant message candidates from clear `ResponseItem::Message` records and uses stable item ids when present. It also extracts exposed `web_search_call` response items as transcript-derived tool metadata. It ignores unsupported or ambiguous records.

### Shared Runtime

The existing runtime modules remain shared:

- `src/runtime/config.ts`
- `src/runtime/hashing.ts`
- `src/runtime/logging.ts`
- `src/runtime/memory-service.ts`
- `src/runtime/session-state.ts`

`SessionState.harness` already supports `"codex"`, and Codex uses the shared `~/.nams/state/<platform>/<session-hash>.json` layout.

`NamsMemoryService` may need one small addition: a safe tool-output serializer/cap so Codex `tool_response` cannot produce unbounded NAMS payloads.

## Data Flow

### SessionStart

1. Parse Codex payload.
2. Resolve project directory from `cwd`, falling back to the process cwd.
3. Resolve session key from `session_id`, falling back to cwd hash.
4. Load or create local session state.
5. Append a session-scoped raw hook log with `kind: "hook.event"`.
6. Save state.
7. Return allow output.

### BeforeAgent From Codex UserPromptSubmit

1. Parse `prompt`.
2. Resolve local state, creating it if needed.
3. Append raw hook payload log.
4. If no prompt is present, save state and allow.
5. Load NAMS config.
6. Create a NAMS conversation if no `conversationId` exists.
7. Recall conversation context and search entities when `lastRecallAt` is absent.
8. Persist the user prompt unless its duplicate hash has already been seen.
9. Save state.
10. Return additional context if recall produced useful content.

### AfterAgent From Codex Stop

1. Resolve local state.
2. Append raw hook payload log.
3. If no `conversationId` exists, save and allow.
4. Load NAMS config.
5. Persist `last_assistant_message` unless duplicate suppression says it was seen.
6. If `transcript_path` is present, read clear transcript candidates.
7. If no assistant message was exposed, persist unseen transcript assistant entries.
8. Persist conservative transcript-derived tool metadata for exposed built-in tool records such as `web_search_call`.
9. Save state.
10. Return allow output.

### AfterTool From Codex PostToolUse

1. Resolve local state.
2. Append raw hook payload log.
3. If no `conversationId` exists or no `tool_name` exists, save and allow.
4. Load NAMS config.
5. Deduplicate by `tool_use_id` or fallback hash.
6. Record an operational reasoning step.
7. Record the tool call with sanitized/capped input and exposed/capped output.
8. Save state.
9. Return allow output.

## Duplicate Suppression

Codex uses the existing local duplicate model:

- User prompt hash: platform, session key, role, normalized prompt.
- Assistant message hash: platform, session key, role, normalized assistant text.
- Transcript entry ids: only when present in the rollout JSONL.
- Tool call ids: Codex `tool_use_id` when present.
- Tool fallback hash: session key, turn id, tool name, normalized tool input.
- Transcript tool fallback hash: session key, transcript entry index, tool name, and normalized tool input.

Duplicate suppression is local-only and must not require a NAMS query.

## Error Handling

Codex hooks must fail open for memory concerns:

- Missing `apiKey` after JSON config and environment overlays: log a fixed sanitized diagnostic and allow.
- NAMS request failure: log endpoint/request metadata without API keys and allow.
- Transcript parse failure: log a diagnostic and skip transcript fallback.
- Observability log write failure: do not block hook output.

The hook runner should never print API keys or raw secret values to stdout, stderr, logs, or tests.

## Privacy Rules

- Persist standard user and assistant messages as the canonical stream.
- Do not create entities directly.
- Do not store hidden chain-of-thought.
- Store Codex `PostToolUse` output only from exposed hook payload fields, with capping.
- Store transcript-derived Codex tool metadata only from explicit tool-call response items such as `web_search_call`; do not persist encrypted reasoning or infer hidden tool output from UI text.
- Sanitize tool input with the existing recursive output-field removal before storage.
- Keep persistent runtime state and logs under user-local `~/.nams/`.
- Keep project `.nams/config.json` as the only project-local NAMS file, and ensure it is gitignored.
- Do not use `.env` files for the target configuration model.
- Write only Codex hook-compatible JSON to stdout.

## Testing Plan

Automated tests are fixture-driven and mocked:

- Codex `SessionStart` initializes session state without creating a NAMS conversation.
- NAMS `BeforeAgent` mapped from Codex `UserPromptSubmit` creates the conversation lazily.
- NAMS `BeforeAgent` mapped from Codex `UserPromptSubmit` recalls memory and returns Codex `hookSpecificOutput.additionalContext`.
- NAMS `BeforeAgent` mapped from Codex `UserPromptSubmit` persists the user prompt and deduplicates repeats.
- NAMS `AfterAgent` mapped from Codex `Stop` persists `last_assistant_message`.
- NAMS `AfterAgent` mapped from Codex `Stop` falls back to transcript assistant entries when `last_assistant_message` is absent.
- NAMS `AfterAgent` mapped from Codex `Stop` records exposed transcript `web_search_call` metadata.
- NAMS `AfterTool` mapped from Codex `PostToolUse` records a reasoning step and tool call.
- NAMS `AfterTool` mapped from Codex `PostToolUse` deduplicates by `tool_use_id`.
- NAMS `AfterTool` mapped from Codex `PostToolUse` sanitizes/caps tool input and caps tool output.
- Missing config and NAMS failures are non-blocking and sanitized.
- CLI routing accepts only generic NAMS events and ignores payload `hook_event_name` for routing.
- Codex hook template includes `SessionStart`, `UserPromptSubmit`, `Stop`, and `PostToolUse` keys that invoke generic NAMS events.
- Architecture tests continue to prevent cross-platform imports.

## Open Risks

- Codex hooks are still changing. The implementation should keep unsupported events out of v1 and make future doctor checks explicit.
- Some Codex versions require hook trust or feature flags before hooks run. This design does not solve installer/doctor trust flow.
- `PostToolUse` may not fire for every internal tool. Tool metadata is best-effort, with transcript-derived coverage only for clear exposed records currently understood by the adapter.
- Assistant response capture through `Stop.last_assistant_message` depends on Codex emitting the field consistently.
- Transcript rollout format is not the primary contract for hooks. Fallback parsing must stay conservative.
