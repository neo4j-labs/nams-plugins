# NAMS Hooks Design

Date: 2026-05-10
Status: Approved design
Repository: nams-hooks

## Summary

`nams-hooks` is a standalone Node.js integration layer that connects local agent harness hooks to the Neo4j Agent Memory Service (NAMS) REST API. Its hook runtime and generated release artifacts have zero runtime npm dependencies and use Node.js built-ins only, while the source repository may use dev-only build, generation, and test tooling. The first iteration supports macOS for Codex, Claude Code, and Gemini CLI. Codex and Claude use project-level installs; Gemini uses extension distribution while keeping runtime state and logs project-local.

The hook runner owns deterministic memory persistence. Agents receive recalled context, but they are not responsible for deciding whether to write memory. The runner stores conversation messages, recalls relevant memory before agent work, and records limited tool metadata through NAMS REST endpoints.

## Source Inputs

- Behavioral reference: `docs/nams-skill.md`
- NAMS OpenAPI contract: `https://memory.neo4jlabs.com/openapi.json`
- Local OpenAPI copy: `docs/nams-openapi.json`
- Claude Code hooks reference: `https://code.claude.com/docs/en/hooks`
- Gemini CLI hooks reference: `https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md`
- Codex hooks behavior note: `https://github.com/openai/codex/issues/16486`

## Goals

- Provide deterministic memory behavior through harness hooks and REST API calls.
- Support Codex, Claude Code, and Gemini CLI on macOS in v1.
- Keep runtime state, logs, and harness configuration project-scoped wherever the platform supports it.
- Use plain Node.js built-in modules only in runtime code and generated release artifacts. No runtime npm dependencies.
- Allow dev-only dependencies for TypeScript compilation, code generation, architecture checks, and test support when they do not create additional runtime package installation requirements or runtime imports.
- Persist standard user and assistant messages as the primary memory stream.
- Recall memory before agent responses and inject concise context plus a short operating instruction.
- Store tool-call metadata and exposed tool output when the harness provides it cleanly.
- Keep secrets and state local to `.nams/`.

## Non-Goals For v1

- Windows support.
- Global-only installation with shared state across projects.
- MCP-driven memory writes.
- Explicit entity creation from hook logic.
- Full raw tool input/output capture.
- Guaranteed assistant response capture for every harness if the harness does not expose it cleanly.

## Approach

Use a single shared Node.js runtime with thin per-harness project hook configurations.

Generated hook configs call the same entry point and declare the hook event explicitly:

```bash
nams-hooks run claude --event SessionStart
nams-hooks run codex --event SessionStart
nams-hooks run gemini --event SessionStart
```

The CLI entry point is a gateway. It parses the platform and typed event from arguments, reads hook JSON from `stdin` as an opaque object, resolves a platform adapter through a static registry, and calls the interface method for that event. The CLI must not interpret platform-specific payload fields such as session IDs, transcript paths, or event-name property variants. Those subtleties belong inside the platform adapter implementations.

This approach avoids per-harness logic drift while still respecting each platform's hook event names and JSON shapes.

## Project Layout

```text
nams-hooks/
  scripts/
    build-dist.mjs
    generate-nams-client.mjs
  src/
    cli.ts
    interfaces.ts
    generated/
      nams-client.ts
    runtime/
      stdin.ts
      logging.ts
    platforms/
      index.ts
      gemini.ts
      claude.ts
      codex.ts
  install.mjs
  templates/
    claude/
      settings.local.json
    codex/
      hooks.json
    gemini/
      gemini-extension.json
      hooks/
        hooks.json
  docs/
    nams-openapi.json
    nams-skill.md
    superpowers/specs/2026-05-10-nams-hooks-design.md
```

Installed project layout:

```text
target-project/
  .nams/
    .env
    .env.example
    state/
      sessions/
        claude/
        codex/
        gemini/
    logs/
  .claude/settings.local.json
  .codex/hooks.json
```

Gemini v1 distribution is an extension install rather than a project `.gemini/settings.json` template. Gemini still writes hook runtime state and logs into the project-local `.nams/` directory when the extension runs from that project.

## Build And Distribution

`nams-hooks` is authored in TypeScript and released as plain JavaScript. Runtime code must use Node built-ins only; build-time development tools such as TypeScript, the OpenAPI generator, architecture checks, and test support stay out of the published hook runtime.

Dependency policy:

- `dependencies` should remain empty unless an approved runtime design change explicitly adds one.
- `devDependencies` are acceptable for source maintenance, build-time generation, and automated tests.
- Generated runtime output must not require users to run `npm install` inside target projects or install transitive runtime libraries before hooks can execute.

