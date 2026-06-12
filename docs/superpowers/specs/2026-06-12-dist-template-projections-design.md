# Dist Template Projections Design

Date: 2026-06-12
Status: Approved design
Repository: nams-plugins

## Summary

`nams-hooks` will split generated output into three explicit, gitignored
distribution trees:

- `dist/`: npm-installable package output for `npm install -g $PWD/dist`.
- `dist-marketplace/`: self-contained marketplace release output for every
  currently supported platform.
- `dist-local/`: local project configuration output that depends on an installed
  `nams-hooks` executable.

The source templates remain the canonical hook/config files. Output locations
are owned by the build script through a manifest of template projections, so the
truth of distribution behavior lives in code and tests rather than in informal
directory conventions.

## Goals

- Make `dist/` an npm package artifact only.
- Make `dist-marketplace/` self-contained for all supported platforms:
  Claude Code, Codex, Gemini CLI, and OpenCode.
- Make `dist-local/` contain only local configurations and shims that rely on an
  installed `nams-hooks` command.
- Keep all three generated directories ignored by git.
- Move templates into a layout that separates shared platform files from local
  install wrappers and marketplace install wrappers.
- Keep marketplace output unambiguous by using explicit platform plugin folder
  names.
- Encode template projection behavior in build and check scripts, with tests
  verifying the resulting contracts.

## Non-Goals

- Changing hook runtime behavior or platform adapter logic.
- Adding runtime npm dependencies.
- Changing the NAMS OpenAPI generation workflow.
- Adding new platform support.
- Publishing or release automation changes beyond producing
  `dist-marketplace/` for the release pipeline to consume.

## Template Layout

Templates will use three layers:

```text
templates/
  <platform>/
    shared hook definitions and reusable platform fragments
  local/
    <platform>/
      project-shaped local install wrappers and configs
  marketplace/
    <platform>/
      marketplace manifests, plugin metadata, and bundled-runtime wrappers
```

Shared files live in `templates/<platform>/` only when they are semantically
shared by more than one output. Local-only files live under
`templates/local/<platform>/`. Marketplace-only files live under
`templates/marketplace/<platform>/`.

The build script, not the template path alone, decides where a template lands in
generated output. This keeps the source layout understandable while making the
projection rules explicit and testable.

## Output Trees

### npm Package Output

`npm run dist:npm` creates `dist/`:

```text
dist/
  bin/
    cli.js
    generated/
    platforms/
    runtime/
  package.json
```

The npm artifact must not include marketplace metadata, local project
configuration, source templates, OpenAPI documents, or runtime OpenAPI readers.
It exists so users and tests can run:

```bash
npm install -g $PWD/dist
```

### Marketplace Output

`npm run dist:marketplace` creates `dist-marketplace/`.

Marketplace output is self-contained. Every marketplace hook command must call a
bundled runtime path such as `${PLUGIN_ROOT}/bin/cli.js`,
`${CLAUDE_PLUGIN_ROOT}/bin/cli.js`, `${extensionPath}/bin/cli.js`, or the
platform's equivalent. Marketplace hooks must not require a globally installed
`nams-hooks` command.

Marketplace plugin directories use explicit platform names:

```text
dist-marketplace/
  .agents/
    plugins/
      marketplace.json
  .claude-plugin/
    marketplace.json
  plugins/
    claude-nams-hooks/
      bin/
      hooks/
    codex-nams-hooks/
      bin/
      hooks/
    gemini-nams-hooks/
      bin/
      hooks/
    opencode-nams-hooks/
      bin/
      hooks/
```

Some platforms may still require root-level marketplace or extension files. The
projection manifest will state those mappings explicitly. If a native platform
format requires a root file such as `gemini-extension.json`, that file may be
projected to the required root location while the platform-specific runtime
bundle remains clearly named.

### Local Output

`npm run dist:local` creates `dist-local/`.

Local output contains symlinkable or copyable project configuration for all
supported platforms. It does not copy compiled runtime files. Local hooks call
the installed executable:

```bash
nams-hooks run <platform> --event <event>
```

or use a platform shim that defaults to `nams-hooks`, such as OpenCode's
`NAMS_HOOKS_COMMAND` override.

Example projected local output:

```text
dist-local/
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
```

The exact local paths are determined by the projection manifest so they can
match each platform's native project configuration shape.

## Build Script Design

`scripts/build-dist.mjs` will expose target-specific build paths:

- `dist:npm`: build `dist/`.
- `dist:marketplace`: build `dist-marketplace/`.
- `dist:local`: build `dist-local/`.
- `dist`: umbrella target that builds all three.

The build script will compile TypeScript once into `.build/tsc`, then render
targets through a projection manifest. The manifest should describe:

- target output tree.
- platform.
- source template root.
- destination path.
- whether package placeholders are rendered.
- whether compiled runtime is copied to a `bin/` directory.
- the expected runtime command mode, such as bundled runtime or installed
  executable.

This is the preferred shape:

```js
const projections = {
  npm: [
    { kind: "runtime", to: "dist/bin" },
    { kind: "packageJson", to: "dist/package.json" },
  ],
  marketplace: [
    { platform: "codex", from: "templates/marketplace/codex", to: "dist-marketplace", runtime: "bundled" },
  ],
  local: [
    { platform: "codex", from: "templates/local/codex", to: "dist-local/codex", runtime: "installed" },
  ],
};
```

