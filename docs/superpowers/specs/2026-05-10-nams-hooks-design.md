# NAMS Hooks Design

Date: 2026-05-10
Status: Approved design
Repository: nams-plugins

## Summary

`nams-hooks` is a standalone Node.js integration layer that connects local agent harness hooks to the Neo4j Agent Memory Service (NAMS) REST API. Its hook runtime and generated release artifacts have zero runtime npm dependencies and use Node.js built-ins only, while the source repository may use dev-only build, generation, and test tooling. The first iteration supports macOS for Codex, Claude Code, Gemini CLI, and OpenCode. Gemini uses extension distribution. Claude Code can use a generated Claude plugin marketplace artifact, with project-level settings as a fallback path. Codex can use a generated repo marketplace plugin artifact, with project-level hooks as a fallback path. OpenCode can use a generated self-contained marketplace artifact, with a `dist-local/` project plugin as a fallback path. Runtime configuration, state, and logs live under user-level `~/.nams/`, with optional project overrides in `.nams/config.json`.

As of the umbrella rename, repository, npm package, and marketplace identity use
`nams-plugins`; the hooks plugin and CLI executable remain `nams-hooks`.

The hook runner owns deterministic memory persistence. Agents receive recalled context, but they are not responsible for deciding whether to write memory. The runner stores conversation messages, recalls relevant memory before agent work, and records limited tool metadata through NAMS REST endpoints.

## Source Inputs

- Behavioral reference: `docs/nams-skill.md`
- Pinned NAMS OpenAPI contract: `docs/nams-openapi.json`
- Claude Code hooks reference: `https://code.claude.com/docs/en/hooks`
- Claude Code plugin marketplace reference: `https://code.claude.com/docs/en/plugin-marketplaces`
- Gemini CLI hooks reference: `https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md`
- Codex hooks behavior note: `https://github.com/openai/codex/issues/16486`
- OpenCode plugin reference: `https://opencode.ai/docs/plugins`

## Goals

- Provide deterministic memory behavior through harness hooks and REST API calls.
- Support Codex, Claude Code, Gemini CLI, and OpenCode memory flows on macOS in v1.
- Keep runtime configuration, state, and logs under user-level `~/.nams/`, while preserving project-scoped harness installation and optional project config overrides.
- Use plain Node.js built-in modules only in runtime code and generated release artifacts. No runtime npm dependencies.
- Allow dev-only dependencies for TypeScript compilation, code generation, architecture checks, and test support when they do not create additional runtime package installation requirements or runtime imports.
- Persist standard user and assistant messages as the primary memory stream.
- Recall memory before agent responses and inject concise context plus a short operating instruction.
- Store tool-call metadata and exposed tool output when the harness provides it cleanly.
- Keep secrets, state, and logs local to the user's machine and out of source-controlled harness configs.

## Non-Goals For v1

- Windows support.
- Global-only harness installation that removes project-level hook setup.
- MCP-driven memory writes.
- Explicit entity creation from hook logic.
- Full raw tool input/output capture.
- Guaranteed assistant response capture for every harness if the harness does not expose it cleanly.

## Approach

Use a single shared Node.js runtime with thin per-harness project hook configurations.

Generated hook configs call the same entry point and declare the hook event explicitly:

```bash
nams-hooks run claude --event SessionStart
nams-hooks run codex --event SessionStart
nams-hooks run gemini --event SessionStart
nams-hooks run opencode --event SessionStart
```

The CLI entry point is a gateway. It parses the platform and typed event from arguments, reads hook JSON from `stdin` as an opaque object, resolves a platform adapter through a static registry, and calls the interface method for that event. The CLI must not interpret platform-specific payload fields such as session IDs, transcript paths, or event-name property variants. Those subtleties belong inside the platform adapter implementations.

This approach avoids per-harness logic drift while still respecting each platform's hook event names and JSON shapes.

## Project Layout