Branch model:

- `devel`: source branch containing TypeScript source, templates, docs, the pinned OpenAPI spec, the custom generator, and committed generated TypeScript client source.
- `master`: generated release/distribution branch containing runnable JavaScript and Gemini extension root files.

On `devel`, `dist/` is generated and ignored. `npm run dist` creates a Gemini-linkable extension tree in `dist/`:

```text
dist/
  gemini-extension.json
  hooks/
    hooks.json
  bin/
    cli.js
    platforms/
    runtime/
    generated/
      nams-client.js
  docs/
    nams-openapi.json
  package.json
```

Gemini users install from the generated release branch:

```bash
gemini extensions install https://github.com/neo4j-labs/nams-hooks
```

For local testing, link the generated extension folder:

```bash
npm run dist
gemini extensions link ./dist
```

Gemini hook templates live under `templates/gemini/` on `devel`. The release artifact places `gemini-extension.json` and `hooks/hooks.json` at the extension root because Gemini expects those paths. Gemini hooks call the compiled runtime through `${extensionPath}`:

```bash
node "${extensionPath}/bin/cli.js" run gemini --event SessionStart
```

Codex and Claude distribution use the released CLI package and project-level installer:

```bash
npm install -g @neo4j-labs/nams-hooks
nams-hooks install --harness codex,claude
```

Manual or CI release flow:

1. Work on `devel`.
2. Run `npm run openapi:fetch` when the NAMS contract needs refreshing.
3. Run `npm run openapi:generate`.
4. Commit `docs/nams-openapi.json` and `src/generated/nams-client.ts` if they changed.
5. Run package verification.
6. Run release preparation to create the release tree.
7. Replace `master` contents with the validated release tree.
8. Commit the release artifact on `master`.
9. Tag the release commit, for example `v0.1.0`.

Rules:

- `master` is generated from `devel`; no hand edits.
- Release tags are created from `master`.
- Gemini installs default to `master`.
- Codex and Claude npm releases are produced from the same validated artifact.

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

REST calls go through the generated `NamsClient` from `src/generated/nams-client.ts`. The OpenAPI generator and generated client contract are described in `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`.

Conversation creation:

- `POST /v1/conversations`
- Body: `{ "userId": "<NAMS_USER_ID if configured>", "metadata": {} }`
- Client method: `createConversation`

Message persistence:

- `POST /v1/conversations/{conversationId}/messages`
- User body: `{ "role": "user", "content": "<prompt>" }`
- Assistant body: `{ "role": "assistant", "content": "<response>" }`
- Client method: `addMessage`

Bulk message persistence may be used only when a harness exposes both user and assistant messages together and duplicate suppression remains reliable:

- `POST /v1/conversations/{conversationId}/messages/bulk`
- Client method: `addMessagesBulk`

Recall:

- Use `GET /v1/conversations/{conversationId}/context` when a conversation already exists.
- Use `POST /v1/entities/search` with the first prompt or useful query terms before the first response.
- Merge successful recall sources into one injected context. If one source fails, continue with the other.
- Client methods: `getConversationContext`, `searchEntities`, `searchConversationMessages`

Tool metadata:

- `POST /v1/reasoning/tool-calls`
- Body fields:
  - `stepId`: optional, from local state when available
  - `toolName`
  - `input`: sanitized and capped serialized tool input
  - `output`: exposed tool output when available, otherwise empty string
  - `status`
  - `durationMs`
- Client method: `recordToolCall`

Reasoning steps:

- v1 may support `POST /v1/reasoning/steps` for operational summaries when a harness exposes a clean summary. It must not store hidden chain-of-thought. This is secondary to message and tool-call persistence.
- Client method: `recordReasoningStep`

Entity persistence:

- v1 does not call entity creation endpoints directly. It relies on NAMS async entity extraction from stored messages.

## Hook Event Behavior

Session start:

- Load config.
- CLI receives a typed `SessionStart` event from `--event SessionStart`.
- CLI reads raw hook JSON without interpreting platform-specific fields.
- CLI dispatches to `adapter.startConversation(invocation)` through the static platform registry.
- The platform adapter initializes local state if a stable session key is available.
- Optionally create the NAMS conversation early if configured.
- Return harness-specific empty or context-safe JSON.

User prompt submit or before-agent:

- Resolve or create session state and NAMS conversation.
- Recall relevant memory.
- Store the user prompt using the messages endpoint.
- Return harness-specific context output with:
  - relevant memory context
  - a short instruction that the agent should use the context silently and avoid narrating memory mechanics

For Gemini CLI this context is returned as `hookSpecificOutput.additionalContext`, not as a top-level `additionalContext` field.

