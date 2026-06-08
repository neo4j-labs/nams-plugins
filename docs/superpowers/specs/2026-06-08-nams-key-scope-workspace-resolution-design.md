# NAMS Key Scope Workspace Resolution Design

Date: 2026-06-08
Status: Approved design
Repository: nams-hooks

## Summary

NAMS now has two API key scopes:

- Workspace keys, for managing memory within one current workspace.
- Admin keys, for managing workspaces and memory across all accessible workspaces.

Both key scopes can call `GET /v1/users/me/workspaces`. With a workspace key,
that endpoint always returns one workspace. With an admin key, it may return
multiple workspaces. `nams-hooks` should not model key scope directly. It should
infer behavior only from the cardinality of valid workspace IDs returned by the
workspace list endpoint.

This design amends
`docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md`.

## Goals

- Support both workspace keys and admin keys without adding a runtime key-type
  concept.
- Preserve the separation between workspace infrastructure operations and
  workspace-scoped memory operations.
- Keep memory writes deterministic: no memory request is sent without an
  effective workspace ID.
- Avoid validating configured workspace IDs during hook execution.
- Keep workspace selection validation in explicit configuration flows.

## Non-Goals

- Add `keyType`, `adminKey`, or `workspaceKey` fields to runtime config, session
  state, generated clients, logs, or hook outputs.
- Add an API key introspection request.
- Validate configured `workspaceId` before every memory hook.
- Create workspaces, delete workspaces, or manage workspace membership.

## Architecture

The existing generated client split remains correct:

- `NamsClient` owns workspace-scoped memory operations. It requires
  `workspaceId` and sends `X-Workspace-Id`.
- `NamsWorkspaceClient` owns workspace infrastructure operations. It calls
  `GET /v1/users/me/workspaces` with bearer auth and without `X-Workspace-Id`.

Runtime code does not need to know whether the API key is a workspace key or an
admin key. The workspace list response is the behavior contract:

- One valid workspace means auto-selection is safe.
- Multiple valid workspaces means explicit selection is required.
- Zero valid workspaces means memory cannot proceed.

This avoids a new key-scope abstraction that could become misleading. For
example, an admin key could still see exactly one workspace, and in that case
cardinality-only behavior should auto-select it.

## Runtime Workspace Resolution

Workspace resolution should follow this order:

1. Load connection config: `apiKey`, `baseUrl`, and optional `workspaceId`.
2. If `workspaceId` is configured through JSON config, platform config, or
   environment, record the config source and allow memory to proceed.
3. Do not call `GET /v1/users/me/workspaces` to preflight a configured
   `workspaceId` during hook execution.
4. If session state already contains a resolved workspace, allow memory to
   proceed with that workspace.
5. Otherwise call `GET /v1/users/me/workspaces` using `NamsWorkspaceClient`.
6. Filter the response to valid workspace summaries with nonblank IDs.
7. If exactly one valid workspace is returned, store it in session state and
   allow memory to proceed.
8. If multiple valid workspaces are returned, require explicit
   workspace selection/configuration.
9. If zero valid workspaces are returned, skip memory and log a fixed
   diagnostic.
10. If the workspace list request fails, fail open for the harness and skip
    memory for that turn.

Workspace keys naturally follow the single-workspace path. Admin keys usually
follow the multi-workspace path. No separate runtime branch is based on key
scope.

## Configured Workspace Precedence

Explicit `workspaceId` configuration is the highest-priority workspace source.
When configured, it wins without validation during normal hook execution.

This keeps first-prompt hooks fast and deterministic:

- No extra network call is made before memory work when config is already
  complete.
- A transient workspace-list outage does not break a configured memory flow.
- Validation errors remain attached to the explicit configuration command where
  a user can act on them.

If a configured workspace ID is invalid for the key, the first workspace-scoped
NAMS memory request will fail. Existing memory failure handling should continue
to fail open for the agent harness and log sanitized diagnostics.

## Configure Command Behavior

The explicit configure command validates workspace selection because its purpose
is to write durable config:

```bash
nams-hooks workspaces configure <gemini|claude|codex|opencode> --scope <project|user> [--workspace-id <id>]
```

The command should:

1. Load connection config with `apiKey` and `baseUrl`.
2. Call `GET /v1/users/me/workspaces` with no `X-Workspace-Id`.
3. Filter to valid workspace summaries with nonblank IDs.
4. If `--workspace-id` is provided, require it to match one returned workspace.
5. If `--workspace-id` is omitted and exactly one valid workspace is returned,
   write that workspace ID automatically.
6. If `--workspace-id` is omitted and multiple valid workspaces are returned,
   print the available choices and exit without writing config.
7. If no valid workspaces are returned or the request fails, exit without
   writing config and show a sanitized error.

This makes workspace-key setup smooth because the list endpoint returns one
workspace. It also keeps admin-key setup explicit when more than one workspace
is available.

## Platform Behavior

Gemini and OpenCode keep ordered runtime workspace resolution:

- Workspace key: one workspace is returned, so memory can start without
  `NAMS_WORKSPACE_ID`.
- Admin key with one visible workspace: one workspace is returned, so memory can
  start without `NAMS_WORKSPACE_ID`.
- Admin key with multiple workspaces: runtime requires explicit selection before
  memory writes.

For Gemini, multiple workspaces should block the prompt with a visible
workspace-selection-required message. For OpenCode, the plugin shim should skip
memory and surface configuration-required output.

Claude and Codex still use config-time workspace selection for memory hooks.
Their first-prompt hook ordering is not deterministic enough to split workspace
and memory side effects into sibling hooks. They can still use
`nams-hooks workspaces configure ...` to query workspaces and write a selected
workspace ID before hooks run.

## Diagnostics

Diagnostics should stay key-scope neutral. Prefer messages such as:

- `NAMS workspace auto-selected`
- `NAMS workspace selection required`
- `NAMS workspace list empty`
- `NAMS workspace request failed`

Do not log or infer labels such as `workspace-key` or `admin-key`. Do not log
API key values, bearer tokens, raw config contents, or arbitrary exception text.

## Testing

Implementation should add or update tests for cardinality-only behavior:

- Configured `workspaceId` skips workspace listing and is not preflight
  validated.
- A single listed workspace auto-selects, regardless of key scope.
- Multiple listed workspaces require explicit selection/configuration.
- `workspaces configure` writes the only returned workspace when
  `--workspace-id` is omitted.
- `workspaces configure` requires `--workspace-id` when multiple valid
  workspaces are returned.
- `NamsWorkspaceClient` still omits `X-Workspace-Id` for
  `GET /v1/users/me/workspaces`.

Tests should not introduce key-type fixtures. They should use response
cardinality as the observable contract.

## Documentation Updates

User-facing docs should explain:

- NAMS supports workspace keys and admin keys.
- Both key scopes can list workspaces.
- Workspace keys return exactly one workspace from
  `GET /v1/users/me/workspaces`.
- Admin keys may return multiple workspaces.
- `nams-hooks` intentionally uses the number of returned workspaces, not key
  type, to decide whether it can auto-select.
- Explicit `workspaceId` config wins and is not validated during every hook.

The docs should avoid implying that users need to choose or configure a key type
inside `nams-hooks`.