The exact JavaScript type can evolve during implementation, but the manifest
must remain small enough for agents and reviewers to understand without tracing
filesystem side effects across many functions.

Placeholder rendering uses the existing package metadata replacements for
`__PACKAGE_VERSION__` and `__PACKAGE_LICENSE__`. Generated output checks must
fail if those placeholders survive in files that should have been rendered.

## Check Script Design

`scripts/check-dist.mjs` will verify all three generated outputs.

For `dist/`, checks assert:

- `bin/cli.js` exists and is executable.
- `package.json` exposes `nams-hooks` at `./bin/cli.js`.
- `npm pack --dry-run dist` includes the runtime package files.
- marketplace metadata, local project configs, source templates, and OpenAPI
  artifacts are absent.

For `dist-marketplace/`, checks assert:

- marketplace roots and plugin manifests exist for all supported platforms.
- every self-contained platform bundle has executable `bin/cli.js`.
- marketplace hook commands call bundled runtime paths.
- marketplace hook commands do not call the global `nams-hooks` executable.
- plugin directory names are explicit:
  `claude-nams-hooks`, `codex-nams-hooks`, `gemini-nams-hooks`, and
  `opencode-nams-hooks`.
- package placeholders are fully rendered.
- OpenAPI artifacts are absent.

For `dist-local/`, checks assert:

- local project configuration exists for all supported platforms.
- local hook commands intentionally call `nams-hooks`.
- compiled runtime files are absent.
- marketplace metadata is absent.
- generated files are symlinkable or copyable into project roots without
  depending on repository source paths.

The check script should reuse manifest metadata where useful, but it should
still make independent assertions about the generated files. Build logic says
what to create; check logic proves what was created.

## Script Contracts

`package.json` scripts will use separate commands:

```json
{
  "dist:npm": "node scripts/build-dist.mjs npm",
  "dist:marketplace": "node scripts/build-dist.mjs marketplace",
  "dist:local": "node scripts/build-dist.mjs local",
  "dist": "node scripts/build-dist.mjs all"
}
```

`npm run dist` is the umbrella command. It must remove and recreate all three
dist trees from source. Target-specific scripts may remove only their own output
tree, but they must not leave stale files behind.

`npm run package:check` will continue to run full project verification and then
verify all generated outputs.

## Migration Plan

Existing templates move into the new layout instead of being duplicated:

- `templates/claude/.claude/settings.local.json` becomes
  `templates/local/claude/.claude/settings.local.json`.
- `templates/codex/hooks.json` becomes a local Codex template and is projected
  into a project-shaped local output such as `dist-local/codex/.codex/hooks.json`.
- `templates/opencode/plugins/nams-hooks.js` becomes shared or local depending
  on whether the marketplace projection can use the same shim.
- Existing Claude and Codex marketplace templates move under
  `templates/marketplace/claude/` and `templates/marketplace/codex/`.
- Gemini extension files move under `templates/marketplace/gemini/` when they
  are marketplace-only; shared hook definitions move under `templates/gemini/`
  only if local and marketplace projections both use them.

The current ambiguous Claude marketplace plugin directory
`plugins/nams-hooks/` will be renamed in marketplace output to
`plugins/claude-nams-hooks/`. The installable plugin name may remain
`nams-hooks`; the filesystem folder names are platform-specific to avoid
ambiguous ownership.

The pre-existing untracked path `templates/claude/.claude/.claude` in the
working checkout is not part of this design. Implementation should not delete or
rewrite unrelated untracked user files without explicit permission.

## Testing Plan

Tests should be updated before behavior changes:

- Template tests assert the canonical source templates at their new paths.
- Dist checks assert output presence and absence rules for all three trees.
- Package metadata tests assert the npm package artifact still exposes the
  global `nams-hooks` executable.
- Marketplace tests assert all supported platform bundles are self-contained.
- Local tests assert all local configs depend on an installed `nams-hooks`
  command.

Required verification before completion:

```bash
npm run check
npm run dist
npm run dist:check
```

When distribution scripts or package metadata change, `npm run package:check`
must pass before the implementation is considered complete.

## Documentation Updates

Update `README.md`, `INSTALL.md`, `DEVELOPMENT.md`, and the primary hooks design
doc to distinguish:

- npm package output: `dist/`.
- marketplace release output: `dist-marketplace/`.
- local project configuration output: `dist-local/`.

Documentation should stop describing `dist/` as the combined local development,
marketplace, and npm package tree. Marketplace release pipeline documentation
should identify `dist-marketplace/` as the artifact to publish.

## Open Risks

- Gemini may require root-level extension files. The projection manifest must
  make those exceptional root mappings explicit rather than hiding them inside
  platform-specific copy code.
- OpenCode does not currently have the same marketplace shape as Claude or
  Codex. This design still requires an OpenCode marketplace projection, but the
  implementation may need a platform-specific wrapper while keeping the runtime
  self-contained.
- Moving templates can break docs, tests, or installer references that still use
  old paths. Search-based migration and targeted tests should catch stale paths.

## Approval Record

Approved decisions from brainstorming:

- Use separate scripts: `dist:npm`, `dist:marketplace`, and `dist:local`.
- Keep `npm run dist` as the umbrella command.
- Include OpenCode in both marketplace and local outputs.
- Keep hook/config source files in `templates/`.
- Let the build script fully control where templates land in generated output.
- Use a manifest of template projections so distribution behavior lives in code
  and tests.
