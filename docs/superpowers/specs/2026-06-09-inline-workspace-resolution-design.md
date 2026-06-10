# Inline Workspace Resolution Design

## Context

The 2026-06-05 workspace-resolution design kept Claude and Codex on
config-time workspace selection because sibling first-prompt hooks are not
ordered enough to split workspace and memory side effects safely. Real Claude
testing showed the practical gap: a global config with `apiKey` and `baseUrl`,
but no `workspaceId`, logs the correct missing-workspace diagnostic and never
calls `GET /v1/users/me/workspaces`.

The 2026-06-08 key-scope design also changed the NAMS contract: both workspace
keys and admin keys can call `GET /v1/users/me/workspaces`; a workspace key
returns exactly one workspace, while an admin key may return multiple. The hook
runtime must infer only from valid workspace-list cardinality and must not model
key type explicitly.

## Decision

Workspace resolution for memory requests should use this order:

1. Global JSON config, project JSON config, platform discovery, and environment
   overrides loaded through the existing config loader.
2. Existing session-state workspace selection.
3. `GET /v1/users/me/workspaces`, only when config has no `workspaceId` and
   session state has no selected workspace.

Configuration remains authoritative. If config provides `workspaceId`, the
runtime uses it and does not preflight it with the workspace-list endpoint. If
config is missing `workspaceId` but session state has a workspace selection, the
runtime uses the state value and does not call the workspace-list endpoint again.

If neither config nor state provides a workspace, the runtime lists workspaces:

- exactly one valid workspace ID: persist that ID in session state and continue
  memory creation;
- zero valid workspace IDs: skip memory and allow the platform to continue;
- multiple valid workspace IDs: notify that memory is inactive for the turn,
  skip memory, and allow the platform to continue.

The shared resolver returns only platform-neutral outcomes: ready config,
unavailable workspace resolution, or sanitized workspace-selection-required
metadata. Platform adapters own all hook JSON formatting such as Gemini
`hookSpecificOutput`, OpenCode shim flags, Claude `systemMessage`, and Codex
`hookSpecificOutput`. No adapter should block execution solely because multiple
workspaces are available.

## Platform Behavior

Gemini, Claude, Codex, and OpenCode all resolve workspace selection in their
main memory `BeforeAgent` adapter. There should be no packaged first-prompt
workspace pre-hook for Gemini and no ordered workspace phase in the OpenCode
plugin shim. The `workspaces` command remains for explicit configuration and
can keep accepting `BeforeAgent` as a compatibility no-op, but it must not own
runtime workspace resolution for normal memory flow.

Each platform follows the same prompt-time sequence:

1. Parse the platform payload and load/create session state.
2. If there is no user prompt for the hook surface, save state and allow.
3. Call the shared workspace resolver before creating a conversation.
4. If the resolver returns ready config, continue memory recall and persistence.
5. If the resolver reports unavailable workspace resolution, skip memory and
   allow.
6. If the resolver reports multiple workspaces, skip memory and return the
   platform-specific non-blocking user notice.

The multi-workspace notice should use the same wording across platforms:
NAMS memory is inactive for this turn, no memory messages were stored, multiple
workspaces are available, and an explicit `workspaceId` must be configured with
`nams-hooks workspaces configure <platform> --scope project --workspace-id
<workspace-id>`.

Gemini and Claude should return the notice as top-level `systemMessage` and
`hookSpecificOutput.additionalContext`, leaving `suppressOutput` false for the
visible hook output path. Codex should return the notice through
`hookSpecificOutput.additionalContext`. OpenCode should return a
`namsWorkspaceSelectionRequired` flag and the same notice as `reason`; the
OpenCode plugin shim logs it, shows a warning toast through `client.tui`, and
stores it for the next system-transform hook so it can enter model context.

Claude must preserve plugin user configuration discovery while using the shared
helper, because Claude can source `apiKey`, `workspaceId`, and `baseUrl` from
`CLAUDE_PLUGIN_OPTION_NAMS_*` values.

## Diagnostics

Runtime diagnostics should explain how the workspace was resolved without
logging secrets:

- `NAMS workspace loaded from config`
- `NAMS workspace loaded from session state`
- `NAMS workspace auto-selected`
- `NAMS workspace selection required`
- `NAMS workspace list empty`
- `NAMS workspace request failed`

The config diagnostic still records where `apiKey`, `workspaceId`, and `baseUrl`
came from. A missing configured workspace should no longer log `NAMS workspaceId
missing` for platforms that can auto-resolve through the list endpoint; they
should log a workspace-resolution diagnostic instead.

## State

The runtime stores only the selected workspace in session state:

```ts
workspace: {
  id: string;
  source: "config" | "runtime-single-workspace" | "install-selection";
  selectedAt: string;
}
```

The complete workspace list is not session state. It is diagnostic context for
multi-workspace cases and should remain sanitized to workspace public metadata.

## Tests

Tests should cover:

- configured workspace skips `/v1/users/me/workspaces`;
- configured workspace writes `source: "config"` diagnostics;
- session workspace skips `/v1/users/me/workspaces`;
- exactly one listed workspace auto-selects and is used for memory requests;
- Gemini, Claude, Codex, and OpenCode auto-select a single listed workspace
  before creating a conversation when config is missing `workspaceId`;
- multi-workspace cases skip memory without creating a conversation;
- multi-workspace user-prompt cases return non-blocking
  `hookSpecificOutput.additionalContext` with the selection-required message;
- Gemini and Claude multi-workspace user-prompt cases also return top-level
  `systemMessage` so the same notice is visible to the user;
- Gemini package templates include only the memory `BeforeAgent` hook;
- OpenCode plugin templates route `chat.message` through the memory command
  only and surface `namsWorkspaceSelectionRequired` output from that command;
- Claude plugin templates mark `NAMS_WORKSPACE_ID` optional for runtime
  auto-resolution while preserving the base URL default in configuration.

## Out Of Scope

- Modeling workspace-key versus admin-key types in configuration, state, logs,
  or CLI arguments.
- Adding sibling workspace hooks for first-prompt events.
- Validating an explicitly configured `workspaceId` on every hook invocation.
