# NAMS Workspace Resolution Hook Design

Date: 2026-06-05
Status: Approved design
Repository: nams-hooks

## Summary

`nams-hooks` should use the new NAMS workspace listing endpoint to reduce required install-time configuration where a harness can safely resolve workspace choice before memory persistence starts.

The workspace concern should be separated from NAMS memory management. A new workspace hook command owns workspace discovery, single-workspace auto-selection, and future workspace selection commands. Existing memory hooks continue to own conversation creation, recall, message persistence, and tool metadata. Memory hooks consume an effective workspace ID; they do not negotiate workspace selection.

2026-06-08 amendment: NAMS now has workspace keys and admin keys. Both can call
`GET /v1/users/me/workspaces`; workspace keys always return one workspace and
admin keys may return multiple workspaces. `nams-hooks` intentionally does not
model key type. It infers behavior only from the count of valid workspace IDs
returned by the workspace list endpoint. See
`docs/superpowers/specs/2026-06-08-nams-key-scope-workspace-resolution-design.md`.

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
- Claude plugin docs: `https://code.claude.com/docs/en/plugins-reference`
- Codex hooks docs: `https://developers.openai.com/codex/hooks`
- Codex plugin docs: `https://developers.openai.com/codex/plugins`
- Codex plugin build docs: `https://developers.openai.com/codex/plugins/build`
- Gemini hooks docs: `https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md`
- Gemini extension docs: `https://google-gemini.github.io/gemini-cli/docs/extensions/`
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
| Gemini | Deterministic when hook group uses `sequential: true` | Single-workspace runtime resolution is safe; multi-workspace selection is non-blocking and skips memory | Separate workspace command before memory command in one sequential hook group | Optional for this verified runtime path; still allowed as an explicit override |
| OpenCode | Plugin hooks are documented as running in sequence, but source load order is broader than NAMS | Single-workspace runtime resolution is safe; multi-workspace selection is non-blocking and skips memory | Workspace phase runs before memory phase inside the NAMS OpenCode plugin shim | Optional for single-workspace auto-resolution; explicit configuration required for multi-workspace users |
| Claude | Matching hooks can run in parallel; a blocking result does not prevent sibling hooks from starting | `UserPromptSubmit` can block, but not deterministically before memory side effects | No separate runtime sibling hook; use install-time or config-time selection | Required |
| Codex | Multiple matching command hooks for the same event are launched concurrently | `UserPromptSubmit` can block, but not deterministically before memory side effects | No separate runtime sibling hook; use install-time or config-time selection | Required |

The table intentionally distinguishes "can block" from "can order side effects." Blocking is not enough when a sibling memory hook can still start and create a conversation.

> 2026-06-09 amendment: Claude and Codex still must not use sibling first-prompt
> workspace hooks, but their memory adapters can now perform inline
> single-workspace auto-resolution before creating a conversation. This
> preserves deterministic side effects while supporting workspace keys that
> return exactly one workspace.

## Command Model

Add a new workspace-oriented command surface:

```bash
nams-hooks workspaces gemini --event BeforeAgent
nams-hooks workspaces codex --event InstallConfigure
```

This command is a hook command, not an agent-facing slash command. It should follow the same gateway principles as `nams-hooks run`:

- Parse the explicit platform argument.
- Parse the typed `--event`.
- Read stdin JSON as an opaque object.
- Dispatch through static platform/workspace behavior.
- Do not infer event names from raw payload fields.

`BeforeAgent` is the first required runtime event because workspace resolution must happen before conversation creation. `InstallConfigure` is a NAMS lifecycle event, not necessarily a native harness hook event. It gives the workspace adapter a common entrypoint for install-time or config-time workspace selection while still allowing each platform adapter to use platform-specific install, enable, setup, config, or first-run mechanics.

A human-facing configure wrapper may dispatch `InstallConfigure`:

```bash
nams-hooks workspaces configure codex --scope project
nams-hooks workspaces configure gemini --scope user
```

Future command work, such as `/nams:workspaces use <uuid>`, should add a separate explicit CLI surface rather than overloading the memory command.

## Adapter Boundaries

The existing generic `PlatformAdapter` concept should become explicit memory terminology during implementation:

```ts
interface MemoryPlatformAdapter {
  startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult>;
  beforeAgent?(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult>;
  afterAgent?(invocation: HookInvocation<"AfterAgent">): Promise<HookResult>;
  afterTool?(invocation: HookInvocation<"AfterTool">): Promise<HookResult>;
}
```

