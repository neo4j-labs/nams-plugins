# Session Workspace Selection Design

Date: 2026-06-10
Status: Draft
Repository: nams-hooks

## Summary

Add session-scoped workspace selection for multi-workspace NAMS users. A user
should be able to choose a workspace for only the current agent session without
editing project or user configuration:

```bash
nams-hooks workspaces configure <gemini|claude|codex|opencode> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

Platform-specific shortcuts are deferred follow-up work. The shared command is
the source of truth for validation and state mutation.

This design amends:

- `docs/superpowers/specs/2026-06-03-nams-workspace-id-design.md`
- `docs/superpowers/specs/2026-06-05-nams-workspace-resolution-hook-design.md`
- `docs/superpowers/specs/2026-06-08-nams-key-scope-workspace-resolution-design.md`
- `docs/superpowers/specs/2026-06-09-inline-workspace-resolution-design.md`

## Context

The current workspace resolver supports user, project, and platform-discovered
configuration, environment overrides, session state from runtime
single-workspace auto-selection, and cardinality-based workspace discovery.
When an admin key can see multiple workspaces, the resolver skips memory for
the turn and asks the user to configure a workspace explicitly.

Durable project or user configuration is too heavy for an agentic session where
the user wants to switch only the active conversation. The existing session
state model already stores a selected workspace, so the missing piece is an
explicit configuration path that writes that state after validating the chosen
workspace.

The 2026-06-05 workspace-resolution design left multi-workspace command-based
selection as a later design. This is that design for the shared CLI command.

## Goals

- Let a user select a NAMS workspace for the current agent session only.
- Preserve deterministic memory writes: no memory request is sent without an
  effective workspace ID.
- Keep `src/cli.ts` as a gateway that parses command arguments and dispatches
  through the platform registry.
- Leave any future platform-specific shortcut mechanics inside platform
  templates or adapters.
- Validate explicit session selections through `GET /v1/users/me/workspaces`.
- Avoid writing project or user config for session-scoped selections.
- Preserve existing runtime dependency constraints.

## Non-Goals

- Model workspace-key versus admin-key types.
- Create, delete, rename, or manage NAMS workspaces.
- Add a cross-platform interactive picker in this change.
- Store complete workspace lists in session state.
- Change the NAMS memory API request shape.
- Implement platform-specific shortcut commands.

## Command Model

Extend the existing configure command to accept a third scope:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

`project` and `user` keep their current behavior and write JSON config. `session`
writes only local session state under `~/.nams/state/<platform>/`.

For session scope:

- `--session-id` is required.
- `--workspace` accepts either a workspace ID or an exact workspace name.
- `--workspace` is optional only when NAMS returns exactly one valid
  workspace.
- `--workspace`, when provided, must match one returned workspace ID or exactly
  one returned workspace name.
- duplicate workspace names are ambiguous and must fail with the available
  choices instead of guessing.
- the selected workspace is written to the resolved session state.

The existing `--workspace-id` flag may remain supported for `project` and
`user` scopes, and may be accepted as a compatibility alias for session scope
when the value is known to be an ID. New user-facing session-selection docs
should prefer `--workspace`.

Future platform wrappers should call this same session-scoped configure command
after supplying the current platform and session ID. They must not duplicate
workspace validation or state mutation logic.

## Workspace Precedence

Memory resolution should use this precedence:

1. session-selected workspace
2. `NAMS_WORKSPACE_ID`
3. platform-discovered workspace config
4. project JSON config
5. user JSON config
6. runtime single-workspace auto-selection

Session selection is the strongest override because it is an explicit choice by
the user inside the active agent session. It should override environment,
durable project, user, and platform-discovered defaults for that session only.
`NAMS_WORKSPACE_ID` remains stronger than durable config but weaker than the
session-selected workspace.

This is a deliberate change from the current resolver, where all configured
workspace IDs win before session state. The implementation should preserve clear
diagnostics by distinguishing the environment workspace override from
session selection, platform-discovered, project, and user workspace
configuration.

## Session State

Add a new session workspace source:

```ts
type SessionWorkspaceSource =
  | "config"
  | "runtime-single-workspace"
  | "install-selection"
  | "session-selection";
