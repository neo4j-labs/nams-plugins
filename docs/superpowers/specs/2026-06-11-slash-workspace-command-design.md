# Slash Workspace Command Design

Date: 2026-06-11
Status: Draft
Repository: nams-hooks

## Summary

Add platform command UX for selecting the NAMS workspace used by the current
agent session. Claude Code and Gemini CLI expose the command as:

```text
/nams:workspace use <workspace-id-or-name>
```

Codex exposes the same workspace command namespace through an explicit skill
invocation:

```text
$nams:workspace use <workspace-id-or-name>
```

These command surfaces are convenience wrappers only. The existing shared
configure command remains the source of truth for workspace validation and
state mutation:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

This design covers all currently supported platforms: Claude Code, OpenCode,
Gemini CLI, and Codex. Claude Code can pass the current session ID directly
through its command context. Gemini and Codex use a shared
active-session bridge recorded by the workspace-ambiguity hook path, then
resolved by the user-invoked workspace command within a short freshness window.
OpenCode remains on the explicit shell fallback until it exposes a non-prompt
command handler or a documented command-consume mechanism.

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
deterministic but not ergonomic inside an agent harness. A platform command
should let the user make the same session-local choice without copying the
platform, scope, and session ID by hand.

The command surface must not make the agent responsible for deciding whether
memory is written. It should only let the user choose the workspace for the
current session, then let the existing hooks continue owning deterministic
memory persistence.

## Goals

- Provide one memorable workspace command namespace, `nams:workspace`.
- Use `/nams:workspace use <workspace-id-or-name>` on slash-capable platforms.
- Use `$nams:workspace use <workspace-id-or-name>` for Codex skill invocation.
- Keep workspace validation, ambiguity handling, and state writes in the
  existing shared configure runtime.
- Keep platform-specific command mechanics in platform templates, plugin shims,
  or platform adapters, not in `src/cli.ts`.
- Make session workspace selection local to the current session and avoid
  writing project or user config.
- Provide an active-session bridge that can be shared by Gemini and Codex.
- Update existing documentation, README/installation docs, and user-facing hook
  or system messages where relevant to include the command while keeping the
  explicit bash configure command available.
- Preserve zero runtime npm dependencies in generated release artifacts.
- Avoid printing API keys, bearer tokens, raw config contents, or backend error
  details.

## Non-Goals

- Add workspace create, delete, rename, or management commands.
- Add an interactive workspace picker.
- Add a new NAMS endpoint or runtime OpenAPI discovery.
- Duplicate workspace list validation inside platform wrappers.
- Use agent prompts as mutable session storage.
- Promise Codex pre-turn shell execution from skills before Codex documents such
  a handler.
- Promise OpenCode slash-to-shell behavior while OpenCode markdown commands
  still invoke a model prompt after plugin hooks run.
- Change memory hook behavior beyond using the already-selected session
  workspace on later turns.

## UX Contract

Slash-capable platforms use:

```text
/nams:workspace use <workspace-id-or-name>
```

Codex uses:

```text
$nams:workspace use <workspace-id-or-name>
```

After the platform command surface has matched `nams:workspace`, the wrapper or
adapter must interpret only this subcommand:

```text
use <selector>
```

`<selector>` is the full remaining argument text after `use`. It may be an
exact workspace ID or exact workspace name. If the selector contains spaces,
the wrapper should preserve it as one selector value when invoking the shared
configure runtime.

The wrapper supplies, directly or through the active-session bridge:

- platform ID
- current harness session ID
- workspace selector