`MemoryPlatformAdapter` owns agent-memory behavior only: session initialization, conversation creation, recall, message persistence, and tool metadata. It is the adapter behind `nams-hooks run gemini --event BeforeAgent` and the other memory hook events.

Workspace behavior is a separate adapter concept:

```ts
interface WorkspacePlatformAdapter {
  beforeAgent?(invocation: WorkspaceHookInvocation<"BeforeAgent">): Promise<HookResult>;
  installConfigure?(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<HookResult>;
}
```

`WorkspacePlatformAdapter` owns workspace discovery, auto-selection, blocking setup output, and config-time selection. It is the adapter behind commands such as `nams-hooks workspaces gemini --event BeforeAgent`. Keeping these contracts separate avoids coupling future NAMS workspace infrastructure to the agent-memory implementation, which may later move toward a more generic Neo4j memory library.

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

The workspace command must finish before the memory command starts. If the workspace command cannot choose a workspace because multiple valid workspaces are available, it should return non-blocking context and let the memory command skip memory without creating a conversation.

For multi-workspace users, the workspace hook should prefer Gemini's structured hook output over stderr-only messages:

```json
{
  "continue": true,
  "suppressOutput": false,
  "hookSpecificOutput": {
    "additionalContext": "NAMS memory is inactive for this turn.\nNo memory messages were stored. Multiple NAMS workspaces are available, and no workspaceId is configured.\nConfigure an explicit workspace before memory can resume: nams-hooks workspaces configure gemini --scope project --workspace-id <workspace-id>\nAvailable NAMS workspaces:\n1. Engineering (owner, active) - 11111111-1111-1111-1111-111111111111\n2. Research (member, active) - 22222222-2222-2222-2222-222222222222"
  }
}
```

The command should exit `0` and print only JSON to stdout. This keeps agent execution non-blocking while making the memory skip explicit.

### OpenCode

OpenCode uses a JavaScript plugin shim rather than command hooks JSON. The NAMS plugin should keep ordering explicit inside the shim:

1. Invoke the workspace command or shared workspace module.
2. If workspace resolution allows memory to continue, invoke the memory command.
3. If workspace resolution blocks, returns a user-visible prompt, or fails closed for configuration, do not invoke memory persistence for that turn.

OpenCode docs say plugins are loaded from all sources and all hooks run in sequence. Even so, the safest NAMS-owned behavior is to keep the workspace and memory phases in the same plugin shim so ordering does not depend on other user plugins or source load order.

The OpenCode plugin API exposes TUI events such as `tui.prompt.append`, `tui.command.execute`, and `tui.toast.show`, and an `installation.updated` event. The reviewed docs do not describe a hook result that blocks the first user message while presenting a selectable list. Therefore OpenCode runtime behavior should remain conservative: auto-resolve exactly one workspace before memory, but treat multiple workspaces as a configuration-required state until an actual blocking selection path is verified in the harness.

### Claude And Codex

Claude and Codex should not use sibling workspace and memory hooks for the same first-prompt event. Both can surface blocking behavior, but both may launch matching hook commands in parallel. A block from the workspace hook could win the final harness decision while the memory hook has already created a conversation. That violates the deterministic-write model.

For these harnesses, workspace selection belongs in install-time or config-time setup for this design.

## Workspace Resolution Flow

The workspace hook resolves an effective workspace ID before memory work:

1. Load config values that do not require `workspaceId`: `apiKey` and optional `baseUrl`.
2. If `workspaceId` is already configured through JSON, platform config, or environment, record the effective source and allow memory to proceed.
3. If `workspaceId` is missing, call `GET /v1/users/me/workspaces` with bearer auth and no `X-Workspace-Id` header.
4. If exactly one valid workspace is returned, store that workspace ID in local state and allow memory to proceed. This covers workspace keys and admin keys that can see one workspace.
5. If multiple valid workspaces are returned, require explicit workspace selection/configuration. This commonly covers admin keys with access to multiple workspaces.
6. If runtime interaction is supported for the harness, stop or block the first prompt with a user-visible list of workspace names, roles, statuses, and IDs.
7. If runtime interaction is not supported, report a sanitized diagnostic and require install-time or config-time workspace selection.
8. If zero valid workspaces are returned, report a sanitized diagnostic and skip NAMS memory work.
9. If the workspace listing request fails, fail open for the agent harness and skip NAMS memory work for that turn.

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

