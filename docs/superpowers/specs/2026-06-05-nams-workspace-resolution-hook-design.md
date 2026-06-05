# NAMS Workspace Resolution Hook Design

Date: 2026-06-05
Status: Approved design
Repository: nams-hooks

## Summary

`nams-hooks` should use the new NAMS workspace listing endpoint to reduce required install-time configuration where a harness can safely resolve workspace choice before memory persistence starts.

The workspace concern should be separated from NAMS memory management. A new workspace hook command owns workspace discovery, single-workspace auto-selection, and future workspace selection commands. Existing memory hooks continue to own conversation creation, recall, message persistence, and tool metadata. Memory hooks consume an effective workspace ID; they do not negotiate workspace selection.

Runtime workspace resolution is allowed only when hook ordering is deterministic enough to guarantee the workspace hook completes before the memory hook can create a conversation. Harnesses without deterministic hook ordering continue to require install-time or config-time `workspaceId` selection.

## Source Inputs

- `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`
- `docs/superpowers/specs/2026-06-03-nams-workspace-id-design.md`
- `docs/superpowers/plans/2026-05-10-walking-skeleton.md`
- `docs/nams-skill.md`
- `docs/nams-openapi.json`
- NAMS endpoint: `GET /v1/users/me/workspaces`
- Claude hooks docs: `https://code.claude.com/docs/en/hooks`
- Codex hooks docs: `https://developers.openai.com/codex/hooks`
- Gemini hooks docs: `https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md`
- OpenCode plugin docs: `https://opencode.ai/docs/plugins`

## Goals

- Avoid requiring users to configure a workspace ID during installation when the authenticated user has exactly one workspace and the harness can run workspace resolution before memory persistence.
- Keep workspace discovery and selection separate from NAMS memory management.
- Preserve deterministic memory behavior: no conversation is created before an effective workspace ID is available.
- Preserve install-time or config-time workspace selection for harnesses that cannot guarantee ordered hook execution.
- Keep runtime OpenAPI behavior static. The runtime may call generated client methods, but it must not fetch or inspect OpenAPI specs.
- Keep runtime code and generated release artifacts dependency-free.
- Keep API keys out of stdout, stderr, logs, and test output.

## Non-Goals

- Implement `/nams:workspaces use <uuid>` or any prompt-command based workspace switch in this change.
- Implement a full interactive workspace picker for every harness.
- Change workspaces mid-conversation.
- Create NAMS conversations without an effective workspace ID.
- Infer hook event names or platforms from raw payload fields.
- Add runtime npm dependencies.

## Platform Matrix

| Harness | Hook ordering | Blocking or prompt behavior | Workspace hook strategy | `workspaceId` install config |
| --- | --- | --- | --- | --- |
| Gemini | Deterministic when hook group uses `sequential: true` | Supports stopping or denying a `BeforeAgent` turn with visible output | Separate workspace command before memory command in one sequential hook group | Optional for this path |
| OpenCode | Plugins are documented as loaded from all sources with hooks run in sequence | Single-workspace runtime resolution is safe; multi-workspace blocking remains gated on a verified prompt or block mechanism | Workspace phase runs before memory phase inside the NAMS OpenCode plugin shim | Optional only for verified noninteractive-safe cases; otherwise required |
| Claude | Matching hooks can run in parallel; a blocking result does not prevent sibling hooks from starting | `UserPromptSubmit` can block, but not deterministically before memory side effects | No separate runtime sibling hook; use install-time or config-time selection | Required |
| Codex | Multiple matching command hooks for the same event are launched concurrently | `UserPromptSubmit` can block, but not deterministically before memory side effects | No separate runtime sibling hook; use install-time or config-time selection | Required |

The table intentionally distinguishes "can block" from "can order side effects." Blocking is not enough when a sibling memory hook can still start and create a conversation.

## Command Model

Add a new workspace-oriented command surface:

```bash
nams-hooks workspaces <gemini|claude|codex|opencode> --event BeforeAgent
```

This command is a hook command, not an agent-facing slash command. It should follow the same gateway principles as `nams-hooks run`:

- Parse the explicit platform argument.
- Parse the typed `--event`.
- Read stdin JSON as an opaque object.
- Dispatch through static platform/workspace behavior.
- Do not infer event names from raw payload fields.

`BeforeAgent` is the first required event because workspace resolution must happen before conversation creation. Future command work, such as `/nams:workspaces use <uuid>`, should add a separate explicit CLI surface rather than overloading the memory command.

## Hook Template Shape

### Gemini

Gemini can use a separate workspace hook command because the hook group can be marked sequential:

