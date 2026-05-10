# NAMS OpenAPI Client Build Design

Date: 2026-05-10
Status: Approved design
Repository: nams-hooks

## Summary

`nams-hooks` will be authored in TypeScript and released as plain JavaScript. A build-time OpenAPI workflow fetches the latest NAMS API contract, generates a small typed client for the endpoints used by the hook runtime, runs contract tests against the generated client, and produces an installable release artifact.

The hook runtime must never resolve OpenAPI, inspect schemas, or discover endpoints while an agent is running. Runtime code imports a generated JavaScript client from `dist/`.

## Goals

- Keep runtime deterministic and dependency-light.
- Use TypeScript for maintainable source code and generated client types.
- Generate a focused NAMS REST client from the pinned OpenAPI spec.
- Commit generated source on the development branch.
- Release compiled JavaScript on the distribution branch.
- Support `gemini extensions install https://github.com/neo4j-labs/nams-hooks` without a user-side build step.
- Keep Codex and Claude installation available through a released CLI package.

## Non-Goals

- Runtime OpenAPI endpoint discovery.
- Full SDK generation for every NAMS endpoint.
- Heavyweight OpenAPI generators that introduce large generated runtimes.
- User-side TypeScript compilation during Gemini extension install.
- Hand-editing release artifacts on the distribution branch.

## Research Notes

TypeScript is a valid fit because it emits JavaScript to an output directory. The published runtime can be plain JavaScript while TypeScript remains a build-time tool.

npm supports executable CLIs through `package.json#bin`, and package contents can be controlled through `package.json#files`. This fits Codex and Claude installation through a packaged CLI.

Gemini CLI extensions can be installed from a GitHub URL or local path. Gemini copies the extension directory on install, and extension hooks live in `hooks/hooks.json`. Extension config supports `${extensionPath}`, which lets hooks call files bundled inside the installed extension directory. Therefore, the default GitHub branch used for Gemini install must already contain runnable JavaScript.

## Branch Model

Use a GitHub Pages-style branch split:

- `devel`: source branch
- `master`: generated release/distribution branch

### `devel`

The `devel` branch contains source and build inputs:

```text
src/
  cli.ts
  hook-runtime/
  generated/
    nams-client.ts
  generator/
    generate-nams-client.ts
test/
  contract/
docs/
  nams-openapi.json
  nams-skill.md
  superpowers/specs/
templates/
  gemini/
    gemini-extension.json
    hooks/
      hooks.json
package.json
tsconfig.json
```

The generated TypeScript client, `src/generated/nams-client.ts`, is committed on `devel`. This makes API drift visible in normal code review.

### `master`

The `master` branch is release-only. It contains runnable artifacts:

```text
gemini-extension.json
hooks/
  hooks.json
dist/
  cli.js
  hook-runtime/
  generated/
    nams-client.js
docs/
  nams-openapi.json
README.md
package.json
```

No source edits happen directly on `master`. A release script replaces the branch contents from a validated build on `devel`.

## Runtime Package Shape

The released CLI exposes `nams-hooks` through `package.json#bin`:

```json
{
  "bin": {
    "nams-hooks": "./dist/cli.js"
  }
}
```

The CLI entry point supports typed hook event dispatch:

```bash
nams-hooks run gemini --event SessionStart
nams-hooks run claude --event SessionStart
nams-hooks run codex --event SessionStart
nams-hooks install --harness claude,codex
nams-hooks doctor
```

`dist/cli.js` is a gateway. It reads stdin as opaque JSON and does not interpret platform-specific fields. It validates the typed `--event`, resolves the platform adapter from a static registry, and dispatches to the interface method for that event. Platform adapters own JSON interpretation for Gemini, Claude, and Codex.

Hook runtime modules import the compiled generated client:

```js
import { NamsClient } from "./generated/nams-client.js";
```

They do not import or read `docs/nams-openapi.json`.

## Gemini Distribution

Gemini users install from the release branch:

```bash
gemini extensions install https://github.com/neo4j-labs/nams-hooks
```

Pinned install:

```bash
gemini extensions install https://github.com/neo4j-labs/nams-hooks --ref v0.1.0
```

`gemini-extension.json` declares extension metadata and settings for NAMS configuration, including sensitive API-key configuration where supported:

```json
{
  "name": "nams-hooks",
  "version": "0.1.0",
  "description": "Neo4j Agent Memory Service hooks for Gemini CLI",
  "settings": [
    {
      "name": "NAMS API Key",
      "description": "API key for Neo4j Agent Memory Service.",
      "envVar": "NAMS_API_KEY",
      "sensitive": true
    }
  ]
}
```

`hooks/hooks.json` calls the compiled CLI using `${extensionPath}`:

```json
{
  "hooks": {
    "BeforeAgent": [
      {
        "command": "node",
        "args": ["${extensionPath}/dist/cli.js", "run", "gemini", "--event", "SessionStart"]
      }
    ]
  }
}
```

The exact Gemini hook events will be finalized during implementation against the current Gemini hook reference, but all hook commands must target compiled files in `dist/`.

