# Session Workspace Command Support Research

Research date: 2026-06-11

Updated against local `devel` after the shared session-scope configure command
landed.

This note tracks the implemented session-scoped workspace configure command and
which currently supported `nams-hooks` platforms expose a user-invoked command
surface that can wrap it. Tier 1 user-facing forms are:

```text
# Claude Code project template command
/nams-hooks workspaces use <workspace-id-or-name>

# Claude Code plugin command
/nams-hooks:nams-hooks workspaces use <workspace-id-or-name>

# OpenCode plugin shim command
/nams-hooks workspaces use <workspace-id-or-name>
```

implemented as a deterministic local command:

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
still sit after configured workspace ID. This makes `/nams-hooks workspaces use`
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
| Claude Code | Yes | Yes | Yes | Best | Plugin skills/custom commands are slash-invocable under the plugin namespace. `UserPromptExpansion` hooks can intercept the command before Claude sees it and receive `session_id` plus raw `command_args`. |
| OpenCode | Yes | Yes | Yes | Best with plugin shim | The plugin shim intercepts `command.execute.before`, preserves `/nams-hooks workspaces use <workspace-id-or-name>`, and runs the shared configure command. |
| Gemini CLI | Yes | Yes | Partial | Good with bridge | Custom commands support shell injection, and hooks expose `GEMINI_SESSION_ID`. The custom-command shell execution path appears to set only the general `GEMINI_CLI=1` identity variable, so a session-id bridge is still needed for slash-command UX. |
| Codex | Yes | Partial | Payload-dependent | Prompt-helper only | Codex hooks run shell commands and workspace notices now include parsed session IDs when available. Custom prompts expand into model instructions rather than deterministic pre-shell command execution. |

## Platform Notes

### Claude Code

Claude Code is a strong fit for this feature. The project template exposes the
direct command:

```text
/nams-hooks workspaces use <workspace-id-or-name>
```

The Claude plugin has one important packaging constraint: plugin commands are
namespaced by plugin name. The Claude plugin therefore exposes the command as:

```text
/nams-hooks:nams-hooks workspaces use <workspace-id-or-name>
```

Claude skills can be invoked directly with slash command names, for example
`/deploy-staging`, and legacy `.claude/commands/*.md` files work similarly.
Skills support arguments, including `$ARGUMENTS`, positional variables, and
named arguments. They also support `${CLAUDE_SESSION_ID}`, documented as the
current session ID for logging, session-specific files, and correlation.

Claude skill content can include dynamic shell context using inline shell
snippets such as `` !`git diff HEAD` ``, but `$ARGUMENTS` is the raw
user-typed argument string and must not be interpolated into a shell command.
The plugin should instead ship a static command/skill asset and handle the
actual workspace selection in a `UserPromptExpansion` hook. The hook receives
JSON on stdin with `session_id`, `command_name`, `command_args`,
`command_source`, and `prompt`, then can block the slash expansion with a
user-facing JSON response.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace-use.mjs
```

The helper should read the hook JSON from stdin, parse
`workspaces use <selector>` from `command_args`, require a nonblank `session_id`
or safe `${CLAUDE_SESSION_ID}` fallback, and spawn the bundled `bin/cli.js` with
an argv array. The exact argument parsing should avoid treating the words
`workspaces use` as part of the workspace name.

### OpenCode

OpenCode is also a strong fit. Tier 1 support lives in the existing OpenCode
plugin shim instead of a plain Markdown command.

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

The shim intercepts this command:

```text
/nams-hooks workspaces use <workspace-id-or-name>
```

The plugin calls:

```bash
nams-hooks workspaces configure opencode --scope session --session-id <sessionID> --workspace <workspace-id-or-name>
```

and reports the result without starting a normal model turn.

### Gemini CLI

Gemini CLI is close, but not quite direct.

Gemini custom commands are TOML files under user, project, or extension command
directories. They support `{{args}}`, shell injection with `!{...}`, and command
packaging through extensions. Gemini hooks also expose `GEMINI_SESSION_ID` in
the hook environment, along with `GEMINI_PROJECT_DIR`, `GEMINI_PLANS_DIR`, and
`GEMINI_CWD`.

The caveat is that the documented session id belongs to hook execution. The
custom-command shell execution path appears to use the general shell execution
service, which sets `GEMINI_CLI=1` but does not clearly set
`GEMINI_SESSION_ID`. That means the slash command can run shell, but cannot be
assumed to know the current session id directly.

Good options:

1. Add a Gemini hook that records `GEMINI_SESSION_ID` into NAMS session state or
   a small local bridge file, then let the custom command call `nams-hooks`
   without passing `--session-id`.
2. Add a dedicated `nams-hooks workspaces use` mode that resolves the current
   Gemini session from existing NAMS state when run inside Gemini.
3. Keep Gemini on the current runtime auto-selection and project/user configure
   flow until a clean command-session bridge is implemented.

### Codex

Codex is the weakest fit for the exact slash-command-to-shell UX, even though
the shared `nams-hooks workspaces configure codex --scope session ...` command
itself is now implemented.

Codex has lifecycle hooks that run command handlers. It also has custom prompts,
but they are deprecated and expand into model instructions; they do not provide
the same documented pre-prompt shell injection contract as Claude skills or
Gemini/OpenCode custom commands. Codex skills are reusable workflows and can
include scripts as resources, but invocation means Codex follows instructions,
not that Codex deterministically runs a declared shell snippet before the turn.

For Codex, the safer current UX recommendation is:

- keep project/user workspace configuration as the primary user-facing path;
- use the session configure command manually when the notice includes a parsed
  session id;
- optionally provide a prompt-only helper skill that instructs Codex to run the
  configure command through its normal command tool;
- avoid promising a deterministic custom slash command until Codex exposes a
  direct user command handler or a documented session-id substitution for
  user-invoked commands.

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

After Tier 1, Claude Code project-template installs expose the direct command:

```text
/nams-hooks workspaces use <workspace-id-or-name>
```

Claude Code plugin installs expose the namespaced command:

```text
/nams-hooks:nams-hooks workspaces use <workspace-id-or-name>
```

OpenCode exposes the direct plugin shim command:

```text
/nams-hooks workspaces use <workspace-id-or-name>
```

The explicit configure command remains documented for all platforms, scripts,
and troubleshooting:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

Gemini CLI slash-command support remains designed but deferred until the current
session ID can be resolved deterministically from a custom command. Codex remains
on explicit shell configuration because it does not currently expose a
deterministic `/nams-hooks workspaces use` command path.

The runtime notices emitted by supported adapters now point users at the session
command when multiple NAMS workspaces are available. When the adapter can parse
the harness session id, the notice includes it directly; otherwise it uses the
`<session-id>` placeholder.

## Sources

- Repository platform ids: `src/interfaces.ts`
- Repository platform registry: `src/platforms/index.ts`
- Current workspace configure parser and `--scope session` routing: `src/cli.ts`
- Shared workspace configuration implementation: `src/runtime/workspace-configuration.ts`
- Runtime workspace resolution from session state: `src/runtime/workspace-resolution.ts`
- Session state workspace source type: `src/runtime/session-state.ts`
- Workspace-selection notice formatting: `src/platforms/workspace-selection.ts`
- Current OpenCode plugin shim: `templates/opencode/plugins/nams-hooks.js`
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
