# Codex Self-Contained Marketplace Design

Date: 2026-06-04
Status: Approved design
Repository: nams-hooks

## Summary

`nams-hooks` will add a Codex repo marketplace release path that installs a self-contained Codex plugin. The Codex plugin bundles the compiled hook runtime and default lifecycle hook configuration, so a Codex marketplace install does not depend on a globally installed `nams-hooks` command.

NAMS credentials remain configured through the existing runtime configuration model: user/project `.nams/config.json` plus `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and `NAMS_BASE_URL` environment overrides. Codex plugin installation will not introduce a Claude-style plugin secret prompt because Codex's public plugin documentation does not currently describe an equivalent custom `userConfig` mechanism for arbitrary hook environment values.

## Source Inputs

- `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- `docs/superpowers/specs/2026-05-12-codex-memory-flow-design.md`
- `docs/superpowers/specs/2026-06-03-nams-workspace-id-design.md`
- `docs/superpowers/specs/2026-05-12-claude-memory-flow-design.md`
- Existing Claude release worktree: `.worktrees/claude-code-release`
- Codex plugin documentation: `https://developers.openai.com/codex/plugins/build`
- Codex hooks documentation: `https://developers.openai.com/codex/hooks`
- Claude Code plugin marketplace documentation: `https://code.claude.com/docs/en/plugin-marketplaces`
- Claude Code plugin reference for the contrasting `userConfig` behavior: `https://code.claude.com/docs/en/plugins-reference`

## Goals

- Provide a self-contained Codex repo marketplace release path.
- Keep Codex runtime code dependency-free and bundled under the plugin directory.
- Expose the Codex plugin as available, not auto-installed.
- Preserve existing Codex memory behavior and typed NAMS event routing.
- Preserve existing NAMS configuration sources and fail-open behavior.
- Keep Codex platform logic under `src/platforms/codex/`.
- Verify generated Codex marketplace artifacts during package checks.

## Non-Goals

- Adding a Codex-specific NAMS credential prompt.
- Storing NAMS API keys in Codex plugin metadata.
- Replacing the existing project-level `templates/codex/hooks.json` path in this change.
- Changing Codex hook event behavior, payload parsing, transcript fallback, or memory semantics.
- Adding runtime npm dependencies.
- Runtime OpenAPI discovery.
- Expanding Claude, Gemini, or OpenCode behavior beyond packaging interactions needed for the shared release artifact.

## Packaging Decision

The Codex release path will mirror the successful Claude plugin-release shape while respecting Codex's own plugin schema. Generated distribution output will include:

```text
dist/
  .agents/
    plugins/
      marketplace.json
  plugins/
    nams-hooks/
      .codex-plugin/
        plugin.json
      hooks/
        hooks.json
      bin/
        cli.js
        platforms/
        runtime/
        generated/
```

The marketplace file exposes a single plugin named `nams-hooks` with `source.path` set to `./plugins/nams-hooks`. Its policy sets `installation` to `AVAILABLE`. It does not make the plugin installed by default, and it does not declare Codex plugin authentication for NAMS credentials.

The plugin manifest uses stable package metadata: `name`, `version`, `description`, `license`, `repository`, and keywords. Lifecycle hooks are provided through the default `hooks/hooks.json` file rather than inline manifest hook configuration.

## Hook Command Shape

Codex plugin hooks will invoke the bundled runtime through `PLUGIN_ROOT`:

```json
{
  "type": "command",
  "command": "node ${PLUGIN_ROOT}/bin/cli.js run codex --event BeforeAgent",
  "statusMessage": "NAMS memory recall"
}
```

The generated plugin hook file maps the same native Codex hooks to the same typed NAMS events as the existing project template:

| Codex hook | NAMS event | Purpose |
| --- | --- | --- |
| `SessionStart` | `SessionStart` | Initialize local session state and logs. |
| `UserPromptSubmit` | `BeforeAgent` | Recall memory and persist the user prompt. |
| `Stop` | `AfterAgent` | Persist exposed assistant response best-effort. |
| `PostToolUse` | `AfterTool` | Persist exposed tool metadata. |

`src/cli.ts` remains a gateway. It still reads stdin JSON as an opaque payload and routes from the explicit typed `--event`; it must not infer event names from Codex payload fields.

## Configuration Model

Codex plugin installation is self-contained for runtime code only. NAMS runtime configuration remains:

1. User-global `~/.nams/config.json`.
2. Project-local `.nams/config.json`.
3. Environment overrides:
   - `NAMS_API_KEY`
   - `NAMS_WORKSPACE_ID`
   - `NAMS_BASE_URL`

This deliberately differs from Claude and Gemini distribution:

- Claude Code plugins support `userConfig` and expose configured values to plugin commands through `CLAUDE_PLUGIN_OPTION_*` environment variables.
- Gemini extensions support settings that map to environment variables.
- Codex plugin documentation describes plugin manifests, marketplace entries, bundled lifecycle hooks, `PLUGIN_ROOT`, and `PLUGIN_DATA`, but it does not document a custom install-time secret schema equivalent to Claude `userConfig`.

The Codex plugin should therefore not invent NAMS credential storage. If required config is missing, the existing runtime fail-open path continues: allow Codex to proceed, skip NAMS writes, and log sanitized diagnostics without raw secrets or arbitrary error text.

## Build Integration

`scripts/build-dist.mjs` will render Codex templates into `dist/` alongside the existing Gemini and Claude release artifacts:

- Render `templates/codex/.agents/plugins/marketplace.json` to `dist/.agents/plugins/marketplace.json`.
- Render `templates/codex/plugins/nams-hooks/.codex-plugin/plugin.json` to `dist/plugins/nams-hooks/.codex-plugin/plugin.json`.
- Render `templates/codex/plugins/nams-hooks/hooks/hooks.json` to `dist/plugins/nams-hooks/hooks/hooks.json`.
- Copy compiled runtime output from `.build/tsc` to `dist/plugins/nams-hooks/bin`.
- Mark the bundled `dist/plugins/nams-hooks/bin/cli.js` executable.

Package placeholder rendering should reuse the existing package-version and package-license replacement flow introduced for Claude.

## Verification

Tests and package checks should verify:

- Codex plugin template hook commands invoke `node ${PLUGIN_ROOT}/bin/cli.js`.
- Codex plugin hook commands preserve the current Codex-to-NAMS event mapping.
- Codex repo marketplace exposes `nams-hooks` from `./plugins/nams-hooks`.
- Codex marketplace policy marks installation as available.
- Codex plugin manifest renders package version and license values.
- Generated `dist/plugins/nams-hooks/bin/cli.js` is executable.
- `npm pack --dry-run` includes Codex marketplace and plugin files for both root and generated `dist/` package checks.
- Generated artifacts do not include OpenAPI specs or runtime OpenAPI readers.
- `npm run check` and `npm run package:check` pass.

## Documentation Updates

`README.md`, `INSTALL.md`, and the architecture design should be updated to distinguish:

- Gemini extension distribution.
- Claude Code marketplace plugin distribution.
- Codex repo marketplace plugin distribution.
- Existing global/project hook template paths that remain available but are not the Codex marketplace release path.

Codex installation docs should tell users to add or use the repo marketplace, install the available `nams-hooks` plugin, configure NAMS through `.nams/config.json` or environment variables, restart Codex, and review/trust hooks through Codex's normal hook trust flow when prompted.

## Open Questions Resolved

- Codex plugin should be self-contained for runtime code: yes.
- Codex marketplace entry should be available rather than installed by default: yes.
- Codex should define NAMS secrets at plugin install time: no, not until Codex documents a custom plugin secret/user-config mechanism.