Generated client output should expose two client classes. They may be emitted from the same generated TypeScript source file for now, but their runtime responsibilities, endpoint tables, and tests should remain distinct:

- `NamsClient`, for workspace-scoped agent-memory operations such as conversations, messages, reasoning steps, tool calls, and entity search. It keeps requiring an effective `workspaceId` and sends `X-Workspace-Id` as today.
- `NamsWorkspaceClient`, for NAMS infrastructure workspace operations. In this design it exposes only `listMyWorkspaces` for `GET /v1/users/me/workspaces`. It sends bearer auth and does not send `X-Workspace-Id`.

Keeping two classes preserves the current memory-client invariant: code that can construct `NamsClient` has already resolved the workspace.

The OpenAPI operations currently known to not require `X-Workspace-Id` are:

- `GET /v1/users/me/workspaces`, used by this design to list workspaces for the authenticated user.
- `POST /v1/workspaces`, which also does not require `X-Workspace-Id` but is out of scope for this change.

The generator should therefore maintain an explicit workspace-infrastructure endpoint allowlist. New infrastructure operations can be added later only when intentionally designed; they should not leak into `NamsClient`, and memory operations should not leak into `NamsWorkspaceClient`.

The generator must validate `GET /v1/users/me/workspaces` against `docs/nams-openapi.json` at build time and generate static TypeScript types for:

- `WorkspaceListResponse`
- `WorkspaceSummary`

Runtime code must not inspect OpenAPI or discover endpoints.

## Install-Time Selection And Setup Lifecycle

Harnesses that cannot guarantee ordered hook execution should resolve workspace ID before hooks run. This setup flow can be implemented as a future installer or configure command, but the required behavior is:

1. Ensure an API key is available.
2. Call `GET /v1/users/me/workspaces`.
3. If one workspace exists, write it automatically to the selected config target.
4. If multiple workspaces exist, show numbered choices and write the selected workspace ID.
5. If workspace listing fails, leave `workspaceId` unset and show a sanitized setup error.

The design should model setup as a generic NAMS workspace lifecycle event with platform-specific implementations:

```ts
type WorkspaceHookEvent = "BeforeAgent" | "InstallConfigure";

interface WorkspacePlatformAdapter {
  beforeAgent?(invocation: WorkspaceHookInvocation<"BeforeAgent">): Promise<HookResult>;
  installConfigure?(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<HookResult>;
}
```

This keeps workspace selection inside the workspace concern without pretending all harnesses expose the same installation primitive. `InstallConfigure` can be triggered by a NAMS installer, a command such as `nams-hooks workspaces configure codex --scope project`, a platform setup hook, a plugin-enable prompt, or a platform-specific first-run event. Each platform adapter owns how that lifecycle maps to the harness. The generic contract is only the outcome: choose zero or one effective workspace ID, persist it to a runtime-readable config target when the setup path calls for durable config, and never create memory conversations during setup.

Platform installation research:

- Gemini extensions support static extension settings that are collected during installation or later with `gemini extensions config`. Settings declare environment variable names, can be marked sensitive, and are allowlisted into the extension environment. Gemini also supports hooks from `hooks/hooks.json`. The documented settings prompt is static, so it can ask for `NAMS_WORKSPACE_ID`, but it cannot itself call NAMS to populate choices. Gemini's platform strategy should use runtime `BeforeAgent` auto-resolution for single-workspace users and optionally use `InstallConfigure` from a wrapper/config command to write extension settings or `.nams/config.json` for multi-workspace users.
- Claude plugins support manifest `userConfig` values prompted when the plugin is enabled. These values are available as `${user_config.KEY}` substitutions and as `CLAUDE_PLUGIN_OPTION_<KEY>` environment variables. Claude plugins can also ship hooks, including `Setup`; however, `Setup` fires only for explicit `--init-only`, `--init` in print mode, or `--maintenance` in print mode, cannot block, and does not run on normal startup. Claude's platform strategy should treat `userConfig` as the native manual workspace ID surface and may use `InstallConfigure` through a NAMS setup command or explicitly triggered setup flow, but should not rely on a sibling first-prompt runtime workspace hook.
- Codex plugins can be installed from marketplaces, can declare install/authentication policy, can bundle lifecycle hooks, and can use plugin data directories. Codex may prompt for external app or MCP authentication during install or first use, but the docs do not expose a plugin-provided arbitrary install script or dynamic config form for a NAMS workspace picker. Plugin-bundled hooks are non-managed hooks that require user trust and, for matching command hooks on the same event, are launched concurrently with other matching hooks. Codex's platform strategy should avoid sibling first-prompt workspace hooks, but the memory adapter may perform inline single-workspace auto-resolution before creating a conversation.
- OpenCode loads local plugins directly and installs npm plugin packages with Bun at startup. Plugin hooks run in documented source order, and plugins can subscribe to `installation.updated`, TUI, shell, tool, message, and session events. The docs do not describe a blocking install-time configuration prompt or a first-message selection UI for this use case. OpenCode's platform strategy can use ordered in-plugin runtime phases for single-workspace auto-resolution, and may later map `InstallConfigure` to `installation.updated`, `tui.prompt.append`, or another verified OpenCode flow if it can block or clearly guide the user before memory starts.