```text
nams-hooks/
  scripts/
    build-dist-common.mjs
    build-dist-npm.mjs
    build-dist-marketplace.mjs
    build-dist-local.mjs
    generate-nams-client.mjs
  src/
    cli.ts
    interfaces.ts
    generated/
      nams-client.ts
    runtime/
      stdin.ts
      logging.ts
    platforms/
      index.ts
      gemini/
      claude/
      codex/
      opencode/
  install.mjs
  templates/
    local/
      claude/
        .claude/
          settings.local.json
      codex/
        .codex/
          hooks.json
      gemini/
        .gemini/
          extensions/
            gemini-nams-hooks/
              gemini-extension.json
              hooks/
                hooks.json
      opencode/
        .opencode/
          plugins/
            nams-hooks.js
    marketplace/
      claude/
        .claude-plugin/
          marketplace.json
        plugins/
          claude-nams-hooks/
            .claude-plugin/
              plugin.json
            hooks/
              hooks.json
      codex/
        .agents/
          plugins/
            marketplace.json
        plugins/
          codex-nams-hooks/
            .codex-plugin/
              plugin.json
            hooks/
              hooks.json
      gemini/
        gemini-extension.json
        hooks/
          hooks.json
    opencode/
      .opencode/
        plugins/
          nams-hooks.js
  docs/
    nams-openapi.json
    nams-skill.md
    superpowers/specs/2026-05-10-nams-hooks-design.md
```

Installed project layout:

```text
target-project/
  .nams/
    config.json        # optional project override
  .claude/settings.local.json
  .codex/hooks.json
  .opencode/plugins/nams-hooks.js
```

User runtime layout:

```text
~/.nams/
  config.json          # default user configuration
  logs/
    gemini/
      session-2026-05-16T12-40-1b11dfee.jsonl
    claude/
    codex/
    opencode/
  state/
    gemini/
      session-<created-at>--<session-hash>.json
    claude/
    codex/
    opencode/
```

Files created or touched by the runtime under `~/.nams/` use owner-only file permissions (`0600`). Runtime directories under `~/.nams/` use owner-only directory permissions (`0700`) so the owner can still traverse them. Project-local NAMS files, including `.nams/config.json`, follow the same `0600` file rule.

Logs are session-scoped only. There is no top-level aggregate `nams-hooks.jsonl`.

Gemini v1 distribution is an extension install rather than a project `.gemini/settings.json` template. Gemini writes hook runtime state and logs into the user-level `~/.nams/` directory while still allowing a project-local `.nams/config.json` override when it runs from a project.

## Build And Distribution

`nams-hooks` is authored in TypeScript and released as plain JavaScript. Runtime code must use Node built-ins only; build-time development tools such as TypeScript, the OpenAPI generator, architecture checks, and test support stay out of the published hook runtime.

Dependency policy:

- `dependencies` should remain empty unless an approved runtime design change explicitly adds one.
- `devDependencies` are acceptable for source maintenance, build-time generation, and automated tests.
- Generated runtime output must not require users to run `npm install` inside target projects or install transitive runtime libraries before hooks can execute.

Branch model:

- `devel`: main source branch containing TypeScript source, templates, docs, the pinned OpenAPI spec, the custom generator, and committed generated TypeScript client source.
- `latest`: generated stable release/distribution branch containing the validated marketplace release artifacts from `dist-marketplace/` built from `devel`.
- `dist/<source-branch>`: generated preview release/distribution branch containing the same validated marketplace release artifacts built from a non-`devel` source branch. Nested source branch names are preserved, so `feature/foo` publishes to `dist/feature/foo`.

On source branches, `dist/`, `dist-marketplace/`, and `dist-local/` are generated and ignored. `npm run dist` builds all three trees through the split projection scripts: `build-dist-npm.mjs`, `build-dist-marketplace.mjs`, and `build-dist-local.mjs`, with shared helpers in `build-dist-common.mjs`. `dist/` is the npm package artifact. `dist-marketplace/` is the self-contained marketplace release tree for Gemini, Claude Code, Codex, and OpenCode and is the only tree published to generated release branches. `dist-local/` contains project-local configurations that call an installed `nams-hooks` executable. `dist/` and `dist-local/` are generated and verified on source branches but are not published to `latest` or `dist/<source-branch>`.

