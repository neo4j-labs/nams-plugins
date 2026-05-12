# Claude Code Memory Flow Design

Date: 2026-05-12
Status: Draft design
Repository: nams-hooks

## Summary

This design brings Claude Code to the same integration level as the current Gemini CLI implementation on `devel`. Claude gets deterministic NAMS conversation creation, first-turn recall, user prompt persistence, assistant response persistence, tool-call metadata, raw local observability logs, and local session state under `.nams/`.

The Claude path should use Claude Code hook payload fields directly. Unlike Gemini, Claude does not need a transcript-first or transcript-fallback path for v1 because the supported hooks expose the required current-turn data: `UserPromptSubmit.prompt`, `PostToolUse.tool_name`, `PostToolUse.tool_input`, `PostToolUse.tool_response`, `PostToolUse.tool_use_id`, `PostToolUse.duration_ms`, and `Stop.last_assistant_message`.

## Source Inputs

- Approved architecture: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- OpenAPI client contract: `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`
- Gemini implementation design: `docs/superpowers/specs/2026-05-11-gemini-memory-flow-design.md`
- Gemini implementation plan: `docs/superpowers/plans/2026-05-11-gemini-memory-flow.md`
- Behavioral reference: `docs/nams-skill.md`
- Current Gemini source: `src/platforms/gemini/index.ts`, `src/platforms/gemini/payload.ts`, `src/platforms/gemini/transcript.ts`
- Current shared runtime: `src/runtime/config.ts`, `src/runtime/session-state.ts`, `src/runtime/memory-service.ts`, `src/runtime/logging.ts`
- Claude Code hooks reference, checked on 2026-05-12: `https://code.claude.com/docs/en/hooks`

## Current State On `devel`

The branch already has a complete Gemini memory flow:

- `src/cli.ts` accepts typed hook events from `--event` and keeps platform payload parsing out of the gateway.
- `src/interfaces.ts` declares `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- `src/platforms/gemini/index.ts` owns session state, NAMS calls, context injection, assistant persistence, and tool traces.
- `src/runtime/*` provides shared config loading, state persistence, hashing, logging, and `NamsMemoryService`.
- `templates/gemini/hooks/hooks.json` wires Gemini `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`.

Claude currently has only the walking-skeleton adapter in `src/platforms/claude/index.ts`. It logs `SessionStart` payloads to `.nams/logs/claude-session-start.jsonl` and returns allow output. `templates/claude/settings.local.json` wires only `SessionStart`.

## Goals

- Add Claude Code memory flow parity with Gemini's implemented level.
- Keep `src/cli.ts` as a typed gateway; do not infer events from `hook_event_name`.
- Keep Claude-specific parsing and orchestration under `src/platforms/claude/`.
- Use the existing generated `NamsClient` through `NamsMemoryService`.
- Use Claude `session_id` as the primary local session key, with cwd fallback.
- Create NAMS conversations lazily on first `UserPromptSubmit`, not on `SessionStart`.
- Recall memory before Claude's first model response for the session and inject it as Claude `additionalContext`.
- Persist every Claude user prompt observed through `UserPromptSubmit`.
- Persist Claude assistant responses from `Stop.last_assistant_message`.
- Record successful Claude `PostToolUse` events as a safe operational reasoning step plus NAMS tool-call metadata.
- Store exposed tool output from `tool_response`, serialized and capped, because Claude provides it explicitly in the hook payload.
- Keep hooks non-blocking on missing config, NAMS failures, and local log failures.

## Non-Goals

- Runtime OpenAPI discovery or schema inspection.
- Direct entity creation from hooks.
- Parsing hidden chain-of-thought or transcript-only private reasoning.
- Claude transcript parsing in the first Claude implementation pass.
- Claude `PreToolUse`, `PostToolUseFailure`, `PostToolBatch`, `StopFailure`, `SessionEnd`, subagent hooks, or prompt-based hooks.
- Installer, doctor, or release automation changes beyond the Claude hook template.
- Any new runtime npm dependency.

## Approach Options

### Option 1: Event-Native Claude Adapter

Extend shared hook events with Claude's native event names: `UserPromptSubmit`, `PostToolUse`, and `Stop`. Add optional adapter methods for those events and implement them only in `ClaudeAdapter`.

This is the recommended approach. It preserves typed explicit events, keeps platform payload fields in the platform adapter, and avoids renaming Claude events into Gemini concepts.

### Option 2: Normalize Claude Events To Gemini-Like Events

Map Claude `UserPromptSubmit` to a shared `BeforeAgent` behavior, Claude `PostToolUse` to `AfterTool`, and Claude `Stop` to `AfterAgent`.

This creates less interface surface, but it blurs platform behavior. Claude's `UserPromptSubmit` output shape is not the same as Gemini's `BeforeAgent` output, and future bug reports would have two platform names hiding behind one event.

### Option 3: Generic Adapter `handle()` Method

Replace event-specific adapter methods with one generic method that receives every typed event.

This simplifies CLI routing but weakens TypeScript coverage. New events would no longer force platform-specific implementation decisions at compile time.

## Recommended Design

Use Option 1. Add native Claude events to `src/interfaces.ts` and route them through `src/cli.ts` while leaving existing Gemini behavior intact.

The adapter contract grows deliberately:

```ts
export const hookEvents = [
  "SessionStart",
  "BeforeAgent",
  "AfterAgent",
  "AfterTool",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
] as const;

export interface PlatformAdapter {
  startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult>;
  beforeAgent?(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult>;
  afterAgent?(invocation: HookInvocation<"AfterAgent">): Promise<HookResult>;
  afterTool?(invocation: HookInvocation<"AfterTool">): Promise<HookResult>;
  userPromptSubmit?(invocation: HookInvocation<"UserPromptSubmit">): Promise<HookResult>;
  postToolUse?(invocation: HookInvocation<"PostToolUse">): Promise<HookResult>;
  stop?(invocation: HookInvocation<"Stop">): Promise<HookResult>;
}
```

Platforms that do not implement a method continue to return allow output. This keeps Codex and Gemini stable while Claude gains its native hook events.

## Claude Components

### Claude Payload Parser

Create `src/platforms/claude/payload.ts`.

It extracts only Claude fields needed by the adapter:

- `session_id` as `sessionId`
- `cwd` as `projectDirectory`, falling back to `processCwd`
- `transcript_path` as diagnostic metadata only
- `source` for `SessionStart` logging metadata
- `prompt` for `UserPromptSubmit`
- `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, and `duration_ms` for `PostToolUse`
- `last_assistant_message` for `Stop`

The parser must not trust `hook_event_name` for routing. That field stays in raw logs only.

### Claude Adapter

`src/platforms/claude/index.ts` becomes the orchestration entrypoint. It should mirror the Gemini adapter structure where useful:

- resolve payload info
- create or load local session state
- append raw `hook.event` logs
- load NAMS config only when a hook needs NAMS
- create `NamsMemoryService` with an `onRequest` callback for `nams.request` logs
- save state before returning
- catch config, NAMS, and log errors so Claude continues

### Shared Runtime Changes

`NamsMemoryService.recordToolCall()` currently serializes input and accepts an output string. Claude should add output serialization and capping so structured `tool_response` objects can be persisted safely:

```ts
export function serializeToolOutput(output: unknown): string {
  const serialized = typeof output === "string" ? output : JSON.stringify(output ?? {});
  if (serialized.length <= 4000) {
    return serialized;
  }
  return `${serialized.slice(0, 3986)}...[truncated]`;
}
```

The exact helper name can live in `src/runtime/memory-service.ts` with `serializeToolInput` to avoid a new module.

## Hook Data Flow

### SessionStart

Claude `SessionStart` fires for `startup`, `resume`, `clear`, and `compact`.

Flow:

1. Parse `session_id`, `cwd`, `transcript_path`, and `source`.
2. Resolve or create local session state under `.nams/state/sessions/claude/`.
3. Append a raw `hook.event` log using session-scoped log naming.
4. Save state without creating a NAMS conversation.
5. Return `{ "continue": true, "suppressOutput": true }`.

No memory recall happens here. `UserPromptSubmit` has the actual user prompt and is the better deterministic recall point.

### UserPromptSubmit

Claude `UserPromptSubmit` fires after the user submits a prompt and before Claude processes it.

Flow:

1. Parse `prompt`.
2. Resolve or create local session state.
3. Append raw hook payload to the session log.
4. If `prompt` is blank, save state and allow.
5. Load `.nams/.env` with process environment fallback.
6. If config is missing, log fixed diagnostic `"NAMS_API_KEY missing"` and allow.
7. Create NAMS conversation if state has no `conversationId`.
8. On first recall for this session, call `getConversationContext` and `searchEntities(prompt)`.
9. Combine successful recall sources with `combineMemoryContexts()`.
10. Store the user prompt unless the local prompt hash has already been seen.
11. Save state.
12. Return allow output. When recall produced context, include:

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

The adapter must not return top-level `additionalContext`. The Claude docs show `additionalContext` inside `hookSpecificOutput` for structured output, and that mirrors Gemini's explicit event-specific output shape.

### PostToolUse

Claude `PostToolUse` fires after a tool succeeds. It provides `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, and optional `duration_ms`.

Flow:

1. Resolve state and append raw hook payload.
2. If there is no `conversationId`, save state and allow. Do not create a conversation solely for a tool call.
3. If `tool_name` is missing or blank, save state and allow.
4. Load config. Missing config logs a fixed diagnostic and allows.
5. Deduplicate by `tool_use_id` when present. Otherwise use session key plus normalized tool name and input hash.
6. Create a safe operational reasoning step:

```json
{
  "conversationId": "<conversation-id>",
  "reasoning": "Claude Code ran <toolName> with the provided tool input.",
  "actionTaken": "Ran <toolName>"
}
```

7. Record a NAMS tool call:

```json
{
  "stepId": "<step-id if available>",
  "toolName": "<toolName>",
  "input": "<sanitized serialized input>",
  "output": "<serialized capped tool_response>",
  "status": "success",
  "durationMs": 12
}
```

8. Mark the tool call seen only after the NAMS write succeeds.
9. Save state and allow.

### Stop

Claude `Stop` fires when the main Claude Code agent finishes responding. It exposes `last_assistant_message`.

Flow:

1. Resolve state and append raw hook payload.
2. If there is no `conversationId`, save state and allow.
3. If `last_assistant_message` is missing or blank, save state and allow.
4. Load config. Missing config logs a fixed diagnostic and allows.
5. Store the assistant message unless the local assistant hash has already been seen.
6. Save state and return `{ "continue": true, "suppressOutput": true }`.

The hook must not return `decision: "block"` or `reason`; NAMS persistence must not force Claude to continue.

## Local State

Claude uses the existing `SessionState` shape:

```json
{
  "harness": "claude",
  "harnessSessionId": "abc123",
  "sessionKey": "abc123",
  "projectDirectory": "/path/to/project",
  "conversationId": "nams-conversation-id",
  "createdAt": "2026-05-12T09:00:00.000Z",
  "lastRecallAt": "2026-05-12T09:01:00.000Z",
  "lastUserMessageHash": "sha256...",
  "lastAssistantMessageHash": "sha256...",
  "seenAssistantMessageHashes": ["sha256..."],
  "seenTranscriptEntryIds": [],
  "seenReasoningStepHashes": ["sha256..."],
  "seenToolCallIds": ["claude-id:sha256..."],
  "reasoningStepIdsByHash": {
    "sha256...": "step-id"
  }
}
```

Claude does not populate `seenTranscriptEntryIds` in v1. It remains present because the shared state type already includes it.

## Logging

Claude should move from the current event-scoped walking-skeleton log to session-scoped logs when session state exists. That gives the same debugging ergonomics as Gemini:

```text
.nams/logs/session-2026-05-12T09-00-1f3870be.jsonl
```

All Claude records include:

- `timestamp`
- `harness: "claude"`
- typed `event`
- `kind`
- raw `payload` for `hook.event`
- sanitized generated-client request events for `nams.request`

Diagnostics use fixed messages only:

- `"NAMS_API_KEY missing"`
- `"NAMS request failed"`

The adapter must not log raw thrown error text because errors can contain secrets or prompt content.

## Template Wiring

Update `templates/claude/settings.local.json`:

- Keep `SessionStart` matcher `startup|resume|clear|compact`.
- Add `UserPromptSubmit`.
- Add `PostToolUse` with matcher `"*"`.
- Add `Stop`.

Each command uses `nams-hooks run claude --event <TypedEvent>`.

## Error Handling

Claude hooks remain non-blocking:

- Missing `NAMS_API_KEY`: log diagnostic, allow.
- NAMS create, recall, message, reasoning, or tool-call failure: log fixed diagnostic, allow.
- Recall failure from one source: try the other source and still attempt user-message persistence.
- User-message failure after recall succeeds: return the recall context and allow.
- Assistant or tool persistence failure: save conservative state so the next hook can retry where practical.
- Observability log write failure: allow hook execution to continue.

## Privacy Rules

- Persist user prompts and assistant responses as the canonical memory stream.
- Persist Claude `tool_response` only because it is explicit hook output; serialize and cap it.
- Sanitize tool input with the existing `serializeToolInput()` behavior before sending it to NAMS.
- Do not parse Claude transcript internals for hidden reasoning in v1.
- Do not create entities directly.
- Do not print or log API keys.
- Diagnostics never include arbitrary exception text.

## Test Plan

Fixture-driven tests cover:

- CLI routes Claude `UserPromptSubmit`, `PostToolUse`, and `Stop` only from typed `--event`.
- Claude parser extracts session, cwd, prompt, tool, duration, and assistant fields.
- `SessionStart` initializes local state and does not call NAMS.
- `UserPromptSubmit` creates conversation lazily, recalls memory, injects Claude `additionalContext`, and stores the user prompt.
- `UserPromptSubmit` deduplicates repeated prompts.
- Missing config and NAMS failures allow Claude to continue and log sanitized diagnostics.
- `Stop` stores `last_assistant_message`.
- `Stop` deduplicates assistant messages.
- `PostToolUse` records reasoning step and tool call with sanitized input, serialized output, status, and duration.
- `PostToolUse` deduplicates repeated `tool_use_id`.
- Claude session logs keep all hook events and NAMS request records together.
- Architecture tests still prevent platform cross-imports and runtime upstream imports.

Run `npm run check` before claiming completion.

## Deferred Work

- Claude `PostToolUseFailure` support for failed tool-call metadata.
- Claude `PostToolBatch` support for batch-level traces.
- Claude transcript reader for recovery when a future hook version omits `last_assistant_message`.
- Subagent-specific memory separation using `agent_id`, `agent_type`, and `SubagentStop`.
- Installer and doctor support for validating Claude hook config on disk.

## Approval Notes

This design intentionally follows the current Gemini implementation's shape while using Claude's native hook names and output contracts. The main implementation risk is output privacy for `tool_response`; v1 mitigates that by accepting only explicit hook output, serializing it as a capped string, and continuing to sanitize inputs separately.
