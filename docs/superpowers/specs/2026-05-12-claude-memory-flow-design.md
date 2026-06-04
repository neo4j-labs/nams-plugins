# Claude Code Memory Flow Design

Date: 2026-05-12
Status: Draft design
Repository: nams-hooks

## Summary

This design brings Claude Code to the same integration level as the implemented Gemini, Codex, and OpenCode integrations on `devel`. Claude gets deterministic NAMS conversation creation, first-turn recall, user prompt persistence, assistant response persistence, tool-call metadata, raw local observability logs, and local session state under the shared runtime storage rooted at `~/.nams/`.

The Claude path should use Claude Code hook payload fields directly, while translating Claude hook names to the existing NAMS lifecycle events used by the shared CLI. Unlike Gemini, Claude does not need a transcript-first or transcript-fallback path for v1 because the supported hooks expose the required current-turn data: `UserPromptSubmit.prompt`, `PostToolUse.tool_name`, `PostToolUse.tool_input`, `PostToolUse.tool_response`, `PostToolUse.tool_use_id`, `PostToolUse.duration_ms`, and `Stop.last_assistant_message`.

## Source Inputs

- Approved architecture: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- OpenAPI client contract: `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`
- Gemini implementation design and plan: `docs/superpowers/specs/2026-05-11-gemini-memory-flow-design.md`, `docs/superpowers/plans/2026-05-11-gemini-memory-flow.md`
- Codex implementation design and plan: `docs/superpowers/specs/2026-05-12-codex-memory-flow-design.md`, `docs/superpowers/plans/2026-05-12-codex-memory-flow.md`
- OpenCode implementation design and plan: `docs/superpowers/specs/2026-05-12-opencode-memory-flow-design.md`, `docs/superpowers/plans/2026-05-12-opencode-memory-flow.md`
- Global runtime storage and JSON config plan: `docs/superpowers/plans/2026-05-16-json-config-global-runtime-storage.md`
- TypeScript test runner design and plan: `docs/superpowers/specs/2026-05-16-typescript-test-runner-design.md`, `docs/superpowers/plans/2026-05-17-typescript-test-runner.md`
- Behavioral reference: `docs/nams-skill.md`
- Current platform sources: `src/platforms/gemini/`, `src/platforms/codex/`, and `src/platforms/opencode/`
- Current shared runtime: `src/runtime/config.ts`, `src/runtime/session-state.ts`, `src/runtime/memory-service.ts`, `src/runtime/logging.ts`
- Claude Code hooks reference, checked on 2026-05-12: `https://code.claude.com/docs/en/hooks`

## Current State After Latest `devel` Merge

The branch already has complete Gemini, Codex, and OpenCode memory flows:

- `src/cli.ts` accepts typed hook events from `--event` and keeps platform payload parsing out of the gateway.
- `src/interfaces.ts` declares `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- `src/platforms/gemini/index.ts` owns session state, NAMS calls, context injection, assistant persistence, and tool traces.
- `src/platforms/codex/index.ts` follows the same NAMS event contract with Codex-specific payload and transcript parsing.
- `src/platforms/opencode/index.ts` follows the same NAMS event contract through an OpenCode plugin shim and pending context state.
- `src/runtime/*` provides shared JSON config loading, global runtime paths, state persistence, hashing, logging, and `NamsMemoryService`.
- `templates/gemini/hooks/hooks.json` wires Gemini `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- `templates/codex/hooks.json` and `templates/opencode/plugins/nams-hooks.js` translate native platform surfaces into the shared NAMS events.

Configuration now loads from `~/.nams/config.json`, then `<project>/.nams/config.json`, then `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides. Under the amendment in `docs/superpowers/specs/2026-06-03-nams-workspace-id-design.md`, `apiKey` and `workspaceId` are required for NAMS requests and the generated client sends `X-Workspace-Id` on every request. Loading returns a structured result, so adapters log sanitized configuration diagnostics with source metadata, including the `workspaceId` source, instead of throwing or inspecting `.env` files. Runtime state and logs are stored under `~/.nams/state/<platform>/` and `~/.nams/logs/<platform>/`. Readable global and project NAMS config files are tightened to `0600` when loaded; Claude-created runtime state and log files are written as `0600`, with runtime directories created as `0700`.

Tests are authored in TypeScript and run with Node's built-in `node:test` through `tsx`. `npm run check` now runs OpenAPI generation, TypeScript build, test type-checking through `tsconfig.test.json`, and the full TypeScript test suite.

Claude currently has a complete allow-only walking skeleton in `src/platforms/claude/index.ts`. It implements `startSession`, `beforeAgent`, `afterAgent`, and `afterTool`, logs raw payloads through the shared platform logger, and returns allow output. `templates/claude/settings.local.json` already translates Claude `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop` to the shared NAMS events, with TypeScript coverage in `test/claude-template.test.ts` and `test/cli-session-start.test.ts`.

## Goals

- Add Claude Code memory flow parity with the implemented Gemini, Codex, and OpenCode patterns.
- Keep `src/cli.ts` platform-agnostic by accepting typed NAMS events; do not add Claude-native events or infer events from `hook_event_name`.
- Keep Claude-specific parsing and orchestration under `src/platforms/claude/`.
- Use the existing generated `NamsClient` through `NamsMemoryService`.
- Use Claude `session_id` as the primary local session key, with cwd fallback.
- Create NAMS conversations lazily on the first Claude `UserPromptSubmit` translated to NAMS `BeforeAgent`, not on `SessionStart`.
- Recall memory before Claude's first model response for the session and inject it as Claude `additionalContext`.
- Persist every Claude user prompt observed through `UserPromptSubmit`.
- Persist Claude assistant responses from `Stop.last_assistant_message`.
- Record successful Claude `PostToolUse` events as a safe operational reasoning step plus NAMS tool-call metadata.
- Store exposed tool output from `tool_response` in full, because Claude provides it explicitly in the hook payload. Shared tool-call output serialization must not truncate explicit output saved to memory.
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

This preserves each platform's vocabulary, but it makes `src/cli.ts` and `src/interfaces.ts` grow platform-native event names. That weakens the gateway's role as a platform-agnostic NAMS event router.

### Option 2: Normalize Claude Events To Gemini-Like Events

Map Claude `UserPromptSubmit` to a shared `BeforeAgent` behavior, Claude `PostToolUse` to `AfterTool`, and Claude `Stop` to `AfterAgent`.

This is the recommended approach. Treat `BeforeAgent`, `AfterTool`, and `AfterAgent` as NAMS lifecycle events, not Gemini-only events. Platform templates translate native hook names into those NAMS events before invoking the CLI, and platform adapters translate NAMS event handling back into platform-specific output where needed.

### Option 3: Generic Adapter `handle()` Method

Replace event-specific adapter methods with one generic method that receives every typed event.

This simplifies CLI routing but weakens TypeScript coverage. New events would no longer force platform-specific implementation decisions at compile time.

## Recommended Design

Use Option 2. Keep the existing shared NAMS event names in `src/interfaces.ts` and `src/cli.ts`; add Claude behavior by implementing `beforeAgent`, `afterTool`, and `afterAgent` in `ClaudeAdapter`.

The adapter contract does not gain Claude-native methods:

```ts
export const hookEvents = ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool"] as const;

export interface PlatformAdapter {
  startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult>;
  beforeAgent?(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult>;
  afterAgent?(invocation: HookInvocation<"AfterAgent">): Promise<HookResult>;
  afterTool?(invocation: HookInvocation<"AfterTool">): Promise<HookResult>;
}
```

Platforms that do not implement a NAMS event method continue to return allow output. This keeps `src/cli.ts` platform-agnostic and lets each template describe its own native hook translation.

## Claude Components

### Claude Payload Parser

Create `src/platforms/claude/payload.ts`.

It extracts only Claude fields needed by the adapter. The parser reads native Claude payload fields, but the `HookInvocation.event` passed to the adapter is the translated NAMS event:

- `session_id` as `sessionId`
- `cwd` as `projectDirectory`, falling back to `processCwd`
- `transcript_path` as diagnostic metadata only
- `source` for `SessionStart` logging metadata
- `prompt` for Claude `UserPromptSubmit`, handled as NAMS `BeforeAgent`
- `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, and `duration_ms` for Claude `PostToolUse`, handled as NAMS `AfterTool`
- `last_assistant_message` for Claude `Stop`, handled as NAMS `AfterAgent`

The parser must not trust `hook_event_name` for routing. That field stays in raw logs only; template commands provide the authoritative NAMS event via `--event`.

### NAMS Event Translation

Claude hook templates translate native Claude hooks to NAMS lifecycle events:

| Claude hook | NAMS event | Purpose |
|---|---|---|
| `SessionStart` | `SessionStart` | Initialize or reuse Claude local session state and append the raw startup/resume payload without creating a NAMS conversation. |
| `UserPromptSubmit` | `BeforeAgent` | Recall relevant memory before Claude responds, inject Claude `additionalContext`, and persist the user prompt. |
| `PostToolUse` | `AfterTool` | Record successful tool metadata and exposed tool output after Claude completes a tool call. |
| `Stop` | `AfterAgent` | Persist the final assistant response exposed as `last_assistant_message`. |

### Claude Adapter

`src/platforms/claude/index.ts` becomes the orchestration entrypoint. It should mirror the Gemini adapter structure where useful:

- resolve payload info
- create or load local session state through `createInitialSessionState()`, `loadSessionState(platform, sessionKey)`, and `saveSessionState(platform, sessionKey, state)`
- append raw `hook.event` logs through the shared best-effort logging helpers
- load NAMS config only when a hook needs NAMS through `loadNamsConfig(projectDirectory)`
- log structured config diagnostics with `appendNamsConfigDiagnostic(invocation, state, result)`
- create `NamsMemoryService` through `createNamsMemoryService(config, invocation, state)` so generated-client `nams.request` logs stay consistent
- save state before returning
- catch config, NAMS, and log errors so Claude continues

The Claude adapter implements `startSession`, `beforeAgent`, `afterTool`, and `afterAgent`. It does not add Claude-native adapter methods.

### Shared Runtime Changes

`NamsMemoryService.recordToolCall()` sanitizes and caps tool input, but explicit tool output should be serialized in full. This keeps output from Claude `tool_response`, Gemini tool responses, Codex post-tool output, and OpenCode tool output intact when the harness exposes it cleanly:

```ts
export interface ToolCallInput {
  stepId?: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  status?: string;
  durationMs?: number;
}

export function serializeToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}
```

The exact helper name can stay in `src/runtime/memory-service.ts` with `serializeToolInput` to avoid a new module. Only sanitized tool input remains capped.

## Hook Data Flow

### SessionStart

Claude `SessionStart` fires for `startup`, `resume`, `clear`, and `compact`.

Flow:

1. Parse `session_id`, `cwd`, `transcript_path`, and `source`.
2. Resolve or create local session state under `~/.nams/state/claude/session-<created-at>--<sha256(sessionKey)>.json`.
3. Append a raw `hook.event` log using session-scoped log naming.
4. Save state without creating a NAMS conversation.
5. Return `{ "continue": true, "suppressOutput": true }`.

No memory recall happens here. Claude `UserPromptSubmit`, translated to NAMS `BeforeAgent`, has the actual user prompt and is the better deterministic recall point.

### BeforeAgent (Claude UserPromptSubmit)

Claude `UserPromptSubmit` fires after the user submits a prompt and before Claude processes it. The Claude template invokes the CLI with `--event BeforeAgent`.

Flow:

1. Parse `prompt`.
2. Resolve or create local session state.
3. Append raw hook payload to the session log.
4. If `prompt` is blank, save state and allow.
5. Load config from `~/.nams/config.json`, `<project>/.nams/config.json`, then environment overrides.
6. Log the sanitized config diagnostic result. If `apiKey` or `workspaceId` is missing, or config JSON is invalid, allow.
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

The adapter must not return top-level `additionalContext`. The invocation uses NAMS `BeforeAgent`, but the structured output returned to Claude uses Claude's native `hookEventName: "UserPromptSubmit"`.

### AfterTool (Claude PostToolUse)

Claude `PostToolUse` fires after a tool succeeds. The Claude template invokes the CLI with `--event AfterTool`. The payload provides `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, and optional `duration_ms`.

Flow:

1. Resolve state and append raw hook payload.
2. If there is no `conversationId`, save state and allow. Do not create a conversation solely for a tool call.
3. If `tool_name` is missing or blank, save state and allow.
4. Load config. Missing or invalid config logs a sanitized config diagnostic and allows.
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
  "output": "<serialized full tool_response>",
  "status": "success",
  "durationMs": 12
}
```

8. Mark the tool call seen only after the NAMS write succeeds.
9. Save state and allow.

### AfterAgent (Claude Stop)

Claude `Stop` fires when the main Claude Code agent finishes responding. The Claude template invokes the CLI with `--event AfterAgent`. The payload exposes `last_assistant_message`.

Flow:

1. Resolve state and append raw hook payload.
2. If there is no `conversationId`, save state and allow.
3. If `last_assistant_message` is missing or blank, save state and allow.
4. Load config. Missing or invalid config logs a sanitized config diagnostic and allows.
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

Claude should move from the current event-scoped walking-skeleton logs to session-scoped logs when session state exists. That gives the same debugging ergonomics as Gemini, Codex, and OpenCode:

```text
~/.nams/logs/claude/session-2026-05-12T09-00-1f3870be.jsonl
```

All Claude records include:

- `timestamp`
- `harness: "claude"`
- typed `event`
- `kind`
- raw `payload` for `hook.event`
- sanitized generated-client request events for `nams.request`, with `Authorization` omitted and `X-Workspace-Id` retained as a routing identifier

Diagnostics use fixed messages and sanitized source metadata only:

- `"NAMS config loaded"`
- `"NAMS config invalid"`
- `"NAMS apiKey missing"`
- `"NAMS workspaceId missing"`
- `"NAMS request failed"`

The adapter must not log raw thrown error text because errors can contain secrets or prompt content.

## Template Wiring

`templates/claude/settings.local.json` already contains the complete native-hook to NAMS-event walking-skeleton wiring:

- Keep `SessionStart` matcher `startup|resume|clear|compact`.
- Claude `UserPromptSubmit` is translated to NAMS `BeforeAgent`.
- Claude `PostToolUse` is translated to NAMS `AfterTool`.
- Claude `Stop` is translated to NAMS `AfterAgent`.
- The template remains the only place that knows the Claude-native hook names; `src/cli.ts` continues to receive only typed NAMS events.

Template command mapping:

| Claude hook | NAMS event | Purpose |
|---|---|---|
| `SessionStart` | `SessionStart` | Initialize Claude session state without creating a NAMS conversation. |
| `UserPromptSubmit` | `BeforeAgent` | Recall memory, inject `additionalContext`, and persist the user prompt. |
| `PostToolUse` | `AfterTool` | Persist successful tool-call metadata and exposed output. |
| `Stop` | `AfterAgent` | Persist the exposed assistant response. |

Each command uses `nams-hooks run claude --event <NAMS event>`.

## Error Handling

Claude hooks remain non-blocking:

- Missing `apiKey`, missing `workspaceId`, or invalid JSON config: log sanitized config diagnostic, allow.
- NAMS create, recall, message, reasoning, or tool-call failure: log fixed diagnostic, allow.
- Recall failure from one source: try the other source and still attempt user-message persistence.
- User-message failure after recall succeeds: return the recall context and allow.
- Assistant or tool persistence failure: save conservative state so the next hook can retry where practical.
- Observability log write failure: allow hook execution to continue.

## Privacy Rules

- Persist user prompts and assistant responses as the canonical memory stream.
- Persist Claude `tool_response` only because it is explicit hook output; serialize explicit tool output without truncation.
- Sanitize tool input with the existing `serializeToolInput()` behavior before sending it to NAMS.
- Do not parse Claude transcript internals for hidden reasoning in v1.
- Do not create entities directly.
- Do not print or log API keys.
- Diagnostics never include arbitrary exception text.

## Test Plan

Fixture-driven tests cover:

- CLI routes only typed NAMS events; the Claude template maps native hooks to those events.
- Claude parser extracts session, cwd, prompt, tool, duration, and assistant fields.
- `SessionStart` initializes local state and does not call NAMS.
- NAMS `BeforeAgent` for Claude `UserPromptSubmit` creates conversation lazily, recalls memory, injects Claude `additionalContext`, and stores the user prompt.
- NAMS `BeforeAgent` deduplicates repeated prompts.
- Global config, project config, environment override, missing config, invalid JSON, and NAMS failure paths allow Claude to continue and log sanitized diagnostics.
- NAMS `AfterAgent` for Claude `Stop` stores `last_assistant_message`.
- NAMS `AfterAgent` deduplicates assistant messages.
- NAMS `AfterTool` for Claude `PostToolUse` records reasoning step and tool call with sanitized input, serialized full output, status, and duration.
- NAMS `AfterTool` deduplicates repeated `tool_use_id`.
- Claude session logs keep all hook events and NAMS request records together.
- Architecture tests still prevent platform cross-imports and runtime upstream imports.
- TypeScript-authored tests pass under `node --import=tsx --test`, and `npm run test:typecheck` type-checks `src/**/*.ts` plus `test/**/*.ts`.

Run `npm run check` before claiming completion. The expected verification path is OpenAPI generation, runtime build, TypeScript test type-checking, and the full Node test suite.

## Deferred Work

- Claude `PostToolUseFailure` support for failed tool-call metadata.
- Claude `PostToolBatch` support for batch-level traces.
- Claude transcript reader for recovery when a future hook version omits `last_assistant_message`.
- Subagent-specific memory separation using `agent_id`, `agent_type`, and `SubagentStop`.
- Installer and doctor support for validating Claude hook config on disk.

## Approval Notes

This design intentionally follows the current Gemini, Codex, and OpenCode implementation shape while translating Claude's native hook names into NAMS lifecycle events. The main implementation risk is output privacy for `tool_response`; v1 mitigates that by accepting only explicit hook output, serializing explicit tool output without truncation for NAMS memory, and continuing to sanitize inputs separately.