```text
dist/
  bin/
    cli.js
    platforms/
    runtime/
    generated/
      nams-client.js
  package.json

dist-marketplace/
  .agents/
    plugins/
      marketplace.json
  .claude-plugin/
    marketplace.json
  gemini-extension.json
  commands/
    nams/
      workspace.toml
  hooks/
    hooks.json
  plugins/
    claude-nams-hooks/
      package.json
      .claude-plugin/
        plugin.json
      commands/
        nams/
          workspace.md
      hooks/
        hooks.json
      bin/
        cli.js
    codex-nams-hooks/
      package.json
      .codex-plugin/
        plugin.json
      hooks/
        hooks.json
      skills/
        workspace/
          SKILL.md
          agents/
            openai.yaml
      bin/
        cli.js
    gemini-nams-hooks/
      package.json
      bin/
        cli.js
    opencode-nams-hooks/
      package.json
      nams-hooks.js
      bin/
        cli.js

dist-local/
  claude/
    .claude/
      commands/
        nams/
          workspace.md
      settings.local.json
  codex/
    .codex/
      hooks.json
  gemini/
    .gemini/
      commands/
        nams/
          workspace.toml
      settings.json
  opencode/
    .opencode/
      plugins/
        nams-hooks.js
```

Gemini users install from the generated release branch:

```bash
gemini extensions install https://github.com/neo4j-labs/nams-plugins --ref latest
```

For local testing, link the generated extension folder:

```bash
npm run dist:marketplace
gemini extensions link ./dist-marketplace
```

Gemini marketplace artifacts place `gemini-extension.json`, `hooks/hooks.json`, and `commands/nams/workspace.toml` at the extension root because Gemini expects those paths. The self-contained marketplace tree bundles the compiled runtime under `plugins/gemini-nams-hooks/bin/cli.js`; local project configurations in `dist-local/gemini/` call an installed `nams-hooks` executable instead. Marketplace hooks call the bundled runtime through `${extensionPath}`:

```bash
node "${extensionPath}/plugins/gemini-nams-hooks/bin/cli.js" run gemini --event SessionStart
```

The Gemini `/nams:workspace` custom command intentionally does not call the
bundled extension runtime. It keeps a readable echo payload and requires an
installed `nams-hooks` executable so local and marketplace workspace command
behavior remain identical:

```bash
echo '{ "command_name": "nams:workspace", "command_args": "<args>" }' | nams-hooks workspaces run gemini --event CustomCommand
```

Claude Code users can add the generated release tree as a plugin marketplace and install the `nams-hooks` plugin. Claude loads the plugin's standard `hooks/hooks.json` automatically, so `.claude-plugin/plugin.json` must not point its `hooks` field at that file. The plugin manifest declares user configuration for a required sensitive `NAMS_API_KEY`, a required non-sensitive `NAMS_WORKSPACE_ID`, and a non-sensitive `NAMS_BASE_URL` with the standard service URL as its configuration default. Plugin hooks call the bundled compiled runtime through `${CLAUDE_PLUGIN_ROOT}/bin/cli.js`, so Claude plugin installs do not require a global `nams-hooks` executable:

```bash
claude plugin marketplace add neo4j-labs/nams-plugins@latest
claude plugin install nams-hooks@nams-plugins
```

Codex users can add the generated release tree as a repo marketplace and install the available `nams-hooks` plugin. The Codex marketplace lives at `.agents/plugins/marketplace.json` and points to `./plugins/codex-nams-hooks`. The plugin bundles its own compiled `bin/cli.js` and standard `hooks/hooks.json`, with hook commands using `${PLUGIN_ROOT}/bin/cli.js`, so Codex marketplace memory hooks do not require a global `nams-hooks` executable. The Codex `$nams:workspace` skill is intentionally different: it requires an installed `nams-hooks` executable so local and marketplace workspace command behavior remain identical. Codex marketplace policy uses `authentication: "ON_USE"` as marketplace auth timing metadata, but plugin installs do not define NAMS credential values or prompts through plugin metadata; they use the existing `.nams/config.json` and `NAMS_*` environment configuration model:

