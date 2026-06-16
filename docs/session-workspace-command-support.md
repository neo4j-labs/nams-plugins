# Session Workspace Command Support Research

Research date: 2026-06-11

Updated against local `devel` after the shared session-scope configure command
landed.

This note tracks the implemented session-scoped workspace configure command and
which currently supported `nams-hooks` platforms expose a user-invoked command
surface that can wrap it. Claude Code project templates and Gemini expose:

```text
# Claude Code project template and Gemini CLI
/nams:workspace use <workspace-id-or-name>
```

Claude marketplace plugin installs expose the plugin-namespaced command:

```text
/nams-hooks:nams:workspace use <workspace-id-or-name>
```

Codex exposes the same namespace as an explicit skill:

```text
$nams:workspace use <workspace-id-or-name>
```

OpenCode currently uses the explicit shell command because its markdown command
files are prompt templates and do not expose a documented model-invocation
disable flag.

The explicit shell configure command remains the fallback and source of truth
for all platforms:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

Scope note: this research is limited to the platforms already supported by this
repository: `gemini`, `claude`, `codex`, and `opencode`.

## Current Repo State

Supported platform ids are defined in `src/interfaces.ts` and registered in
`src/platforms/index.ts`.

The workspace configure CLI now supports both persistent and session scopes:

```bash
nams-hooks workspaces configure <gemini|claude|codex|opencode> --scope <project|user> [--workspace WORKSPACE_NAME_OR_ID]
nams-hooks workspaces configure <gemini|claude|codex|opencode> --scope session --session-id ID [--workspace WORKSPACE_NAME_OR_ID]
```

`src/cli.ts` rejects the legacy `--workspace-id` flag before dispatch. The
selector flag is now `--workspace`, and it accepts either an exact workspace ID
or an exact unambiguous workspace name. If `--workspace` is omitted and NAMS
returns exactly one valid workspace, the command auto-selects that workspace.
If multiple valid workspaces are returned, the command requires explicit
selection.

Persistent `project` and `user` scopes still write JSON config. Session scope
validates the requested workspace with `NamsWorkspaceClient`, then writes the
selected workspace into the existing session state file for the supplied
`--session-id`. If the session state file already exists, the command preserves
the other session fields and replaces only `state.workspace`.

The session state type now allows workspace sources:

- `config`
- `runtime-single-workspace`
- `install-selection`
- `session-selection`

Runtime memory resolution gives `session-selection` precedence over configured
`workspaceId`, including `NAMS_WORKSPACE_ID`. Other session workspace sources
still sit after configured workspace ID. This makes `/nams:workspace use`
semantics session-local without mutating project or user config.

Session scope includes filesystem preflights before listing workspaces:

- `--session-id` is required before any NAMS request is made.
- Existing state directories must not contain symlinks.
- Existing matching session state files must be regular files without hard
  links.
- Project config path safety is checked before loading connection config.

## Platform Matrix

| Platform | Shared session command implemented? | User-invoked command can run shell? | Current-session id available? | Fit | Notes |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Yes | Yes | Yes | Best | Project-template commands are slash-invocable as `/nams:workspace`; marketplace plugin commands are slash-invocable as `/nams-hooks:nams:workspace`. `UserPromptExpansion` hooks can intercept the command before Claude sees it and receive `session_id` plus raw `command_args`. |
| OpenCode | Yes | Yes | Yes | Shell fallback | OpenCode markdown command files are prompt templates. The plugin shim can observe `command.execute.before`, but OpenCode ignores hook return values and then unconditionally prompts the model, so nams-hooks must not package `.opencode/commands/nams:workspace.md` until OpenCode exposes a non-prompt command surface. |
| Gemini CLI | Yes | Yes | Yes, through bridge | Implemented with bridge | The extension custom command `/nams:workspace use <workspace-id-or-name>` resolves the recent active Gemini session through the active-session bridge recorded at session start and refreshed by ambiguity hooks; the explicit configure command remains the shell fallback. |
| Codex | Yes | Skill-mediated | Bridge when available | Explicit skill | The explicit skill `$nams:workspace use <workspace-id-or-name>` resolves through the active-session bridge where available; the explicit configure command remains the shell fallback. |