The wrapper then delegates to:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <selector>
```

For self-contained plugin artifacts, wrappers should invoke the bundled
`bin/cli.js` with `node` and an argv array where the platform can do so. For
project-level fallback templates, wrappers may invoke `nams-hooks` from `PATH`.

Wrappers must not call NAMS directly, store selected workspace IDs themselves,
inspect OpenAPI, infer hook event names from payload fields, or edit durable
config.

## Capability Tiers

### Tier 1: Direct Session Command Context

Claude Code can expose a user-invoked command surface that runs local commands,
accepts command arguments, and provides the current session ID. Its wrapper can
therefore call the existing session configure command before the next memory
hook turn.

### Tier 2: Active Workspace Session Bridge

Gemini CLI and Codex are the second implementation tier.

Gemini custom commands and Codex skills provide a useful user command surface,
but they do not both expose a documented, direct current-session substitution
that can be treated like the Claude and OpenCode command contexts. Both
platforms do, however, run NAMS hooks at the moment workspace ambiguity is
detected, and that hook path has access to the platform session ID.

When the ambiguity notice is produced, the adapter records a short-lived active
workspace-session marker. A later `/nams:workspace use ...` or
`$nams:workspace use ...` invocation resolves that marker, obtains the session
ID, and delegates to the shared configure runtime.

### Future Tier: Native Codex Command Handler

If Codex later provides a documented user command handler with deterministic
shell execution and current-session metadata, the Codex skill can be replaced
or supplemented by a direct wrapper. The wrapper contract remains the same:
match `nams:workspace`, parse `use <selector>`, obtain the current Codex
session ID, and delegate to the shared configure command without duplicating
workspace validation or state writes.

### Future Tier: Native OpenCode Command Handler

OpenCode plugins can observe `command.execute.before`, and that event includes
the command name, arguments, and session ID. However, current OpenCode markdown
commands are prompt templates. The command execution path triggers plugins with
mutable prompt `parts`, ignores hook return values, and then unconditionally
calls the prompt path. Because the plugin cannot set `noReply` or consume the
command, nams-hooks must not package `.opencode/commands/nams:workspace.md`.

If OpenCode later exposes a non-prompt command handler or documented consume
mechanism, the existing shim contract can be used: match `nams:workspace`, parse
`use <selector>`, obtain the current OpenCode session ID, and delegate to the
shared configure command without duplicating workspace validation or state
writes.

## Active Workspace Session Bridge

The bridge is generic across platforms and stores only the session candidates
that recently hit workspace-selection ambiguity.

The marker file path is:

```text
~/.nams/state/<platform>/active-workspace-sessions.json
```

The marker file shape is:

```json
{
  "sessions": [
    {
      "sessionId": "10c34bad-1b86-497c-91d4-0c711dedee7a",
      "sessionKey": "10c34bad-1b86-497c-91d4-0c711dedee7a",
      "projectDirectory": "/absolute/project/path",
      "statePath": "/home/user/.nams/state/gemini/session-...json",
      "touchedAt": "2026-06-14T10:00:00.000Z"
    }
  ]
}
```

The file has no explicit version field, matching the existing runtime state
style. If the file is missing, unreadable, malformed, or lacks a valid
`sessions` array, the bridge treats it as empty and rewrites the clean shape on
the next successful record.

Adapters record a marker only when workspace resolution reaches the
multi-workspace selection-required path, the same path that emits:

```text
No memory messages were stored. Multiple NAMS workspaces are available, and no workspaceId is configured.
```

Recording is best-effort. If the marker cannot be written, the hook still emits
the ambiguity notice and remains fail-open for the agent harness. The marker
write must use existing private directory and file helpers so state directories
stay owner-only and marker files are written as owner-only files.

Resolution uses these rules:

1. Filter records to the current platform marker file, current project
   directory, and records touched within 60 seconds.
2. Prune stale records when reading or writing the marker file.
3. If exactly one fresh record remains, use its `sessionId`.
4. If more than one fresh record remains, choose the newest only when it is at
   least 15 seconds newer than the next candidate.
5. Otherwise fail closed and show the explicit manual configure command with
   `<session-id>`.

This accepts the common case where the user runs the command immediately after
the ambiguity notice, while avoiding guesses across several plausible active
sessions.

## Platform Designs

### Claude Code

Package a Claude slash-invocable command asset with both the baseline Claude
template and the Claude plugin. Claude Code treats custom commands and skills as
the same command surface for this purpose. The user invokes:

```text
/nams:workspace use Engineering
```

The command should be user-invoked only. If the Claude command format supports a
model-invocation disable flag, set it so the model does not run this command
autonomously.

The command asset must not interpolate `$ARGUMENTS` into dynamic shell content.
Claude runs dynamic `!` commands before the command content reaches Claude, and
`$ARGUMENTS` is the raw user-typed argument string. Instead, the templates
should wire `UserPromptExpansion` hooks directly to the shared CLI workspace
runner. The baseline template delegates to `nams-hooks` from `PATH`; the plugin
invokes the bundled CLI with exec-form `args`:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/cli.js workspaces run claude --event UserPromptExpansion
```

