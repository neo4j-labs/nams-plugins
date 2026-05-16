# OpenCode Memory Flow Design

Date: 2026-05-12
Status: Proposed design
Repository: nams-hooks
Baseline branch: devel at 16af023

## Summary

Add OpenCode as the next full NAMS memory-flow integration, using the existing Gemini implementation as the behavioral reference while respecting OpenCode's plugin-based extension model.

OpenCode does not expose Gemini-style command hooks. The integration should use a small project-local OpenCode plugin shim under `.opencode/plugins/` that translates OpenCode plugin hooks into the existing `nams-hooks run <platform> --event <event>` gateway. The CLI continues to parse only the platform and typed event, read stdin as opaque JSON, and dispatch through the static adapter registry. OpenCode-specific payload interpretation stays inside `src/platforms/opencode/`.

The first implementation should match Gemini's completed integration level for the reliable surfaces OpenCode exposes: session-scoped local state and logs, lazy NAMS conversation creation, first-response recall, user-message persistence, best-effort assistant text persistence, and tool-call metadata persistence. It should not persist hidden chain-of-thought or depend on OpenCode internals.

## Source Inputs

- Behavioral reference: `docs/nams-skill.md`
- Approved hook architecture: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- OpenAPI client contract: `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`
- Gemini memory-flow reference: `docs/superpowers/specs/2026-05-11-gemini-memory-flow-design.md`
- Current Gemini implementation: `src/platforms/gemini/`
- OpenCode config docs: `https://opencode.ai/docs/config/`
- OpenCode plugin docs: `https://opencode.ai/docs/plugins/`
- Current OpenCode plugin type source: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/plugin/src/index.ts`
- Current OpenCode SDK event type source: `https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts`

The OpenCode docs referenced above were checked on 2026-05-12. They describe local project plugins under `.opencode/plugins/`, npm plugins through the `plugin` config option, and plugin hooks including `chat.message`, `experimental.chat.system.transform`, `experimental.text.complete`, and `tool.execute.after`.

## Goals

- Add OpenCode as a platform in the static adapter registry.
- Keep OpenCode-specific code under `src/platforms/opencode/`.
- Keep the CLI as an opaque gateway; it must not parse OpenCode hook payloads.
- Use a project-level OpenCode plugin shim for the first implementation.
- Preserve zero runtime npm dependencies for the hook runtime and release artifacts.
- Use OpenCode `session.created` only to initialize local state and session logs.
- Create NAMS conversations lazily when the first user message is observed.
- Recall memory before OpenCode sends the first model request for a session.
- Inject recalled context through `experimental.chat.system.transform`, not by rewriting user text.
- Persist user messages from `chat.message`.
- Persist assistant text best-effort from `experimental.text.complete`.
- Persist tool-call metadata from `tool.execute.after`.
- Store tool output only when OpenCode exposes it cleanly as the tool hook output.
- Keep secrets, session state, and logs under project-local `.nams/`.
- Continue the agent run when NAMS config, NAMS requests, or local logging fail.

## Non-Goals

- Publishing an npm OpenCode plugin package in the first pass.
- Global OpenCode installation by default.
- Using OpenCode's database or private storage internals.
- Importing `@opencode-ai/plugin` or `@opencode-ai/sdk` from runtime code.
- Persisting OpenCode reasoning parts until we can prove they are operational summaries rather than hidden chain-of-thought.
- Guaranteeing MCP tool capture if OpenCode does not route those calls through `tool.execute.after`.
- Direct entity creation from hooks.
- Live OpenCode or live NAMS integration tests as a completion gate.

## External OpenCode Surface

OpenCode loads local project plugins from `.opencode/plugins/` and global plugins from `~/.config/opencode/plugins/`. It can also load npm plugins through the `plugin` array in `opencode.json`, but the first NAMS integration should avoid publishing and auto-installing npm plugin packages.

The plugin function receives context including:

- `project`
- `directory`
- `worktree`
- `client`
- `$`

The relevant plugin hooks are:

- `event`: receives bus events such as `session.created`.
- `chat.message`: runs when a new user message is received, before the model call.
- `experimental.chat.system.transform`: can append system prompt context before the model call.
- `experimental.text.complete`: receives completed text output for an assistant text part.
- `tool.execute.after`: receives tool name, session id, call id, args, output title, output text, and metadata after tool execution.

The OpenCode type source marks some of these hooks as experimental. The implementation should isolate those assumptions in the plugin shim and parser tests so future API drift is easy to review.

## Approach

### Thin Plugin Shim

Add a template plugin:

```text
templates/opencode/plugins/nams-hooks.js
```

The template is dependency-free ESM. It registers OpenCode hooks and shells out to:

```bash
nams-hooks run opencode --event <SessionStart|BeforeAgent|AfterAgent|AfterTool>
```

Each call sends one JSON payload on stdin. The payload includes the OpenCode hook name, hook input, hook output, and stable plugin context fields such as `directory`, `worktree`, and `project`.

The shim catches failures, logs a short diagnostic through `client.app.log()` when available, and never throws because memory failures must not block OpenCode.

### Semantic Events

Reuse the existing semantic hook events instead of adding OpenCode-specific event names:

| OpenCode hook | NAMS event | Purpose |
|---|---|---|
| `event` with `session.created` | `SessionStart` | Initialize local state and session log only. |
| `chat.message` | `BeforeAgent` | Create/reuse NAMS conversation, recall memory, persist user message, store pending context. |
| `experimental.chat.system.transform` | `BeforeAgent` | Consume pending context for the session and return it for system prompt injection. |
| `experimental.text.complete` | `AfterAgent` | Persist completed assistant text best-effort. |
| `tool.execute.after` | `AfterTool` | Persist sanitized tool metadata and exposed output. |

The OpenCode adapter branches on the OpenCode hook name inside the opaque payload. This keeps `src/cli.ts` platform-agnostic.

### Context Injection

The adapter should not append memory context to the user message parts. That would pollute OpenCode's own conversation history and could make memory text look user-authored.

Instead:

1. `chat.message` extracts the current user prompt, creates the conversation if needed, performs first-response recall, persists the user message, and stores any non-empty recalled context in local session state.
2. `experimental.chat.system.transform` loads the pending recalled context for the same session and returns it in `hookSpecificOutput.additionalContext`.
3. The plugin shim appends that context to `output.system`.
4. The adapter marks the pending context consumed so it is not injected into later requests.

The injected text should reuse the existing memory-service format:

```text
Relevant memory context:
...