```bash
codex plugin marketplace add neo4j-labs/nams-plugins@latest
```

OpenCode marketplace distribution is self-contained under `dist-marketplace/plugins/opencode-nams-hooks/`, with `nams-hooks.js` and bundled `bin/cli.js`. Local fallback/project configurations live under `dist-local/codex/.codex/`, `dist-local/claude/.claude/`, `dist-local/gemini/.gemini/`, and `dist-local/opencode/.opencode/`; those local artifacts call an installed `nams-hooks` executable.

Manual or CI release flow:

1. Work on `devel` or another source branch.
2. Run `npm run openapi:fetch` when the NAMS contract needs refreshing.
3. Run `npm run openapi:generate`.
4. Commit `docs/nams-openapi.json` and `src/generated/nams-client.ts` if they changed.
5. Run package verification.
6. Run release preparation to create the marketplace release tree from `dist-marketplace/`.
7. Replace the target generated branch contents with the validated `dist-marketplace/` release tree: `latest` for `devel`, or `dist/<source-branch>` for another source branch.
8. Commit the marketplace release artifact on the target generated branch.
9. When the target is `latest`, force-update the `latest` tag and recreate the GitHub Release named `latest`.

Rules:

- Generated release artifacts are produced from source branches; no hand edits.
- Successful push-triggered Builds publish `devel` to `latest` and every other source branch to `dist/<source-branch>`.
- Pull-request Builds never publish artifacts.
- Generated `latest` and `dist/**` branches do not trigger Build or Release again.
- A daily UTC cleanup removes generated `dist/**` branches whose tip commit is older than 30 days. The cleanup does not target `latest` or source branches and may also be run through manual dispatch.
- The `latest` release tag and GitHub Release are created only from `latest`; preview branches do not create tags or GitHub Releases.
- Gemini stable installs use `--ref latest`; preview validation may use the corresponding `dist/<source-branch>` ref.
- Codex, Claude, Gemini, and OpenCode marketplace release artifacts are produced from the same validated source tree.
- `dist/` and `dist-local/` are verification artifacts on source branches; they are not copied to generated release branches.
- `npm run package:check` must verify all generated artifacts: npm package output in `dist/`, self-contained marketplace output in `dist-marketplace/`, local project configuration output in `dist-local/`, and npm dry-run package contents.

## Configuration

Persistent configuration is JSON plus environment-backed operational overrides. The runtime reads `~/.nams/config.json` first, overlays `<project>/.nams/config.json` when present, asks the active platform adapter for optional discovered configuration, and finally overlays supported `NAMS_*` environment variables when they are set. `NAMS_*` environment variables are the highest-precedence operational override. Platforms without a native user-configuration surface return no discovered configuration.

Supported JSON keys:

- `apiKey`: NAMS workspace API key, sent as `Authorization: Bearer <key>`.
- `workspaceId`: NAMS workspace identifier for memory requests.
- `baseUrl`: NAMS base URL, defaulting to `https://memory.neo4jlabs.com` when provided by standard configuration examples or platform configuration templates. The runtime and generated client must not hardcode a production service URL.

Example:

```json
{
  "apiKey": "nams-api-key",
  "workspaceId": "5e5c0535-8d85-491c-b92c-33be13659998",
  "baseUrl": "https://memory.neo4jlabs.com"
}
```

Platform-specific discovery:

- Claude Code plugin installs discover `apiKey`, `workspaceId`, and `baseUrl` from Claude's plugin user configuration environment exports.
- Codex, Gemini, and OpenCode currently provide no additional discovered configuration.

Claude plugin discovery sources:

- `CLAUDE_PLUGIN_OPTION_NAMS_API_KEY`: fills `apiKey` from the Claude plugin's required sensitive `NAMS_API_KEY` setting.
- `CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID`: fills `workspaceId` from the Claude plugin's optional non-sensitive `NAMS_WORKSPACE_ID` setting.
- `CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL`: fills `baseUrl` from the Claude plugin's optional `NAMS_BASE_URL` setting, whose plugin default is `https://memory.neo4jlabs.com`.

Supported final environment overrides:

- `NAMS_API_KEY`: overrides `apiKey`.
- `NAMS_WORKSPACE_ID`: overrides `workspaceId`.
- `NAMS_BASE_URL`: overrides `baseUrl`.

Required:

- `apiKey`, from either JSON config or `NAMS_API_KEY`.
- `baseUrl`, from JSON config, Claude plugin user configuration, or `NAMS_BASE_URL`.
- `workspaceId`, from JSON config, Claude plugin user configuration, or `NAMS_WORKSPACE_ID`, unless a harness-specific workspace-resolution phase selects one before memory starts.

Final environment overrides are limited to `NAMS_API_KEY`, `NAMS_WORKSPACE_ID` and `NAMS_BASE_URL` unless a future design explicitly adds more. The runtime records sanitized `configSources` diagnostics in the session log, for example `apiKey: "env:NAMS_API_KEY"`, `workspaceId: "env:NAMS_WORKSPACE_ID"`, `workspaceId: "platform:claude:CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID"`, `baseUrl: "project:.nams/config.json"`, or `baseUrl: "missing"`. It never logs secret values or full config objects.

`.env` files are not part of the target configuration model. Secrets remain outside committed harness configs. The installer ensures project `.nams/config.json` stays local and gitignored when it creates or modifies a project override.

When global or project JSON config files exist and are readable, the runtime tightens their mode to `0600` before using their values. If a future installer creates or updates either config file, it must create the containing `.nams` directory with owner-only directory permissions and write the config file with `0600`.

## Session State

Do not rely on the agent harness as a mutable variable store. Harness IDs are keys, not storage.

The runtime persists session state under `~/.nams/state/<harness>/session-<created-at>--<session-hash>.json`. The timestamp comes from the state file's `createdAt` value, is UTC ISO-8601 with filename-unsafe separators removed, and appears first so state files sort naturally by session initialization time. The path is platform-scoped and keeps the raw session key hashed to avoid unsafe filenames and leaking raw session IDs through filenames. The runtime resolves state by scanning the platform directory for the matching session-key hash suffix. Hash-only filenames from older builds are not part of the supported lookup contract. The state file itself keeps the readable project directory and resolved session key for debugging:

```json
{
  "harness": "claude",
  "harnessSessionId": "abc123",
  "sessionKey": "abc123",
  "projectDirectory": "/path/to/project",
  "conversationId": "nams-conversation-uuid",
  "createdAt": "2026-05-10T09:00:00.000Z",
  "lastPromptHash": "sha256",
  "lastAssistantHash": "sha256",
  "lastStepId": null
}
```

Session key strategy:

- Claude Code: prefer `session_id`; retain `transcript_path` and `cwd` as supporting metadata.
- Codex: prefer `session_id` when present; use `cwd` and payload metadata as fallback. The `doctor` command should report detected Codex hook support because this surface is still moving.
- Gemini CLI: prefer a session field if present; otherwise use project path plus stable request metadata from hook payloads.

If no state exists on a user prompt event, the runtime creates a NAMS conversation and stores the mapping locally.

## NAMS REST Mapping

REST calls go through the generated `NamsClient` from `src/generated/nams-client.ts`. The OpenAPI generator and generated client contract are described in `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`.

Conversation creation:

- `POST /v1/conversations`
- Body: `{ "metadata": {} }`
- Client method: `createConversation`

Message persistence:

- `POST /v1/conversations/{conversationId}/messages`
- User body: `{ "role": "user", "content": "<prompt>" }`
- Assistant body: `{ "role": "assistant", "content": "<response>" }`
- Client method: `addMessage`

Bulk message persistence may be used only when a harness exposes both user and assistant messages together and duplicate suppression remains reliable:

- `POST /v1/conversations/{conversationId}/messages/bulk`
- Client method: `addMessagesBulk`

Recall:

- Use `GET /v1/conversations/{conversationId}/context` when a conversation already exists.
- Use `POST /v1/entities/search` with the first prompt or useful query terms before the first response.
- Merge successful recall sources into one injected context. If one source fails, continue with the other.
- Client methods: `getConversationContext`, `searchEntities`, `searchConversationMessages`

