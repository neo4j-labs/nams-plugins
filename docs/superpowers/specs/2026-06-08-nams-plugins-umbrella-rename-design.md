# NAMS Plugins Umbrella Rename Design

Date: 2026-06-08
Status: Approved design
Repository: nams-plugins

## Summary

`nams-plugins` becomes the umbrella identity for the repository, release
artifact, npm package, and plugin marketplaces. The current hooks integration
remains a product inside that umbrella. Its installable plugin name and CLI
executable remain `nams-hooks`.

The intended Claude installation flow is:

```bash
claude plugin marketplace add neo4j-labs/nams-plugins@latest
claude plugin install nams-hooks@nams-plugins
```

The Codex marketplace will use the same repository and marketplace identity:

```bash
codex plugin marketplace add neo4j-labs/nams-plugins@latest
```

Runtime behavior, hook event routing, NAMS configuration, state, logs, and
platform adapter boundaries are unchanged.

## Source Inputs

- `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- `docs/superpowers/specs/2026-06-04-codex-self-contained-marketplace-design.md`
- `README.md`
- `INSTALL.md`
- `DEVELOPMENT.md`
- `package.json`
- `templates/claude/.claude-plugin/marketplace.json`
- `templates/claude/plugins/nams-hooks/.claude-plugin/plugin.json`
- `templates/codex/.agents/plugins/marketplace.json`
- `templates/codex/plugins/codex-nams-hooks/.codex-plugin/plugin.json`
- `scripts/check-dist.mjs`
- Template and package tests under `test/`

## Goals

- Move documented repository identity to `neo4j-labs/nams-plugins`.
- Move documented npm package identity to `@neo4j-labs/nams-plugins`.
- Standardize generated Claude and Codex marketplace names to `nams-plugins`.
- Keep the current installable plugin named `nams-hooks`.
- Keep the current CLI executable named `nams-hooks`.
- Keep release output self-contained and dependency-free at runtime.
- Make tests and package checks enforce the new identity split.
- Remove old repository, package, and marketplace install examples from docs and
  generated release metadata.

## Non-Goals

- Adding new plugins, skills, or marketplace entries.
- Renaming the hooks plugin to `nams-plugins`.
- Renaming the CLI executable away from `nams-hooks`.
- Renaming TypeScript source directories, platform directories, or adapter
  contracts.
- Changing hook commands, hook event mappings, NAMS memory behavior, runtime
  configuration precedence, state paths, or log paths.
- Documenting compatibility install paths for old repository, package, or
  marketplace names.
- Hand-editing generated `dist/` output.

## Naming Model

`nams-plugins` owns umbrella release identity:

| Surface | Name |
| --- | --- |
| GitHub repository | `neo4j-labs/nams-plugins` |
| npm package | `@neo4j-labs/nams-plugins` |
| Claude marketplace | `nams-plugins` |
| Codex marketplace | `nams-plugins` |

`nams-hooks` owns the current hooks product identity:

| Surface | Name |
| --- | --- |
| Claude plugin | `nams-hooks` |
| Codex plugin | `nams-hooks` |
| Gemini extension | `nams-hooks` |
| npm executable | `nams-hooks` |
| Runtime command | `nams-hooks run <platform> --event <event>` |

This split keeps the visible command surface accurate for the current artifact
while leaving room for future plugins, skills, or related NAMS integrations to
live in the same repository and marketplace.

## Source Artifact Changes

The implementation should update identity-bearing source files only:

- `package.json`
  - Change the package name to `@neo4j-labs/nams-plugins`.
  - Keep `bin.nams-hooks` pointing at the compiled CLI.
- Claude marketplace template
  - Change marketplace `name` to `nams-plugins`.
  - Keep the plugin entry `name` as `nams-hooks`.
  - Change repository metadata to
    `https://github.com/neo4j-labs/nams-plugins`.
- Claude plugin manifest template
  - Keep manifest `name` as `nams-hooks`.
  - Change repository metadata to
    `https://github.com/neo4j-labs/nams-plugins`.
- Codex marketplace template
  - Change marketplace `name` to `nams-plugins`.
  - Keep the plugin entry `name` as `nams-hooks`.
  - Keep plugin source path as `./plugins/codex-nams-hooks`.
  - Change repository metadata to
    `https://github.com/neo4j-labs/nams-plugins`.
