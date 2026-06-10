# Session Workspace Command Support Research

Research date: 2026-06-11

This note tracks which currently supported `nams-hooks` platforms expose a
user-invoked command surface that could support session-scoped workspace
selection, for example:

```text
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

The current workspace configure CLI only supports persistent scopes:

```bash
nams-hooks workspaces configure <gemini|claude|codex|opencode> --scope <project|user> [--workspace-id ID]
```

`src/cli.ts` parses only `project` and `user` for this command today. The shared
workspace configuration path writes JSON config, not session state.

Runtime memory resolution already has the useful session-state hook point: after
configured `workspaceId` is checked, `resolveWorkspaceForMemory()` accepts
`state.workspace` before listing workspaces. That makes a `--scope session`
implementation mostly a matter of validating the requested workspace and writing
the selected workspace into the existing session state file.

The session state type currently allows workspace sources:

- `config`
- `runtime-single-workspace`
- `install-selection`

A session command should add a new source such as `session-selection`.

## Platform Matrix

| Platform | User-invoked command can run shell? | Current-session id available? | Fit | Notes |
| --- | --- | --- | --- | --- |
| Claude Code | Yes | Yes | Best | Skills/custom commands are slash-invocable, support arguments, can substitute `${CLAUDE_SESSION_ID}`, and support dynamic shell execution before Claude sees the skill content. |
| OpenCode | Yes | Yes | Best with plugin shim | Custom commands support shell output. Plugins can intercept command execution, and OpenCode source shows `command.execute.before` receives `command`, `sessionID`, and `arguments`. |
| Gemini CLI | Yes | Partial | Good with bridge | Custom commands support shell injection, and hooks expose `GEMINI_SESSION_ID`. The custom-command shell execution path appears to set only the general `GEMINI_CLI=1` identity variable, so a session-id bridge is needed. |
| Codex | Partial | Partial | Not recommended for this UX | Codex hooks run shell commands and custom prompts can be slash-invoked, but custom prompts expand into model instructions rather than deterministic pre-shell command execution. Skills are reusable workflows, not a direct slash-to-shell contract. |

## Platform Notes

### Claude Code

Claude Code is the cleanest fit for this feature.

Claude skills can be invoked directly with slash command names, for example
`/deploy-staging`, and legacy `.claude/commands/*.md` files work similarly.
Skills support arguments, including `$ARGUMENTS`, positional variables, and
named arguments. They also support `${CLAUDE_SESSION_ID}`, documented as the
current session ID for logging, session-specific files, and correlation.

Claude skill content can include dynamic shell context using inline shell
snippets such as `` !`git diff HEAD` ``. For a session workspace selector, the
skill could be explicitly user-invoked and disabled for model invocation, then
run:

```markdown
---
name: nams-hooks
description: Select the NAMS workspace for this Claude Code session.
argument-hint: workspaces use <workspace-id-or-name>
disable-model-invocation: true
allowed-tools: Bash(nams-hooks workspaces configure claude *)
---

!`nams-hooks workspaces configure claude --scope session --session-id ${CLAUDE_SESSION_ID} --workspace "$ARGUMENTS"`
```

The exact argument parsing should avoid treating the words `workspaces use` as
part of the workspace name, but the platform surface itself is sufficient.

### OpenCode

OpenCode is also a strong fit, but the best implementation is probably in the
existing OpenCode plugin shim instead of a plain Markdown command.

OpenCode custom commands support arguments and shell output injection with
inline shell snippets such as `` !`npm test` ``. OpenCode plugins can run
commands through Bun's shell API and subscribe to events. The current NAMS
OpenCode shim already runs `nams-hooks` from plugin hooks.

OpenCode source defines a `command.executed` event with `name`, `sessionID`,
`arguments`, and `messageID`. Source also shows a pre-prompt plugin trigger:

```ts
plugin.trigger(
  "command.execute.before",
  { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
  { parts },
)
```

That is the ideal place to intercept a command like:

```text
/nams-hooks workspaces use <workspace-id-or-name>
```

The plugin can call:

```bash
nams-hooks workspaces configure opencode --scope session --session-id <sessionID> --workspace <workspace-id-or-name>
```

and replace or annotate the command output without starting a normal model turn.

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

Codex is the weakest fit for the exact slash-command-to-shell UX.

Codex has lifecycle hooks that run command handlers. It also has custom prompts,
but they are deprecated and expand into model instructions; they do not provide
the same documented pre-prompt shell injection contract as Claude skills or
Gemini/OpenCode custom commands. Codex skills are reusable workflows and can
include scripts as resources, but invocation means Codex follows instructions,
not that Codex deterministically runs a declared shell snippet before the turn.

For Codex, the safer current recommendation is:

- keep project/user workspace configuration as the user-facing path;
- optionally provide a prompt-only helper skill that instructs Codex to run the
  configure command through its normal command tool;
- avoid promising deterministic session-scoped workspace switching until Codex
  exposes a direct user command handler or a documented session-id substitution
  for user-invoked commands.

## Recommended Implementation Order

1. Add shared CLI/runtime support for:

   ```bash
   nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
   ```

2. Implement session state writing:

   - resolve the existing session state by platform and `--session-id`;
   - validate the requested workspace through `NamsWorkspaceClient`;
   - support workspace lookup by id and, if unambiguous, by name;
   - write `state.workspace = { id, source: "session-selection", selectedAt }`;
   - never print API keys or full config.

3. Add Claude Code UX first.

4. Add OpenCode UX through the plugin shim, likely using
   `command.execute.before`.

5. Add Gemini UX only after deciding how to bridge `GEMINI_SESSION_ID` into the
   custom command path.

6. Leave Codex as project/user config plus possible prompt-helper UX for now.

## Sources

- Repository platform ids: `src/interfaces.ts`
- Repository platform registry: `src/platforms/index.ts`
- Current workspace configure parser: `src/cli.ts`
- Shared workspace configuration implementation: `src/runtime/workspace-configuration.ts`
- Runtime workspace resolution from session state: `src/runtime/workspace-resolution.ts`
- Session state workspace source type: `src/runtime/session-state.ts`
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