Use this context silently when it is relevant. Do not narrate memory mechanics.
```

## Components

### OpenCode Adapter

Create:

```text
src/platforms/opencode/index.ts
src/platforms/opencode/payload.ts
```

The adapter owns all OpenCode-specific behavior. It should mirror Gemini's orchestration but keep the implementation separate until meaningful shared behavior emerges.

It resolves:

- OpenCode session id from hook input, event payload, message, or part data.
- Project directory from plugin `directory`, session info `directory`, `worktree`, or process cwd.
- User prompt from `chat.message` text parts.
- Assistant text from `experimental.text.complete` output text.
- Tool metadata from `tool.execute.after` input and output.

### Interfaces And Registry

Add `opencode` to `src/interfaces.ts`:

```ts
export const platforms = ["gemini", "claude", "codex", "opencode"] as const;
```

Register `OpenCodeAdapter` in `src/platforms/index.ts`. Architecture tests should be updated so only the platform registry imports concrete adapters.

No OpenCode payload field should be read outside the OpenCode adapter.

### Session State

Reuse `.nams/state/sessions/<platform>/<session-key>.json` with platform `opencode`.

OpenCode session key selection:

1. Use `sessionID` from plugin hook input when present.
2. Use `event.properties.info.id` from `session.created` when present.
3. Fall back to a cwd-derived key.

Extend `SessionState` conservatively with optional OpenCode fields:

```ts
pendingMemoryContext?: {
  messageId?: string;
  content: string;
  createdAt: string;
};
seenUserMessageIds?: string[];
seenAssistantPartIds?: string[];
```

Existing hash-based duplicate suppression remains the fallback.

### Session Logging

OpenCode should use the same session-scoped log naming as Gemini:

```text
.nams/logs/session-<created-at>-<session-part>.jsonl
```

Records should include:

- `kind: "hook.event"` for raw OpenCode plugin payloads.
- `kind: "nams.request"` for generated-client HTTP request/response events.
- `kind: "diagnostic"` for fixed, sanitized diagnostics.

Hook payload logs should preserve raw OpenCode plugin input and output for local debugging. NAMS diagnostics must not include API keys, bearer tokens, arbitrary exception text, or raw secret-containing config.

### NAMS Memory Flow

`chat.message` maps to Gemini `BeforeAgent` behavior:

1. Parse payload and append the raw hook event log.
2. Resolve or create local session state.
3. If no user text is available, save state and allow.
4. Load NAMS config.
5. If config is missing, log a fixed diagnostic and allow.
6. Create the NAMS conversation lazily if needed.
7. If `lastRecallAt` is absent, call conversation context and entity search.
8. Store any non-empty recall context as `pendingMemoryContext`.
9. Persist the user message unless a message id or content hash has already been seen.
10. Save state and allow.

`experimental.chat.system.transform` consumes pending context:

1. Resolve session state.
2. If pending context exists, return it as `hookSpecificOutput.additionalContext`.
3. Clear pending context after returning it.
4. Allow even when state is missing.

`experimental.text.complete` maps to assistant persistence:

1. Resolve state.
2. Skip when no conversation id exists.
3. Store non-empty `output.text` as an assistant message.
4. Dedupe by `messageID:partID` when present and by assistant content hash otherwise.

`tool.execute.after` maps to tool metadata:

1. Resolve state.
2. Skip when no conversation id exists.
3. Dedupe by `callID` when present and by tool name plus sanitized args otherwise.
4. Record a safe operational reasoning step such as `OpenCode invoked <tool> with the provided tool input.`
5. Record the tool call with sanitized/capped args, tool name, optional step id, status `completed`, and `output.output` when it is a string.

## Privacy Rules

- Do not persist hidden chain-of-thought.
- Do not persist OpenCode `reasoning` parts in v1.
- Do not infer reasoning from arbitrary event order.
- Do not store direct entities from hooks.
- Sanitize tool inputs through the existing `NamsMemoryService` serializer.
- Preserve raw OpenCode hook payload logs for local debugging, but never log NAMS secrets.
- Do not print NAMS API keys to stdout, stderr, test output, or logs.

## Error Handling

All OpenCode plugin hooks should be best-effort and non-blocking.

If `NAMS_API_KEY` is missing, the adapter logs `NAMS_API_KEY missing`, saves conservative state, and returns allow output.

If NAMS recall fails, the adapter should still attempt user-message persistence when possible. If persistence fails after recall succeeded, it may still return recalled context for injection, matching Gemini behavior.

If assistant or tool persistence fails, the adapter logs a fixed diagnostic and should avoid marking the assistant part or tool call as seen unless the NAMS write succeeded.

If the plugin command fails, the plugin shim logs a short OpenCode app diagnostic when possible and leaves OpenCode output unchanged.

## Distribution And Installation

The first implementation should add a project-local template:

```text
templates/opencode/plugins/nams-hooks.js
```

Manual development install:

```bash
mkdir -p .opencode/plugins
cp templates/opencode/plugins/nams-hooks.js .opencode/plugins/nams-hooks.js
```

The template should default to `nams-hooks` on `PATH` and support `NAMS_HOOKS_COMMAND` for tests or local development. A future installer can copy the template automatically once this repository has an installer flow for Codex, Claude, and OpenCode.

## Testing

Use Node's built-in `node:test` runner. Tests should create filesystem fixtures under the OS temp directory and clean them up.

Core tests:

- OpenCode payload parser extracts session, project directory, user text, assistant text, and tool metadata.
- `SessionStart` initializes state without creating a NAMS conversation.
- `chat.message` creates a conversation, recalls memory, stores the user prompt, and stores pending context.
- `experimental.chat.system.transform` returns and consumes pending context.
- Missing `NAMS_API_KEY` and NAMS failures allow OpenCode to continue.
- `experimental.text.complete` stores assistant text and deduplicates replayed parts.
- `tool.execute.after` stores a reasoning step plus sanitized tool metadata and deduplicates replayed calls.
- OpenCode session logs keep hook, NAMS request, and diagnostic records together.
- CLI routes `opencode` events without inferring event names from payload fields.
- Architecture tests include `opencode` in concrete adapter boundaries.

Before claiming implementation complete, run:

```bash
npm run check
```

For release confidence, also run:

```bash
npm run package:check
```

## Open Questions

- `experimental.text.complete` is the cleanest assistant-text surface in current OpenCode types, but it is explicitly experimental. The implementation should keep this in parser and adapter tests so drift is obvious.
- If OpenCode later exposes stable completed assistant messages with all text parts, prefer that over per-part text persistence.
- Historical OpenCode issues suggested MCP tool calls did not always trigger tool hooks. Treat MCP tool metadata as best-effort unless current OpenCode tests prove it is routed through `tool.execute.after`.