- Codex plugin manifest template
  - Keep manifest `name` as `nams-hooks`.
  - Change repository metadata to
    `https://github.com/neo4j-labs/nams-plugins`.
- Gemini extension template
  - Keep extension `name` as `nams-hooks`.
  - Do not introduce marketplace umbrella naming for Gemini in this change.
- Documentation
  - Update install examples to use `neo4j-labs/nams-plugins@latest` and
    `nams-hooks@nams-plugins`.
  - Update package references to `@neo4j-labs/nams-plugins`.
  - Preserve `nams-hooks` when referring to the hooks plugin, CLI executable,
    runtime command, or product behavior.

Generated `dist/` remains derived output from `npm run dist`; it should not be
edited directly.

## Distribution Shape

The generated release tree keeps the existing runtime layout and plugin source
directories:

```text
dist/
  .agents/
    plugins/
      marketplace.json          # marketplace name: nams-plugins
  .claude-plugin/
    marketplace.json            # marketplace name: nams-plugins
  bin/
    cli.js                      # executable exposed as nams-hooks
  plugins/
    codex-nams-hooks/
      .codex-plugin/
        plugin.json             # plugin name: nams-hooks
      hooks/
        hooks.json
      bin/
        cli.js
    nams-hooks/
      .claude-plugin/
        plugin.json             # plugin name: nams-hooks
      hooks/
        hooks.json
      bin/
        cli.js
  gemini-extension.json         # extension name: nams-hooks
  hooks/
    hooks.json
  package.json                  # package name: @neo4j-labs/nams-plugins
```

The Codex plugin source directory remains `plugins/codex-nams-hooks/` so the
Codex-specific hook file does not collide with the Claude plugin source
directory, `plugins/nams-hooks/`.

## Runtime Behavior

No runtime behavior changes are part of this design.

The CLI remains:

```bash
nams-hooks run claude --event BeforeAgent
nams-hooks run codex --event BeforeAgent
nams-hooks workspaces configure codex --scope project
```

`src/cli.ts` remains a gateway that parses the command, platform, and typed
event, reads stdin JSON as an opaque object, and dispatches through the static
platform registry. Platform-specific behavior remains inside
`src/platforms/<platform>/`.

NAMS configuration, state, and logs continue to use the existing `.nams/`
locations and precedence rules. This rename must not hardcode the NAMS service
URL, add runtime dependencies, or change OpenAPI build-time boundaries.

## Verification

Tests and package checks should enforce the naming split:

- Template tests assert Claude and Codex marketplace names are `nams-plugins`.
- Template tests assert Claude and Codex plugin manifests still name the plugin
  `nams-hooks`.
- Template tests assert repository metadata points to
  `https://github.com/neo4j-labs/nams-plugins`.
- Package checks assert source and generated package names are
  `@neo4j-labs/nams-plugins`.
- Package checks assert packed packages still expose `bin.nams-hooks`.
- Distribution checks assert generated marketplace files use `nams-plugins`.
- Documentation checks or targeted searches catch stale install examples using
  old repository, package, or marketplace names.

Primary verification remains:

```bash
npm run check
npm run package:check
```

`npm run check` runs the default check suite. `npm run package:check` builds
`dist/`, verifies generated plugin artifacts, and dry-runs package contents.

## Documentation Update Rules

Documentation should describe the new naming model consistently:

- Use `nams-plugins` for repository, release, package, and marketplace identity.
- Use `nams-hooks` for the current plugin, CLI, runtime command, and hook
  product behavior.
- Do not document legacy repository, package, or marketplace install commands.
- Existing historical specs may keep old names when they describe the state at
  the time they were written, but active source-of-truth architecture and user
  docs should point to the new identity.

## Open Questions Resolved

- Should package and CLI names be reconsidered? Yes.
- Should the npm package fully move to `@neo4j-labs/nams-plugins`? Yes.
- Should the CLI remain `nams-hooks`? Yes.
- Should Claude and Codex marketplace names standardize to `nams-plugins`? Yes.
- Should the installable plugin remain `nams-hooks`? Yes.
