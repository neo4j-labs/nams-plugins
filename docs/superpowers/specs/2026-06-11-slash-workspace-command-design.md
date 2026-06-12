# Slash Workspace Command Design

Date: 2026-06-11
Status: Draft
Repository: nams-hooks

## Summary

Add a platform command UX for selecting the NAMS workspace used by the current
agent session:

```text
/nams-hooks workspaces use <workspace-id-or-name>
```

For Claude Code, both project-template installs and plugin installs use this
direct command.

The slash command is a convenience wrapper only. The existing shared command
remains the source of truth for workspace validation and state mutation:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

This design covers all currently supported platforms: Claude Code, OpenCode,
Gemini CLI, and Codex. Implementation should start with Claude Code and
OpenCode because their user-command surfaces can deterministically run local
commands and provide the current session ID. Gemini and Codex are designed here
but deferred until their command/session bridge constraints are resolved.

This design follows the research note in
`docs/session-workspace-command-support.md` and builds on
`docs/superpowers/specs/2026-06-10-session-workspace-selection-design.md`.

## Context

The shared session-scoped configure command is already implemented for
`gemini`, `claude`, `codex`, and `opencode`. It validates workspace selectors
against `GET /v1/users/me/workspaces`, writes only local session state, and
marks the state workspace source as `session-selection`. Runtime workspace
resolution already treats session selection as the strongest workspace source.

When a NAMS key can see multiple workspaces and no effective workspace is
configured, current hook notices show the explicit configure command. That is
deterministic but not ergonomic inside an agent harness. A slash-invocable
command should let the user make the same session-local choice without copying
the platform, scope, and session ID by hand.

The command surface must not make the agent responsible for deciding whether
memory is written. It should only let the user choose the workspace for the
current session, then let the existing hooks continue owning deterministic
memory persistence.

## Goals

- Provide one memorable wrapper subcommand,
  `workspaces use <workspace-id-or-name>`, behind each platform's deterministic
  command surface.
- Keep workspace validation, ambiguity handling, and state writes in the
  existing shared configure runtime.
- Keep platform-specific command mechanics in platform templates or plugin
  shims, not in `src/cli.ts`.
- Make session workspace selection local to the current session and avoid
  writing project or user config.
- Design behavior for all supported platforms while implementing only the
  deterministic first tier initially.
- Update existing documentation, README/installation docs, and user-facing hook
  or system messages where relevant to include the slash command while keeping
  the explicit bash configure command available.
- Preserve zero runtime npm dependencies in generated release artifacts.
- Avoid printing API keys, bearer tokens, raw config contents, or backend error
  details.

## Non-Goals

- Add workspace create, delete, rename, or management commands.
- Add an interactive workspace picker.
- Add a new NAMS endpoint or runtime OpenAPI discovery.
- Duplicate workspace list validation inside platform wrappers.
- Promise deterministic slash-to-shell behavior for platforms that do not expose
  it yet.
- Change memory hook behavior beyond using the already-selected session
  workspace on later turns.

## UX Contract

The cross-platform wrapper subcommand is:

```text
workspaces use <workspace-id-or-name>
```

The wrapper must interpret only this subcommand:

```text
workspaces use <selector>
```

`<selector>` is the full remaining argument text after `workspaces use`. It may
be an exact workspace ID or exact workspace name. If the selector contains
spaces, the wrapper should pass it to the shared CLI as one argv value where the
platform command API permits it.

The wrapper supplies:

- platform ID
- current harness session ID
- workspace selector