The workspace runner reads the `UserPromptExpansion` JSON from stdin, obtains
the current session ID from the Claude payload, normalizes `use <selector>` from
the command arguments, and delegates to the existing session-scoped configure
runtime. The runner should preserve all text after `use` as the selector.

If no session ID is available, the runner blocks the slash expansion without
writing state and prints a short message that includes the equivalent manual
command with `<session-id>`.

### OpenCode

Keep OpenCode session workspace selection on the explicit shell command for now:

```bash
nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

The OpenCode plugin shim may retain an internal `command.execute.before` handler
for future compatibility, but nams-hooks must not package an OpenCode markdown
command file for `nams:workspace`. OpenCode command files are prompt templates,
and testing showed that a command file configures the workspace through the
plugin and then still sends the command template to the model.

The source-level `command.execute.before` trigger receives:

```ts
{ command: input.command, sessionID: input.sessionID, arguments: input.arguments }
```

with mutable prompt `parts`. OpenCode ignores the hook return value and then
unconditionally calls its prompt path. The prompt input type supports
`noReply`, but the command execution path does not expose that field as mutable
plugin output. Returning `{ stop: true }` or throwing from the hook is therefore
not a safe, documented model-invocation disable mechanism.

If a future OpenCode release adds a non-prompt command surface, the plugin
should forward the raw command event payload to:

```bash
nams-hooks workspaces run opencode --event CommandExecuteBefore
```

The shared CLI workspace runner then:

1. derives the selector from the remaining arguments;
2. requires a nonblank `sessionID` from the OpenCode command event;
3. delegates to `nams-hooks workspaces configure opencode --scope session --session-id
   <sessionID> --workspace <selector>`;
4. surfaces the command stdout or stderr to the user; and
5. prevents a normal model turn for this command when the OpenCode plugin API
   supports doing so through a documented mechanism.

The plugin should ignore unrelated `nams:workspace` subcommands so future
command surfaces remain possible. It should also ignore other slash commands.

The existing `NAMS_HOOKS_COMMAND` environment override should continue to apply
to OpenCode. This keeps local development and packaged installs aligned with
the current shim.

### Gemini CLI

Package a Gemini custom command with the Gemini extension:

```text
/nams:workspace use Engineering
```

The command invokes the bundled workspace runner:

```bash
node "${extensionPath}/bin/cli.js" workspaces run gemini --event CustomCommand
```

The command passes a small JSON payload on stdin containing the matched command
name and raw argument text, for example:

```json
{
  "command_name": "nams:workspace",
  "command_args": "use Engineering"
}
```

The Gemini adapter owns parsing this payload. It validates the command name,
extracts the selector from `use <selector>`, resolves the current session ID
through `~/.nams/state/gemini/active-workspace-sessions.json`, and delegates to
the shared configure runtime.

The Gemini memory hook records the active-session marker only when it reaches
the workspace-selection ambiguity path. If the user runs the command after the
60 second freshness window or while multiple fresh sessions are ambiguous, the
command fails without writing state and prints the explicit manual configure
command with `<session-id>`.

### Codex

Package a Codex skill with the Codex plugin. The skill name is:

```text
nams:workspace
```

The user invokes:

```text
$nams:workspace use Engineering
```

The Codex plugin manifest should add:

```json
{
  "skills": "./skills/"
}
```

The skill should include `agents/openai.yaml` with:

```yaml
policy:
  allow_implicit_invocation: false