Claude and Codex plugin metadata should not add sibling first-prompt workspace hooks. Their memory adapters can still make workspace ID optional for single-workspace accounts by resolving inline before memory side effects. Gemini can mark workspace ID optional only when the sequential workspace hook is shipped and verified. OpenCode optionality is limited to the verified single-workspace auto-resolution path shipped with the runtime.

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

- Memory-client tests stay in the existing agent-memory generated client suite and cover `NamsClient` plus `NAMS_CLIENT_ENDPOINTS`.
- Workspace-client tests live in a separate generated workspace client suite and cover `NamsWorkspaceClient` plus `NAMS_WORKSPACE_CLIENT_ENDPOINTS`.
- `listMyWorkspaces` calls `GET /v1/users/me/workspaces`.
- `listMyWorkspaces` sends `Authorization` and `Accept`.
- `listMyWorkspaces` does not send `X-Workspace-Id`.
- Request logs for `listMyWorkspaces` omit `Authorization`.
- Endpoint metadata generated from the pinned OpenAPI spec includes the workspace listing endpoint.
- The workspace endpoint table contains only the intentional workspace-infrastructure allowlist for this change: `GET /v1/users/me/workspaces`.

Required runtime tests:

- `InstallConfigure` dispatches through the workspace platform adapter without creating a memory service.
- Configured workspace skips workspace listing.
- Missing workspace with a single returned workspace stores session workspace and allows memory to proceed.
- Missing workspace with multiple returned workspaces returns the correct platform-specific non-blocking notification output.
- Missing workspace with zero returned workspaces skips memory.
- Workspace listing failure skips memory and logs a sanitized diagnostic.
- Memory service is not created before workspace resolution succeeds.
- Explicit config overrides session-resolved workspace.

Required platform tests:

- Gemini template uses a `sequential: true` `BeforeAgent` group with workspace command before memory command.
- Gemini can auto-resolve a single workspace and then create a conversation with `X-Workspace-Id`.
- Gemini multi-workspace handling returns non-blocking selection-required context before the memory command skips conversation creation.
- Claude plugin metadata marks `NAMS_WORKSPACE_ID` optional for single-workspace runtime auto-resolution.
- Codex docs describe single-workspace runtime auto-resolution and explicit configuration for multi-workspace users.
- OpenCode plugin shim performs workspace phase before memory phase for first user message.
- OpenCode multi-workspace handling skips memory and reports configuration required.

Required docs tests or checks:

- `README.md` explains that workspace ID may be optional only on supported harness paths.
- `INSTALL.md` documents install-time workspace selection for Claude and Codex.
- `INSTALL.md` documents runtime auto-resolution for Gemini and any verified OpenCode path.
- `INSTALL.md` documents the platform-specific setup strategy for Gemini settings, Claude `userConfig`, Codex configure flow, and OpenCode single-workspace runtime setup.

## Resolved Review Questions

- All platforms should treat multi-workspace resolution as non-blocking: notify that memory is inactive, skip memory writes for the turn, and require explicit configuration before memory can resume.
- OpenCode does not yet have a verified picker API for this use case. Keep multi-workspace OpenCode users on install-time or config-time selection until a concrete prompt mechanism is tested.
- There is no single portable platform install script hook across Gemini, Claude, Codex, and OpenCode. That is not a design blocker. NAMS should expose a generic `InstallConfigure` workspace lifecycle event and let the platform strategy map it to each harness: Gemini static settings or wrapper configure command, Claude `userConfig` or explicit setup/configure command, Codex NAMS-controlled configure flow, and OpenCode single-workspace runtime resolution plus explicit configuration for multi-workspace users.

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