Tool metadata:

- `POST /v1/reasoning/tool-calls`
- Body fields:
  - `stepId`: optional, from local state when available
  - `toolName`
  - `input`: sanitized and capped serialized tool input
  - `output`: exposed tool output when available, otherwise empty string
  - `status`
  - `durationMs`
- Client method: `recordToolCall`

Reasoning steps:

- v1 may support `POST /v1/reasoning/steps` for operational summaries when a harness exposes a clean summary. It must not store hidden chain-of-thought. This is secondary to message and tool-call persistence.
- Client method: `recordReasoningStep`

Entity persistence:

- v1 does not call entity creation endpoints directly. It relies on NAMS async entity extraction from stored messages.

## Hook Event Behavior

Session start:

- Load config.
- CLI receives a typed `SessionStart` event from `--event SessionStart`.
- CLI reads raw hook JSON without interpreting platform-specific fields.
- CLI dispatches to `adapter.startSession(invocation)` through the static platform registry.
- The platform adapter initializes local state if a stable session key is available.
- Do not create the NAMS conversation during `SessionStart`.
- Return harness-specific empty or context-safe JSON.

User prompt submit or before-agent:

- Resolve or create session state and NAMS conversation.
- Recall relevant memory.
- Store the user prompt using the messages endpoint.
- Return harness-specific context output with:
  - relevant memory context
  - a short instruction that the agent should use the context silently and avoid narrating memory mechanics

For Gemini CLI this context is returned as `hookSpecificOutput.additionalContext`, not as a top-level `additionalContext` field.

Tool completion:

- Record tool metadata when the harness exposes a post-tool event.
- Persist `toolName`, sanitized `input`, exposed `output`, optional `stepId`, status, and duration.
- Create a safe operational reasoning step first when the harness exposes a tool event but does not expose a parent reasoning step.

Assistant complete or stop:

- Store assistant response when available from hook payload or transcript.
- Use local hashes to suppress duplicate assistant messages.
- If response capture is not clean for a harness, skip it and log a diagnostic.

Session end:

- Do not flush runtime logs or state.
- Do not delete remote NAMS data.

## Harness Notes

Claude Code:

- Strong v1 support because hook inputs include `session_id`, `transcript_path`, `cwd`, and event-specific fields.
- Use generated Claude plugin marketplace distribution by default for releases. The marketplace root is `dist-marketplace/.claude-plugin/marketplace.json`, and the plugin root is `dist-marketplace/plugins/claude-nams-hooks/`. The plugin contains the standard auto-loaded `hooks/hooks.json` and a bundled compiled `bin/cli.js`; hook commands reference `${CLAUDE_PLUGIN_ROOT}` rather than a global executable. The plugin manifest omits `hooks` unless future additional hook files are introduced, and declares Claude `userConfig` for the required sensitive NAMS API key plus optional workspace and base URL.
- Keep `dist-local/claude/.claude/settings.local.json` as a fallback path for local manual installs that call an installed `nams-hooks`.
- Use `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop`.

Gemini CLI:

- Use Gemini extension distribution for v1. Marketplace release artifacts place `gemini-extension.json`, `hooks/hooks.json`, and `commands/nams/workspace.toml` at the `dist-marketplace/` extension root, with the bundled runtime under `plugins/gemini-nams-hooks/bin/cli.js`.
- Keep `dist-local/gemini/.gemini/` as a symlinkable project-local configuration that calls an installed `nams-hooks`, with hooks in `.gemini/settings.json` and commands in `.gemini/commands/`.
- Use `SessionStart`, `BeforeAgent`, `AfterTool`, and `AfterAgent` where available.
- `BeforeAgent` can inject relevant memory context.
- `AfterAgent` can persist assistant responses when `prompt_response` or equivalent is present.

Codex:

- Use generated Codex repo marketplace distribution by default for releases. The marketplace root is `dist-marketplace/.agents/plugins/marketplace.json`, the plugin root is `dist-marketplace/plugins/codex-nams-hooks/`, and plugin hooks reference `${PLUGIN_ROOT}` rather than a global executable.
- Use `dist-local/codex/.codex/hooks.json` and `dist-local/codex/.codex/skills/workspace/` for project-level fallback installs that call an installed `nams-hooks`.
- The repository template must use Codex's command-hook group shape for `SessionStart`:
  `{ "matcher": "startup|resume", "hooks": [{ "type": "command", "command": "nams-hooks run codex --event SessionStart", "statusMessage": "Loading session notes" }] }`.
  Do not use the stale short-form object that places `command` directly under `SessionStart`.
- Use `SessionStart`, `UserPromptSubmit`, `Stop`, and `PostToolUse`, mapped to NAMS `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- Tool-level capture is best-effort for exposed `PostToolUse` payloads and clear transcript-derived tool records.
- `doctor` should identify missing or partial Codex hook support and report it clearly.

OpenCode:

- Use generated OpenCode marketplace distribution under `dist-marketplace/plugins/opencode-nams-hooks/` for self-contained release artifacts, with a bundled compiled `bin/cli.js`.
- Use `dist-local/opencode/.opencode/plugins/nams-hooks.js` for project-level fallback installs that call an installed `nams-hooks`.
- The plugin maps `session.created`, `chat.message`, `experimental.chat.system.transform`, `experimental.text.complete`, and `tool.execute.after` to NAMS `SessionStart`, `BeforeAgent`, `AfterAgent`, and `AfterTool`.
- `chat.message` creates or reuses the NAMS conversation, recalls memory, persists user messages, and stores pending context for system prompt injection.
- `experimental.text.complete` persists exposed assistant text best-effort.
- `tool.execute.after` persists sanitized tool metadata and exposed tool output.

## Duplicate Suppression

Hooks may replay or expose the same text through multiple events. The runtime uses SHA-256 hashes stored in session state to suppress duplicate user and assistant messages.

The hash input includes:

- harness
- session key
- role
- normalized message content
- event timestamp bucket or turn index when available

Suppression is local-only. It should avoid duplicate writes without requiring a NAMS query before every message.

## Error Handling

Hooks are non-blocking by default.

If NAMS is unavailable, the API key is missing, or a REST call fails:

- log the failure under `~/.nams/logs/<harness>/`
- do not expose API keys or secrets in logs
- return normal allow or empty JSON to the harness
- let agent work continue

If recall fails, the prompt proceeds without injected memory context.

Installer errors are stricter. The installer should refuse unsafe overwrites and should create timestamped backups before modifying existing harness configs.

## Security And Privacy

- `~/.nams/config.json`, `~/.nams/state/`, and `~/.nams/logs/` are user-local runtime files.
- Project `.nams/config.json` is an optional local override and must be gitignored.
- Files created or touched under global `~/.nams/` or project `.nams/` must be owner-readable and owner-writable only (`0600`); runtime-created directories use `0700`.
- `.env` files are not supported by the target configuration model.
- API keys are never printed to stdout or logs.
- Tool outputs are not stored in v1.
- Tool inputs are serialized conservatively and capped.
- Standard messages are persisted as authored because they are the canonical memory stream.
- The hook runner writes only harness-specific JSON to stdout. Diagnostics go to logs or stderr depending on harness tolerance.

## Installer Behavior

`nams-hooks install --harness claude,gemini,codex,opencode` installs into the current project by default.

The installer:

- creates `~/.nams/config.json` when the user chooses global configuration
- creates project `.nams/config.json` only when the user chooses a project override
- creates or updates global and project `.nams` files with `0600` file permissions
- ensures project `.nams/config.json` is gitignored
- writes or merges harness hook configs
- backs up existing config files before changing them
- prints next steps for setting `apiKey`, `workspaceId`, `NAMS_API_KEY`, or `NAMS_WORKSPACE_ID`

Future installer commands may include:

- `doctor`
- `uninstall`
- `status`

## Testing Plan

Unit tests:

- config precedence: global JSON defaults, project JSON overrides, and environment variables override both
- session-state creation and lookup under `~/.nams/state/<harness>/`
- REST request shaping
- generated `NamsClient` request and error behavior
- duplicate message suppression
- harness payload parsing
- harness output formatting
- tool input sanitization and size capping

Contract tests:

- generated NAMS client endpoint metadata matches `docs/nams-openapi.json`
- generated client does not read OpenAPI at runtime
- generated client shapes bearer JSON requests correctly
- generated client throws stable errors for NAMS error responses

Fixture tests:

- Claude: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`
- Gemini: `SessionStart`, `BeforeAgent`, `AfterTool`, `AfterAgent`
- Codex: `SessionStart`, `UserPromptSubmit`, `Stop`, `PostToolUse`
- OpenCode: `session.created`, `chat.message`, `experimental.chat.system.transform`, `experimental.text.complete`, `tool.execute.after`