## Platform Notes

### Claude Code

Claude Code is a strong fit for this feature. Both the project template and
plugin expose the direct command:

```text
/nams:workspace use <workspace-id-or-name>
```

Claude skills can be invoked directly with slash command names, for example
`/deploy-staging`, and legacy `.claude/commands/*.md` files work similarly.
Skills support arguments, including `$ARGUMENTS`, positional variables, and
named arguments. They also support `${CLAUDE_SESSION_ID}`, documented as the
current session ID for logging, session-specific files, and correlation.

Claude skill content can include dynamic shell context using inline shell
snippets such as `` !`git diff HEAD` ``, but `$ARGUMENTS` is the raw
user-typed argument string and must not be interpolated into a shell command.
The plugin should instead ship a static command asset and handle the actual
workspace selection through the shared CLI workspace runner. The
`UserPromptExpansion` hook receives JSON on stdin with `session_id`,
`command_name`, `command_args`, `command_source`, and `prompt`, then can block
the slash expansion with a user-facing JSON response.

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/cli.js workspaces run claude --event UserPromptExpansion
```

The workspace runner reads the hook JSON from stdin, parses `use <selector>`
from `command_args`, requires a nonblank `session_id`, and delegates to the
existing session-scoped configure runtime. The exact argument parsing avoids
treating the word `use` as part of the workspace name.

### OpenCode

OpenCode is not currently a safe slash-command fit for this side-effect-only
workflow. OpenCode markdown command files are prompt templates: their content is
sent to the model when the command is executed. Packaging
`.opencode/commands/nams:workspace.md` therefore configures the workspace through
the plugin and then still sends the command template as a second prompt.
nams-hooks must not package `.opencode/commands/nams:workspace.md` until
OpenCode exposes a documented non-prompt command path.

OpenCode custom commands support arguments and shell output injection with
inline shell snippets such as `` !`npm test` ``. OpenCode plugins can run
commands through Bun's shell API and subscribe to events. The NAMS OpenCode shim
already runs `nams-hooks` from plugin hooks.

OpenCode source defines a `command.executed` event with `name`, `sessionID`,
`arguments`, and `messageID`. Source also shows a pre-prompt plugin trigger:

```ts
plugin.trigger(
  "command.execute.before",
  { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
  { parts },
)
```

That trigger receives mutable prompt `parts`, but OpenCode ignores the plugin
hook return value and then unconditionally calls its prompt path. The prompt
input type supports `noReply`, but the command execution path does not pass a
mutable `noReply` output to plugins. Returning `{ stop: true }` or throwing from
the hook is therefore not a documented command-consume mechanism.

The OpenCode shim keeps the workspace runner code path for future command API
support. If OpenCode later exposes a non-prompt command handler, the shim can
call:

```bash
nams-hooks workspaces run opencode --event CommandExecuteBefore
```

with the raw command event payload on stdin. Until then, OpenCode users should
use the explicit configure command from the hook notice:

```bash
nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

### Gemini CLI

Gemini CLI exposes workspace selection through the extension custom command:

```text
/nams:workspace use <workspace-id-or-name>
```

Gemini custom commands are TOML files under user, project, or extension command
directories. The NAMS extension packages the command and resolves the recent
active Gemini session through the active-session bridge recorded at Gemini
session start and refreshed when the workspace ambiguity hook fires. The
hook-side bridge uses the session context Gemini exposes during hook execution,
including `GEMINI_SESSION_ID`, and lets the user-facing custom command configure
the same session without asking users to copy the session ID manually. Because
Gemini injects custom-command shell output back into the model prompt, the
packaged command emits a concise command-result prompt and the memory hook skips
that prompt as command plumbing.

If the active session is missing or ambiguous, the notice keeps the explicit
configure fallback:

```bash
nams-hooks workspaces configure gemini --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

### Codex

Codex exposes workspace selection as an explicit skill invocation:

```text
$nams:workspace use <workspace-id-or-name>
```

The explicit skill asks Codex to run the bundled workspace command against the
current active NAMS session. This keeps the NAMS namespace visible to users
without presenting it as a Codex slash command.

If the active NAMS session cannot be resolved, the notice keeps the explicit
configure fallback:

```bash
nams-hooks workspaces configure codex --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

## Implemented Command Behavior

The shared command is implemented for all registered platforms:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> [--workspace <workspace-id-or-name>]
```

Behavior:

- Resolves existing session state by platform and `--session-id`.
- Creates an initial session state if no matching state file exists.
- Validates workspace selection through `NamsWorkspaceClient`.
- Selects by exact workspace ID first, then exact workspace name.
- Rejects ambiguous workspace names.
- Auto-selects a single returned workspace when `--workspace` is omitted.
- Writes `state.workspace = { id, source: "session-selection", selectedAt }`.
- Preserves existing session fields when replacing only the workspace.
- Does not write project or user config for `--scope session`.
- Does not send an `X-Workspace-Id` header when listing workspaces.
- Does not print API keys or backend error details.

## Remaining UX Work

Claude Code project-template and plugin installs expose the direct command:

```text
/nams:workspace use <workspace-id-or-name>
```

OpenCode remains on the explicit configure command until OpenCode exposes a
non-prompt command handler or a documented command-consume mechanism.

Gemini CLI uses the same slash command through the extension custom-command
surface. The command resolves the current session through the active-session
bridge recorded at Gemini session start and refreshed when the workspace
ambiguity hook fires:

```text
/nams:workspace use <workspace-id-or-name>
```

Codex exposes the namespace as an explicit skill invocation:

```text
$nams:workspace use <workspace-id-or-name>
```

The explicit configure command remains documented for all platforms, scripts,
and troubleshooting:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

The runtime notices emitted by adapters with a direct command surface point
users at the platform command and keep the session configure fallback. OpenCode
notices keep only the explicit shell fallback. When the adapter can parse the
current session ID, the fallback includes the concrete session ID. Otherwise it
keeps the `<session-id>` placeholder.

## Sources

- Repository platform ids: `src/interfaces.ts`
- Repository platform registry: `src/platforms/index.ts`
- Current workspace configure parser and `--scope session` routing: `src/cli.ts`
- Shared workspace configuration implementation: `src/runtime/workspace-configuration.ts`
- Runtime workspace resolution from session state: `src/runtime/workspace-resolution.ts`
- Session state workspace source type: `src/runtime/session-state.ts`
- Workspace-selection notice formatting: `src/platforms/workspace-selection.ts`
- Current OpenCode plugin shim: `templates/opencode/.opencode/plugins/nams-hooks.js`
- Existing workspace resolution design note: `docs/superpowers/specs/2026-06-08-nams-key-scope-workspace-resolution-design.md`
- Claude Code skills: <https://code.claude.com/docs/en/skills>
- Claude Code hooks: <https://code.claude.com/docs/en/hooks>
- OpenCode commands: <https://opencode.ai/docs/commands/>
- OpenCode plugins: <https://opencode.ai/docs/plugins/>
- OpenCode source, command events: <https://github.com/anomalyco/opencode/blob/eb70b6137b1a9a02ccf9e53c7e20c7a7e714f478/packages/opencode/src/command/index.ts>
- OpenCode source, command pre-hook trigger: <https://github.com/anomalyco/opencode/blob/eb70b6137b1a9a02ccf9e53c7e20c7a7e714f478/packages/opencode/src/session/prompt.ts>
- Gemini CLI custom commands: <https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/custom-commands.md>
- Gemini CLI hooks: <https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/index.md>
- Gemini CLI extensions: <https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md>
- Gemini CLI shell execution source: <https://github.com/google-gemini/gemini-cli/blob/5d4af9f812bb08750e5a14ee66dd4c1f7a90b13c/packages/core/src/services/shellExecutionService.ts>
- Codex skills: <https://developers.openai.com/codex/skills>
- Codex custom prompts: <https://developers.openai.com/codex/custom-prompts>
- Codex hooks: <https://developers.openai.com/codex/hooks>