```

The skill remains script-free. Its instructions tell Codex to run the NAMS
workspace runner with a payload equivalent to:

```json
{
  "command_name": "nams:workspace",
  "command_args": "use Engineering"
}
```

The preferred command uses the plugin-bundled CLI when the loaded skill path
makes the plugin root obvious:

```bash
node <plugin-root>/bin/cli.js workspaces run codex --event CustomCommand
```

If the plugin root cannot be resolved from the skill context, the skill may
fall back to:

```bash
nams-hooks workspaces run codex --event CustomCommand
```

This fallback is explicit because Codex documents plugin-bundled hooks with
`${PLUGIN_ROOT}`, but does not document `${PLUGIN_ROOT}` as a shell variable
available to skill-instructed commands.

The Codex adapter implements the same `CustomCommand` behavior as Gemini:
validate `nams:workspace`, parse `use <selector>`, resolve the session ID from
`~/.nams/state/codex/active-workspace-sessions.json`, and delegate to the shared
configure runtime. Codex skill activation is deterministic when the user types
`$nams:workspace`, but the actual shell execution still happens through
Codex's normal tool loop until Codex provides a direct command handler.

## Data Flow

Direct command-context platforms use this flow:

1. The user invokes `/nams:workspace use <selector>`.
2. The platform wrapper parses `use <selector>` and extracts `<selector>`.
3. The wrapper obtains the current platform session ID from the command event.
4. The wrapper invokes the shared configure command with platform, session ID,
   and selector.

Active-session bridge platforms use this flow:

1. A memory hook detects multiple NAMS workspaces and no effective workspace ID.
2. The platform adapter records the session ID, session key, project directory,
   optional state path, and touch timestamp in
   `~/.nams/state/<platform>/active-workspace-sessions.json`.
3. The hook emits the existing ambiguity notice, including the command UX and
   the explicit manual configure fallback.
4. The user invokes `/nams:workspace use <selector>` for Gemini or
   `$nams:workspace use <selector>` for Codex.
5. The platform adapter resolves a fresh active-session marker.
6. The adapter invokes the shared configure command with platform, resolved
   session ID, and selector.

The shared configure runtime then:

1. loads connection config for `apiKey` and `baseUrl`;
2. lists available workspaces without `X-Workspace-Id`;
3. selects by exact ID or exact unambiguous name;
4. writes `state.workspace = { id, source: "session-selection", selectedAt }`;
   and
5. lets the next memory hook for the same session use the session-selected
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

Wrappers and platform adapters are responsible for:

- rejecting command names other than `nams:workspace`;
- rejecting command forms other than `use <selector>`;
- rejecting a blank selector before invoking the configure runtime;
- rejecting missing current session ID for direct command-context platforms;
- resolving or failing closed on missing or ambiguous active-session markers;
- showing the manual configure command when a session ID cannot be supplied; and
- surfacing sanitized configure stdout or stderr to the user.

Marker recording failures must not block normal hook output. Marker parsing
failures must not print raw file contents and should be treated as an empty
marker file. Bridge resolution must not guess when multiple fresh sessions are
too close together.

Wrappers must not print API keys, bearer tokens, raw config contents, raw
backend exception text, or hidden reasoning. Workspace IDs and workspace names
may appear in CLI output because they are already part of the user-facing
selection flow.

## Packaging

All command assets belong in source templates and are copied or rendered into
`dist/` by `npm run dist`.

Claude command assets should live in both the baseline Claude template tree and
the Claude plugin template tree so the self-contained Claude plugin gets the
slash command alongside hooks and bundled `bin/cli.js`.

OpenCode hook handling should live in the existing OpenCode plugin shim.
OpenCode currently uses the template directly rather than a generated plugin
marketplace artifact, so tests should cover the source template. The template
must not include `.opencode/commands/nams:workspace.md` until OpenCode exposes a
non-prompt command surface or a documented command-consume mechanism.

Gemini command assets should live under the Gemini extension template tree, in
the command directory structure Gemini expects for the `nams` namespace and
`workspace` command. The generated extension should include the command asset
alongside hooks and bundled `bin/cli.js`.

Codex skill assets should live under
`templates/codex/plugins/codex-nams-hooks/skills/`. The Codex plugin manifest
should expose `"skills": "./skills/"`, and the generated Codex plugin should
include the skill, `agents/openai.yaml`, hooks, and bundled `bin/cli.js`.

Generated `dist/` output must not be hand-edited.

## Testing

The implementation plan should cover all four platforms, with behavior tiered
by platform capability.

Shared active-session bridge tests should assert:

- marker files are written under `~/.nams/state/<platform>/active-workspace-sessions.json`;
- malformed or missing marker files are treated as empty;
- stale records older than 60 seconds are pruned;
- exactly one fresh session resolves;
- multiple fresh sessions resolve only when the newest is at least 15 seconds
  newer than the next candidate;
- ambiguous fresh sessions fail closed;
- platform and project directory isolation are preserved; and
- marker writes use existing private path helpers where tests can assert it.

Claude tests should assert:

- the packaged command asset exists in the baseline Claude template tree and
  the Claude plugin template tree;
- the command expects `use <selector>`;
- it has no dynamic shell command containing raw `$ARGUMENTS`;
- `UserPromptExpansion` hooks invoke `nams-hooks workspaces run claude --event
  UserPromptExpansion` or the bundled `bin/cli.js` equivalent; and
- no separate `workspace-use.mjs` helper is packaged.

OpenCode tests should simulate the plugin command event and assert:

- the OpenCode template does not include `.opencode/commands/nams:workspace.md`;
- a simulated `nams:workspace` command event spawns `workspaces run opencode --event
  CommandExecuteBefore`;
- command payloads, including selectors with spaces, are forwarded to the CLI
  over stdin;
- unrelated commands do not invoke the workspace runner; and
- failed CLI output is surfaced to the user.

Gemini tests should assert:

- the ambiguity hook path records an active-session marker;
- marker write failure does not block the ambiguity notice;
- `/nams:workspace use Engineering` invokes `workspaces run gemini --event
  CustomCommand`;
- command payload parsing preserves selectors with spaces;
- resolved active sessions delegate to `configure gemini --scope session`; and
- missing or ambiguous active sessions fail without writing workspace state.

Codex tests should assert:

- the ambiguity hook path records an active-session marker;
- marker write failure does not block the ambiguity notice;
- `$nams:workspace use Engineering` is documented by a packaged skill named
  `nams:workspace`;
- the Codex plugin manifest exposes `"skills": "./skills/"`;
- the skill includes `allow_implicit_invocation: false`;
- `CustomCommand` parsing preserves selectors with spaces;
- resolved active sessions delegate to `configure codex --scope session`; and
- missing or ambiguous active sessions fail without writing workspace state.

Documentation and packaging tests should assert:

- generated `dist/` contains the Gemini command asset;
- generated `dist/` contains the Codex skill asset and manifest `skills` field;
- docs, README/installation docs, and relevant user-facing hook or system
  messages mention `/nams:workspace` for slash-capable platforms and avoid
  advertising it for OpenCode until OpenCode has a non-prompt command surface;
- Codex docs mention `$nams:workspace`; and
- the explicit bash configure command remains present as the reliable fallback.

Existing shared CLI tests already cover workspace selector validation, session
state writes, state preservation, workspace precedence, and no-write failures.
Wrapper tests should not duplicate those cases.

Manual verification should include:

- `npm run check`;
- `npm run dist`;
- `npm run dist:check` when available;
- a Gemini extension smoke test for `/nams:workspace use ...`; and
- a Codex plugin and skill smoke test focused on whether the skill can locate
  the bundled CLI or fall back clearly to `nams-hooks` on `PATH`.

## Implementation Boundary

The next implementation plan should implement:

- the shared active workspace-session bridge helper;
- Gemini marker recording, `CustomCommand` handling, command packaging, tests,
  and docs;
- Codex marker recording, `CustomCommand` handling, skill packaging, tests, and
  docs;
- any small updates needed to keep Claude behavior aligned with the
  `nams:workspace` namespace and keep OpenCode on the explicit fallback; and
- documentation, README/installation docs, and relevant user-facing hook or
  system message updates that describe the command UX while keeping the
  explicit bash configure command.

The implementation must keep `src/cli.ts` as a gateway. Typed events are added
to shared contracts before platform adapters handle them, and payload parsing
stays in platform-specific code.