```

Session-scoped configuration writes:

```ts
workspace: {
  id: string;
  source: "session-selection";
  selectedAt: string;
}
```

If state already exists, preserve all unrelated fields, including conversation
IDs, dedupe sets, pending memory context, and timestamps. Replace only the
`workspace` field. If no state exists for the provided session key, create a
fresh state with the provided platform, session ID, cwd, and selected workspace.

## Runtime Flow

The shared workspace configuration runtime should handle all validation and
writes.

For `scope: "session"`:

1. Load connection config for `apiKey` and `baseUrl`.
2. Call `GET /v1/users/me/workspaces` through `NamsWorkspaceClient` with bearer
   auth and without `X-Workspace-Id`.
3. Filter to valid workspace summaries with nonblank IDs.
4. Select the requested workspace by exact ID or exact name, or auto-select the
   only returned workspace when `--workspace` is omitted.
5. Fail without writing state if the requested selector matches no workspace or
   matches more than one workspace name.
6. Resolve the session key from `platform`, `--session-id`, and cwd.
7. Load existing session state or create initial state.
8. Write `state.workspace.source = "session-selection"`.
9. Save the session state.
10. Print a concise success message naming the platform, session ID, and
   workspace ID.

The CLI should parse `--scope session`, `--session-id`, and `--workspace`,
then route through the existing workspace adapter with an opaque raw payload.
It should not parse platform hook payloads or infer session IDs from stdin.

## Deferred Platform Shortcuts

Platform-specific shortcuts are out of scope for this change. OpenCode is a
likely first follow-up because its plugin shim is already a JavaScript boundary
that sees session metadata and can invoke the bundled `nams-hooks` command.

Gemini, Claude, and Codex should begin with documented shell command support
unless their command extension surfaces expose a verified way to register a
shortcut and pass the current session ID safely. Adding one platform's shortcut
must not duplicate workspace validation or state mutation logic.

## Error Handling

Session-scoped configuration should fail explicitly and leave existing state
unchanged when it cannot validate a selection:

- Missing `--session-id`: exit non-zero with a message that session scope
  requires `--session-id`.
- Missing `--workspace` with multiple valid workspaces: print available
  workspace choices and exit without writing state.
- Unknown `--workspace`: print the requested selector plus available choices
  and exit without writing state.
- Ambiguous workspace name: print the requested name plus matching choices and
  exit without writing state.
- Zero valid workspaces: print the existing no-workspaces message and exit
  without writing state.
- Workspace list request failure: print the existing sanitized request-failed
  message and exit without writing state.
- Missing `apiKey` or `baseUrl`: reuse existing config diagnostic wording.

Normal memory hooks remain fail-open. If a configured or session-selected
workspace later fails a workspace-scoped NAMS memory request, the existing NAMS
failure handling continues to skip memory effects for that turn and allow the
agent harness to continue.

## Diagnostics And Security

Diagnostics should remain key-scope neutral and avoid secret leakage. Add a
fixed diagnostic for session selection, for example:

- `NAMS workspace loaded from session selection`

or reuse `NAMS workspace loaded from session state` with
`source: "session-selection"` in the payload. The latter is preferable because
it keeps the diagnostic vocabulary small.

Do not log API keys, bearer tokens, raw config contents, arbitrary exception
text, or hidden reasoning. Workspace IDs may appear in state and sanitized
diagnostics as routing identifiers. The complete workspace list should remain
diagnostic context only and must not be persisted to session state.

## User-Facing Notices

When memory is inactive because multiple workspaces are available, platform
notices should recommend the session-scoped command as the quickest fix:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

The current project/user configure command remains useful when the user wants a
durable default rather than a current-session selection.

## Testing

Add or update tests before implementation:

- CLI accepts `--scope session --session-id`.
- CLI rejects session scope without `--session-id`.
- Session configure writes `state.workspace.source = "session-selection"`.
- Session configure preserves existing session fields while replacing only
  `workspace`.
- Session configure creates a fresh state when no session state exists.
- Session-selected workspace is used before project/user config.
- Session-selected workspace is used before `NAMS_WORKSPACE_ID`.
- `NAMS_WORKSPACE_ID` is used before project/user config when no session
  selection exists.
- Invalid requested workspace selector does not write session state.
- Exact workspace name selects the matching workspace.
- Duplicate workspace names are reported as ambiguous and do not write session
  state.
- Omitted workspace selector auto-selects only when exactly one valid workspace
  is returned.
- Multi-workspace memory notices mention the session command.
- Platform shortcut tests are added only for platforms that implement a
  verified wrapper in a follow-up change.

Existing tests should continue to prove that `NamsWorkspaceClient` calls
`GET /v1/users/me/workspaces` without `X-Workspace-Id`, and that memory
requests still use `NamsClient` with an effective workspace ID.

## Documentation

Update `README.md` and `INSTALL.md` to describe three workspace selection
lifetimes:

- `user`: durable default for all projects.
- `project`: durable default for one project.
- `session`: temporary selection for one active agent session.

Docs should explain that `session` is useful for admin keys that can see
multiple workspaces and for conversations that need to switch memory context
without changing defaults.

## Rollout

Implement the shared session-scope CLI and runtime first. That gives every
platform a testable command path. Treat platform shortcut commands as follow-up
work unless their command APIs are verified during implementation planning.