On `devel`, these Gemini files live under `templates/gemini/` with the other platform templates. `npm run dist` creates a Gemini-linkable extension tree in `dist/` by compiling TypeScript, copying `templates/gemini/gemini-extension.json` to `dist/gemini-extension.json`, and copying `templates/gemini/hooks/hooks.json` to `dist/hooks/hooks.json`. The future `master` release tree will use the same root layout because Gemini expects those paths at extension root.

For now, `dist/` is Gemini-only. Claude and Codex templates remain source templates on `devel` and are not copied into the local Gemini distribution folder.

## Codex And Claude Distribution

Codex and Claude use the CLI installer:

```bash
npm install -g @neo4j/nams-hooks
nams-hooks install --harness codex,claude
```

For GitHub-based testing:

```bash
npm install -g github:neo4j-labs/nams-hooks#v0.1.0
```

The installer writes project-level hook configuration that calls the installed `nams-hooks` CLI, not source files.

## OpenAPI Workflow

Build targets:

- `openapi:fetch`: fetch `https://memory.neo4jlabs.com/openapi.json` and write `docs/nams-openapi.json`
- `openapi:generate`: read `docs/nams-openapi.json` and write `src/generated/nams-client.ts`
- `build`: compile TypeScript to `.build/tsc` for local tests
- `dist`: create a clean Gemini-linkable extension tree in `dist/`; compiled runtime lives under `dist/dist/`, and Gemini root files live at `dist/gemini-extension.json` and `dist/hooks/hooks.json`
- `test:contract`: run contract tests against generated code and the pinned spec
- `package:check`: run generation, fail on stale generated output, build, and test
- `release:prepare`: create a release tree for `master`

`openapi:fetch` is the only target that needs network access. Hook runtime and normal tests use the pinned local spec.

## Custom Generator Scope

The generator is intentionally small and NAMS-specific. It generates methods only for endpoints used by hooks:

- `createConversation`
- `addMessage`
- `addMessagesBulk`
- `getConversationContext`
- `searchConversationMessages`
- `searchEntities`
- `recordReasoningStep`
- `recordToolCall`
- optional helper methods for entity details or traces if the runtime needs them later

Each generated method includes:

- static HTTP method
- static path template
- typed request body
- typed success response where schema information is available
- normalized error handling
- no runtime dependency on OpenAPI data

The generated client uses Node built-ins only. It should prefer global `fetch` when the package requires a Node version where fetch is stable; otherwise it can use a tiny internal `node:https` transport. The Node version requirement will be set in `package.json#engines`.

## Contract Tests

Contract tests compare the generated client against `docs/nams-openapi.json`.

They must verify:

- required endpoint paths exist in the spec
- generated methods map to the expected HTTP method and path
- request body fields include required fields for supported operations
- generated response typing remains aligned with named schema references where available
- generated client source does not reference `docs/nams-openapi.json`
- mocked successful responses are parsed consistently
- mocked error responses produce stable error objects

Contract tests should fail when:

- an endpoint is removed or renamed
- required request fields change
- generated output is stale after `openapi:generate`
- runtime code attempts OpenAPI inspection

## Release Flow

Manual or CI release flow:

1. Work on `devel`.
2. Run `npm run openapi:fetch`.
3. Run `npm run openapi:generate`.
4. Commit `docs/nams-openapi.json` and `src/generated/nams-client.ts` if they changed.
5. Run `npm run package:check`.
6. Run `npm run release:prepare`.
7. Replace `master` contents with the release tree.
8. Commit the release artifact on `master`.
9. Tag the release commit, for example `v0.1.0`.

Rules:

- `master` is generated from `devel`; no hand edits.
- Release tags are created from `master`.
- Gemini installs default to `master`.
- Codex and Claude npm releases are produced from the same validated artifact.

## Impact On Earlier Hook Design

The prior hook design remains valid with these updates:

- The runtime entry point becomes `dist/cli.js` in release artifacts.
- Installed project hook configs call `nams-hooks run <harness> --event <typed-event>` or the extension-local `dist/cli.js`.
- `.nams/runtime/` is no longer required for package installs.
- `.nams/.env`, `.nams/state/`, and `.nams/logs/` remain project-local runtime data.
- NAMS REST calls go through the generated client instead of handwritten fetch helpers.
- Runtime never reads OpenAPI.

## Open Risks

- Maintaining `master` as generated output requires release discipline and clear automation.
- Gemini extension settings support must be verified against the installed Gemini CLI version.
- If Node versions bundled with agent platforms differ, the package may need either a conservative `engines.node` value or an internal HTTPS transport instead of global `fetch`.
- GitHub install from `master` means any accidental unreleased commit to `master` becomes installable immediately; branch protections should require release automation.

## Approval Record

Approved decisions from brainstorming:

- Use TypeScript for source.
- Release vanilla JavaScript.
- Generate a focused client with a small custom NAMS OpenAPI generator.
- Commit generated client source.
- Do not discover endpoints at runtime.
- Use `devel` for source and `master` for release/distribution.
- Make `master` directly installable by Gemini CLI extensions.