The wrapper then invokes:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <selector>
```

For self-contained plugin artifacts, wrappers should invoke the bundled
`bin/cli.js` with `node` and an argv array. For project-level fallback templates,
wrappers may invoke `nams-hooks` from `PATH`.

Wrappers must not call NAMS directly, store workspace IDs themselves, inspect
OpenAPI, infer hook event names from payload fields, or edit durable config.

## Capability Tiers

### Tier 1: Deterministic Slash UX

Claude Code and OpenCode are the first implementation tier.

Both platforms can expose user-invoked command surfaces that run local commands,
accept command arguments, and provide the current session ID. Their wrappers can
therefore call the existing session configure command before the next memory
hook turn.

Implementation planning should focus on this tier first.

### Tier 2: Designed, Deferred Session Bridge

Gemini CLI is the second tier.

Gemini custom commands can run shell snippets, and Gemini hooks expose
`GEMINI_SESSION_ID`. The unresolved gap is whether custom-command shell
execution reliably receives that session ID. Gemini should not ship this slash
command until the runtime has a deterministic bridge from the user-invoked
command to the current Gemini session.

### Tier 3: Prompt Helper Until Deterministic Commands Exist

Codex is the third tier.

Codex hooks can run shell commands, and hook notices can include a parsed
session ID when available. Current custom prompt or skill surfaces expand into
model instructions rather than a documented deterministic pre-turn command
handler. Codex should therefore expose a helper workflow, not a guaranteed
slash-to-shell command, until Codex provides a direct user command handler or a
documented current-session substitution.

## Platform Designs

### Claude Code

Package a Claude slash-invocable command asset with both the baseline Claude
template and the Claude plugin. Claude Code treats custom commands and skills as
the same command surface for this purpose. The user invokes:

```text
/nams-hooks workspaces use Engineering
```

The command should be user-invoked only. If the Claude command format supports a
model-invocation disable flag, set it so the model does not run this command
autonomously.

The command asset must not interpolate `$ARGUMENTS` into dynamic shell content.
Claude runs dynamic `!` commands before the command content reaches Claude, and
`$ARGUMENTS` is the raw user-typed argument string. Instead, the templates
should wire `UserPromptExpansion` hooks and invoke Node helpers. The baseline
template invokes a helper from `.claude/scripts/` that delegates to
`nams-hooks` from `PATH`; the plugin invokes a bundled helper with exec-form
`args`:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace-use.mjs
```

The helper should read the `UserPromptExpansion` JSON from stdin, obtain the
current session ID from `session_id` with a safe `${CLAUDE_SESSION_ID}`
fallback, normalize `workspaces use <selector>` from `command_args`, and spawn
the shared CLI with an argv array. The helper should preserve all text after
`workspaces use` as the selector.

If no session ID is available, the helper blocks the slash expansion without
writing state and prints a short message that includes the equivalent manual
command with `<session-id>`.

### OpenCode

Implement OpenCode command handling inside
`templates/opencode/plugins/nams-hooks.js`.

The plugin should intercept the earliest deterministic OpenCode command event
that can stop or replace normal command execution. The research note identifies
the source-level `command.execute.before` trigger as the best fit; current
public docs also list command and TUI command events, so implementation must
verify the exact trigger against the supported OpenCode plugin API before
shipping. For command `nams-hooks`, when the supplied arguments begin with
`workspaces use`, the plugin should:

1. derive the selector from the remaining arguments;
2. require a nonblank `sessionID` from the OpenCode command event;
3. call `nams-hooks workspaces configure opencode --scope session --session-id
   <sessionID> --workspace <selector>`;
4. surface the command stdout or stderr to the user; and
5. prevent a normal model turn for this command when the OpenCode plugin API
   supports doing so.

The plugin should ignore unrelated `nams-hooks` subcommands so future command
surfaces remain possible. It should also ignore other slash commands.

The existing `NAMS_HOOKS_COMMAND` environment override should continue to apply
to OpenCode. This keeps local development and packaged installs aligned with
the current shim.

### Gemini CLI

Design Gemini around a custom command packaged with the Gemini extension:

```text
/nams-hooks workspaces use Engineering
```

The command eventually calls:

```bash
node "${extensionPath}/bin/cli.js" workspaces configure gemini --scope session --session-id <resolved-session-id> --workspace <selector>
```

Before shipping the command, add a deterministic session bridge. The bridge
should be local, session-scoped, and built from data Gemini hooks already expose.
Two acceptable bridge shapes are:

- hook-recorded current-session metadata that the custom command can resolve
  from the project directory and current process context; or
- a small shared CLI helper that resolves the active Gemini session from local
  NAMS session state when invoked from Gemini.

The bridge must avoid relying on mutable agent prompts as state. It must also
avoid guessing across multiple plausible active Gemini sessions. If the current
session cannot be resolved uniquely, the command should fail and print the
manual configure command with `<session-id>`.

### Codex

Codex should not advertise a deterministic slash command for this feature yet.

The designed interim UX is a prompt helper or skill that tells Codex to run the
existing configure command through its normal command tool:

```bash
nams-hooks workspaces configure codex --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

Hook notices should remain the primary Codex path. When the Codex adapter can
parse the harness session ID, the notice should include the concrete session ID.
Otherwise it should keep the `<session-id>` placeholder.

Any future Codex deterministic command implementation must follow the same
wrapper contract: parse `workspaces use`, obtain the current Codex session ID,
and delegate to the shared configure command without duplicating workspace
validation or state writes.

## Data Flow

1. The user invokes the platform command with `workspaces use <selector>`.
2. The platform wrapper parses `workspaces use` and extracts `<selector>`.
3. The wrapper obtains the current platform session ID from the platform command
   context or a deterministic local bridge.
4. The wrapper invokes the shared configure command with platform, session ID,
   and selector.
5. The shared runtime loads connection config for `apiKey` and `baseUrl`.
6. The shared runtime lists available workspaces without `X-Workspace-Id`.
7. The shared runtime selects by exact ID or exact unambiguous name.
8. The shared runtime writes `state.workspace = { id, source:
   "session-selection", selectedAt }`.
9. The next memory hook for the same session uses the session-selected
   workspace before durable config or environment workspace IDs.

## Error Handling

Wrappers should preserve existing CLI failures and make only small
platform-friendly additions.

The shared configure command remains responsible for:

- missing or ambiguous workspace selector;
- unknown workspace selector;
- zero valid workspaces;
- failed workspace list request;
- missing `apiKey` or `baseUrl`;
- unsafe config or session-state paths; and
- writing state only after successful validation.

Wrappers are responsible for:

- rejecting command forms other than `workspaces use <selector>`;
- rejecting a blank selector before invoking the CLI;
- rejecting missing current session ID before invoking the CLI; and
- showing the manual configure command when a session ID cannot be supplied.

Wrappers must not print API keys, bearer tokens, raw config contents, raw
backend exception text, or hidden reasoning. Workspace IDs and workspace names
may appear in CLI output because they are already part of the user-facing
selection flow.

## Packaging

All command assets belong in source templates and are copied or rendered into
`dist/` by `npm run dist`.

Claude command assets should live under the Claude plugin template tree so the
self-contained Claude plugin gets the slash command alongside hooks and bundled
`bin/cli.js`.

OpenCode command handling should live in the existing OpenCode plugin shim.
OpenCode currently uses the template directly rather than a generated plugin
marketplace artifact, so tests should cover the source template.

Gemini command assets, when implemented, should live under the Gemini extension
template tree. The session bridge must be designed before adding user-visible
Gemini command files.

Codex helper assets, if added, should make clear that they are prompt helpers
unless Codex provides deterministic user command execution.

Generated `dist/` output must not be hand-edited.

## Testing

The first implementation plan should cover Claude Code and OpenCode.

Claude tests should assert:

- the packaged command asset exists in the baseline Claude template tree and
  the Claude plugin template tree;
- the command expects `workspaces use <selector>`;
- it has no dynamic shell command containing raw `$ARGUMENTS`;
- `UserPromptExpansion` hooks invoke safe Node helpers without shell-expanded
  selector arguments;
- the baseline helper invokes `nams-hooks workspaces configure claude`;
- the plugin helper invokes bundled `bin/cli.js` with
  `workspaces configure claude`;
- it passes `--scope session`;
- it uses `session_id` from the hook input as the primary session ID source; and
- it passes the workspace selector as one argument.

OpenCode tests should simulate the plugin command event and assert:

- `/nams-hooks workspaces use Engineering` spawns `configure opencode`;
- the spawned argv includes `--scope session`, `--session-id <sessionID>`, and
  `--workspace Engineering`;
- selectors with spaces are preserved;
- unrelated commands do not run configure;
- blank selectors fail without invoking NAMS; and
- failed CLI output is surfaced to the user.

Existing shared CLI tests already cover workspace selector validation, session
state writes, state preservation, workspace precedence, and no-write failures.
Wrapper tests should not duplicate those cases.

Gemini and Codex can remain spec-only for the first implementation plan. When
their deferred tiers begin, add tests for the session bridge or prompt-helper
assets before implementation.

## Implementation Boundary

The next implementation plan should implement only Tier 1:

- Claude Code command asset and template tests.
- OpenCode plugin command interception and template tests.
- Documentation, README/installation docs, and relevant user-facing hook or
  system message updates that describe the Tier 1 slash UX, keep the explicit
  bash configure command, and explain the Gemini/Codex limitations.

Gemini and Codex should remain designed but deferred until a later plan. This
keeps the cross-platform product direction visible without expanding behavior
where the platform command surface is not yet deterministic.
