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

Gemini keeps its separate ordered workspace hook. The hook should auto-select a
single workspace when possible. If multiple workspaces are returned, it should
return non-blocking selection-required context, skip memory for the turn, and
let the memory hook continue without creating a conversation.

OpenCode keeps its ordered in-plugin workspace phase. Multi-workspace users get
the existing configuration-required output, and the memory phase skips rather
than creating a conversation.

Claude and Codex should not gain sibling workspace hooks for the first prompt.
Instead, their existing memory adapters should call the shared effective-config
helper. That helper performs single-workspace auto-resolution inline before any
conversation is created. Multiple workspaces remain a configuration-required
state that skips memory for that turn. On user-prompt hooks, this case should
return non-blocking `hookSpecificOutput.additionalContext` explaining that NAMS
memory is inactive, no memory messages were stored, multiple workspaces are
available, and an explicit `workspaceId` must be configured. Claude should also
return the same notice as a top-level `systemMessage`, because Claude records
`additionalContext` for the model but does not render it as a user-visible chat
message. This warning output must leave `suppressOutput` false; otherwise Claude
can consume the context while hiding the visible hook output path.

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
- multi-workspace cases skip memory without creating a
  conversation;
- multi-workspace user-prompt cases return non-blocking
  `hookSpecificOutput.additionalContext` with the selection-required message;
- Claude multi-workspace user-prompt cases also return top-level
  `systemMessage` so the same notice is visible to the user;
- Claude plugin templates mark `NAMS_WORKSPACE_ID` optional for runtime
  auto-resolution while preserving the base URL default in configuration.

## Out Of Scope

- Modeling workspace-key versus admin-key types in configuration, state, logs,
  or CLI arguments.
- Adding sibling Claude or Codex workspace hooks for first-prompt events.
- Validating an explicitly configured `workspaceId` on every hook invocation.