Tool completion:

- Record tool metadata when the harness exposes a post-tool event.
- Persist `toolName`, sanitized `input`, exposed `output`, optional `stepId`, status, and duration.
- Create a safe operational reasoning step first when the harness exposes a tool event but does not expose a parent reasoning step.

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
- Use `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop`.

Gemini CLI:

- Use Gemini extension distribution for v1. Source templates live under `templates/gemini/`, and release artifacts place `gemini-extension.json` plus `hooks/hooks.json` at extension root.
- Use `SessionStart`, `BeforeAgent`, `AfterTool`, and `AfterAgent` where available.
- `BeforeAgent` can inject relevant memory context.
- `AfterAgent` can persist assistant responses when `prompt_response` or equivalent is present.

Codex:

- Use project-level `.codex/hooks.json`.
- The repository template must use Codex's command-hook group shape for `SessionStart`:
  `{ "matcher": "startup|resume", "hooks": [{ "type": "command", "command": "nams-hooks run codex --event SessionStart", "statusMessage": "Loading session notes" }] }`.
  Do not use the stale short-form object that places `command` directly under `SessionStart`.
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

`nams-hooks install --harness claude,gemini,codex` installs into the current project by default.

The installer:

- creates `.nams/state/` and `.nams/logs/`
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
- generated `NamsClient` request and error behavior
- duplicate message suppression
- harness payload parsing
- harness output formatting
- tool input sanitization and size capping

Contract tests:

- generated NAMS client endpoint metadata matches `docs/nams-openapi.json`
- generated client does not read OpenAPI at runtime
- generated client shapes bearer JSON requests correctly
- generated client throws stable errors for NAMS error responses

Fixture tests:

- Claude: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`
- Gemini: `SessionStart`, `BeforeAgent`, `AfterTool`, `AfterAgent`
- Codex: `SessionStart`, `UserPromptSubmit`, `Stop`; tool hooks only when supported by the installed version

## Gateway Interfaces

The first shared interface is `startConversation`, driven by a typed hook event:

```ts
export const hookEvents = ["SessionStart"] as const;
export type HookEvent = (typeof hookEvents)[number];

export interface HookInvocation<E extends HookEvent = HookEvent> {
  platform: Platform;
  event: E;
  rawPayload: Record<string, unknown>;
  processCwd: string;
}

export interface HookResult {
  stdout: Record<string, unknown>;
}

export interface PlatformAdapter {
  startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult>;
}
```

The CLI validates `--event` against `hookEvents`, routes `SessionStart` to `startConversation`, and prints the returned `stdout`. As additional hook events are added, `hookEvents` and `PlatformAdapter` grow deliberately so TypeScript forces routing and adapter coverage.

Installer tests:

- creates `.nams` structure
- merges or backs up existing configs
- updates `.gitignore` idempotently
- reports installed harnesses

Manual validation:

- run `nams-hooks doctor`
- install into a throwaway macOS project
- start each harness and send a prompt
- confirm one NAMS conversation is created
- confirm user messages persist
- confirm assistant messages persist where exposed
- run a tool call and confirm metadata, exposed output, and deterministic step linkage persist
- restart or resume a harness and confirm conversation reuse when the harness session ID matches

## Open Risks

- Codex hook support is still evolving. v1 should degrade gracefully and make `doctor` explicit about supported events.
- Gemini session identity may require fallback keys if the hook payload lacks a stable session ID.
- Assistant response capture may be best-effort for some harness versions.
- Prompt/context injection may be visible in some harness UIs even when intended as model context.
- NAMS REST API shape may drift from the pinned OpenAPI copy. The build-time fetch and contract-test workflow should make drift explicit before release.
- GitHub install from `master` means any accidental unreleased commit to `master` becomes installable immediately; branch protections should require release automation.

## Approval Record

Approved decisions from brainstorming:

- Standalone `nams-hooks` repo.
- First iteration: Codex, Claude Code, Gemini CLI on macOS.
- Project-local runtime state and logs.
- Project-level installs for Codex and Claude; Gemini extension distribution for v1.
- Plain Node.js with built-in modules only.
- `.nams/.env` plus real environment variables, with environment variables as fallback.
- Deterministic REST writes from hook runner, not MCP-driven writes.
- Persist user messages and assistant responses as the core memory stream.
- Store assistant responses in v1 where harnesses expose them cleanly.
- Store tool-call metadata with exposed output when available.
- Rely on NAMS async entity extraction from stored messages.
- Use TypeScript for source and release vanilla JavaScript.
- Use a custom generated `NamsClient` for REST calls.
- Use `devel` for source and generated TypeScript, and `master` for generated release distribution.