```json
{
  "hooks": {
    "BeforeAgent": [
      {
        "matcher": "*",
        "sequential": true,
        "hooks": [
          {
            "type": "command",
            "name": "nams-workspace-before-agent",
            "command": "node \"${extensionPath}/bin/cli.js\" workspaces gemini --event BeforeAgent"
          },
          {
            "type": "command",
            "name": "nams-memory-before-agent",
            "command": "node \"${extensionPath}/bin/cli.js\" run gemini --event BeforeAgent"
          }
        ]
      }
    ]
  }
}
```

The workspace command must finish before the memory command starts. If the workspace command blocks or stops the turn, Gemini should not run the memory command in that sequential group. This assumption must be verified in tests or manual harness smoke testing before making `NAMS_WORKSPACE_ID` optional in released Gemini extension metadata.

### OpenCode

OpenCode uses a JavaScript plugin shim rather than command hooks JSON. The NAMS plugin should keep ordering explicit inside the shim:

1. Invoke the workspace command or shared workspace module.
2. If workspace resolution allows memory to continue, invoke the memory command.
3. If workspace resolution blocks, returns a user-visible prompt, or fails closed for configuration, do not invoke memory persistence for that turn.

OpenCode docs say plugins are loaded from all sources and all hooks run in sequence. Even so, the safest NAMS-owned behavior is to keep the workspace and memory phases in the same plugin shim so ordering does not depend on other user plugins or source load order.

### Claude And Codex

Claude and Codex should not use sibling workspace and memory hooks for the same first-prompt event. Both can surface blocking behavior, but both may launch matching hook commands in parallel. A block from the workspace hook could win the final harness decision while the memory hook has already created a conversation. That violates the deterministic-write model.

For these harnesses, workspace selection belongs in install-time or config-time setup for this design.

## Workspace Resolution Flow

The workspace hook resolves an effective workspace ID before memory work:

1. Load config values that do not require `workspaceId`: `apiKey` and optional `baseUrl`.
2. If `workspaceId` is already configured through JSON, platform config, or environment, record the effective source and allow memory to proceed.
3. If `workspaceId` is missing, call `GET /v1/users/me/workspaces` with bearer auth and no `X-Workspace-Id` header.
4. If exactly one workspace is returned, store that workspace ID in local state and allow memory to proceed.
5. If multiple workspaces are returned and runtime interaction is supported for the harness, stop or block the first prompt with a user-visible list of workspace names, roles, statuses, and IDs.
6. If multiple workspaces are returned and runtime interaction is not supported, report a sanitized diagnostic and require install-time or config-time workspace selection.
7. If zero workspaces are returned, report a sanitized diagnostic and skip NAMS memory work.
8. If the workspace listing request fails, fail open for the agent harness and skip NAMS memory work for that turn.

The memory hook must re-check effective workspace state before creating the NAMS client. If no effective workspace ID exists, it must not create a conversation or perform workspace-scoped NAMS requests.

## State Model

Session state may store the resolved workspace for the conversation:

```ts
interface SessionState {
  conversationId?: string;
  workspace?: {
    id: string;
    source:
      | "config"
      | "runtime-single-workspace"
      | "install-selection";
    selectedAt: string;
  };
}
```

Explicit config remains the highest-priority workspace source. If a user later sets `NAMS_WORKSPACE_ID` or project `.nams/config.json`, it overrides session workspace state for new memory clients.

The workspace state is session scoped. This avoids silently changing all future projects because one session happened to auto-resolve a single workspace. Install-time selection can still write durable config when a harness requires configuration before hooks run.

This amends the earlier `2026-06-03` workspace ID design, which intentionally avoided new workspace-specific state before workspace listing existed. The new state is not a global workspace preference; it is a session-local effective workspace used to keep first-use auto-resolution deterministic.

## Generated Client Design

Generated client output should expose two client classes:

- `NamsWorkspaceClient`, for workspace-neutral operations such as `listMyWorkspaces`. It sends bearer auth and does not send `X-Workspace-Id`.
- `NamsClient`, for workspace-scoped memory operations. It keeps requiring an effective `workspaceId` and sends `X-Workspace-Id` as today.

Keeping two classes preserves the current memory-client invariant: code that can construct `NamsClient` has already resolved the workspace.

The generator must validate `GET /v1/users/me/workspaces` against `docs/nams-openapi.json` at build time and generate static TypeScript types for:

- `WorkspaceListResponse`
- `WorkspaceSummary`

Runtime code must not inspect OpenAPI or discover endpoints.

## Install-Time Selection

Harnesses that cannot guarantee ordered hook execution should resolve workspace ID before hooks run. This setup flow can be implemented as a future installer or configure command, but the required behavior is:

1. Ensure an API key is available.
2. Call `GET /v1/users/me/workspaces`.
3. If one workspace exists, write it automatically to the selected config target.
4. If multiple workspaces exist, show numbered choices and write the selected workspace ID.
5. If workspace listing fails, leave `workspaceId` unset and show a sanitized setup error.

Claude and Codex plugin metadata should continue to mark workspace ID as required until that setup flow exists for their plugin path. Gemini can mark workspace ID optional only when the sequential workspace hook is shipped and verified. OpenCode optionality depends on the verified OpenCode plugin path shipped with the runtime.

## Diagnostics And Logging

Workspace hook diagnostics should be sanitized and fixed-shape:

- `NAMS workspace loaded from config`
- `NAMS workspace auto-selected`
- `NAMS workspace selection required`
- `NAMS workspace list empty`
- `NAMS workspace request failed`

Diagnostics may include non-secret workspace IDs, names, roles, statuses, config source metadata, and endpoint status codes. Diagnostics must not include API key values, bearer tokens, arbitrary exception text, or raw config contents.

NAMS request logs for `GET /v1/users/me/workspaces` should use the existing `nams.request` shape and omit `Authorization`, as all current NAMS logs do.

## Error Handling

Workspace resolution failures should not crash the harness.

- Missing API key: log the existing sanitized config diagnostic and skip workspace and memory work.
- Invalid JSON config: preserve existing fail-open behavior and skip workspace and memory work.
- Single workspace auto-selection succeeds: save state before memory starts.
- Multiple workspaces on an interactive ordered harness: stop or block before memory starts.
- Multiple workspaces on a non-ordered harness: skip memory and require install-time selection.
- NAMS workspace listing failure: log a fixed diagnostic and skip memory for the turn.
- Memory hook starts without effective workspace: log `NAMS workspaceId missing` and allow without memory requests.

## Testing

Required generated client tests:

- `listMyWorkspaces` calls `GET /v1/users/me/workspaces`.
- `listMyWorkspaces` sends `Authorization` and `Accept`.
- `listMyWorkspaces` does not send `X-Workspace-Id`.
- Request logs for `listMyWorkspaces` omit `Authorization`.
- Endpoint metadata generated from the pinned OpenAPI spec includes the workspace listing endpoint.

Required runtime tests:

- Configured workspace skips workspace listing.
- Missing workspace with a single returned workspace stores session workspace and allows memory to proceed.
- Missing workspace with multiple returned workspaces returns the correct platform-specific blocking output for an ordered harness.
- Missing workspace with zero returned workspaces skips memory.
- Workspace listing failure skips memory and logs a sanitized diagnostic.
- Memory service is not created before workspace resolution succeeds.
- Explicit config overrides session-resolved workspace.

Required platform tests:

- Gemini template uses a `sequential: true` `BeforeAgent` group with workspace command before memory command.
- Gemini can auto-resolve a single workspace and then create a conversation with `X-Workspace-Id`.
- Gemini multi-workspace handling blocks or stops before conversation creation.
- Claude plugin metadata keeps `NAMS_WORKSPACE_ID` required.
- Codex plugin metadata or docs keep `workspaceId` required until install-time selection exists.
- OpenCode plugin shim performs workspace phase before memory phase for first user message.

Required docs tests or checks:

- `README.md` explains that workspace ID may be optional only on supported harness paths.
- `INSTALL.md` documents install-time workspace selection for Claude and Codex.
- `INSTALL.md` documents runtime auto-resolution for Gemini and any verified OpenCode path.

## Open Questions For Implementation Planning

- What exact Gemini output shape is most reliable for stopping a multi-workspace first prompt while showing workspace choices?
- Which OpenCode API should display a multi-workspace selection prompt, if any, and should OpenCode optional workspace config wait until that is verified?
- Where should the future install-time configure command live, given there is no current `install.mjs` in this branch?

## Approval Record

Approved decisions from brainstorming:

- Use a separate workspace hook concern to keep NAMS memory management clean.
- Runtime workspace resolution is allowed only for harnesses with deterministic hook ordering.
- Gemini uses a separate workspace command before memory in a sequential hook group.
- OpenCode can use ordered workspace then memory phases inside the plugin shim, with multi-workspace interactivity gated on later verification.
- Claude and Codex keep install-time or config-time workspace selection because matching hooks can run concurrently.
- The new endpoint `GET /v1/users/me/workspaces` is used before creating a conversation when `workspaceId` is not configured.
- Single-workspace accounts can be auto-selected and stored in local session state.
- Multi-workspace command-based selection, including `/nams:workspaces use <uuid>`, is a later separate design.