## Gateway Interfaces

The shared interface is driven by typed NAMS lifecycle events:

```ts
export const hookEvents = ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool"] as const;
export type HookEvent = (typeof hookEvents)[number];

export interface HookInvocation<E extends HookEvent = HookEvent> {
  platform: Platform;
  event: E;
  rawPayload: Record<string, unknown>;
  processCwd: string;
}

export interface HookResult {
  stdout: Record<string, unknown>;
}

export interface PlatformAdapter {
  startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult>;
  beforeAgent?(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult>;
  afterAgent?(invocation: HookInvocation<"AfterAgent">): Promise<HookResult>;
  afterTool?(invocation: HookInvocation<"AfterTool">): Promise<HookResult>;
}
```

The CLI validates `--event` against `hookEvents`, routes each typed event to the corresponding adapter method, and prints the returned `stdout`. Harness-native hook names stay in templates and platform adapters; `invocation.event` remains the NAMS event source of truth.

Installer tests:

- creates global config or project override config as requested
- merges or backs up existing configs
- updates `.gitignore` idempotently
- reports installed harnesses

Manual validation:

- run `nams-hooks doctor`
- install into a throwaway macOS project
- start each harness and send a prompt
- confirm one NAMS conversation is created
- confirm user messages persist
- confirm assistant messages persist where exposed
- run a tool call and confirm metadata, exposed output, and deterministic step linkage persist
- restart or resume a harness and confirm conversation reuse when the harness session ID matches

## Open Risks

- Codex hook support is still evolving. v1 should degrade gracefully and make `doctor` explicit about supported events.
- Gemini session identity may require fallback keys if the hook payload lacks a stable session ID.
- Assistant response capture may be best-effort for some harness versions.
- Prompt/context injection may be visible in some harness UIs even when intended as model context.
- NAMS REST API shape may drift from the pinned OpenAPI copy. The build-time fetch and contract-test workflow should make drift explicit before release.
- GitHub install from `latest` means any accidental unreleased commit to `latest` becomes installable immediately; branch protections should require release automation.

## Approval Record

Approved decisions from brainstorming:

- Standalone `nams-plugins` repo containing the `nams-hooks` runtime product.
- First iteration: Codex, Claude Code, Gemini CLI, and OpenCode on macOS.
- User-level runtime state and logs under `~/.nams/`.
- Codex, Claude Code, Gemini, and OpenCode use generated marketplace distribution for release artifacts, with `dist-local/` project-level configurations as fallbacks that call an installed `nams-hooks`.
- Plain Node.js with built-in modules only.
- JSON configuration with global defaults in `~/.nams/config.json`, optional project overrides in `.nams/config.json`, and final environment overrides from `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL`.
- Deterministic REST writes from hook runner, not MCP-driven writes.
- Persist user messages and assistant responses as the core memory stream.
- Store assistant responses in v1 where harnesses expose them cleanly.
- Store tool-call metadata with exposed output when available.
- Rely on NAMS async entity extraction from stored messages.
- Use TypeScript for source and release vanilla JavaScript.
- Use a custom generated `NamsClient` for REST calls.
- Use `devel` as the main source branch; publish its validated `dist-marketplace/` artifacts to `latest`, and publish non-`devel` source branch artifacts to `dist/<source-branch>`. Keep `dist/` and `dist-local/` as generated verification artifacts on source branches.
