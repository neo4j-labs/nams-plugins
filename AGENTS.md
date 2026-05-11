# AGENTS.md

Guidelines for coding agents working in this repository.

## Project North Star

`nams-hooks` connects local agent harness hooks to the Neo4j Agent Memory Service (NAMS). The runtime should make memory persistence deterministic, dependency-light, and platform-aware while keeping platform-specific behavior behind clear adapter boundaries.

The first implementation path is Gemini CLI on macOS. Claude Code and Codex are part of the broader design, but do not expand their behavior unless the task asks for it.

## Source Of Truth

Read these before changing architecture or behavior:

- `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`
- `docs/superpowers/plans/2026-05-10-walking-skeleton.md`
- `docs/nams-skill.md`
- `docs/nams-openapi.json`

The runtime must not fetch OpenAPI specs, inspect schemas, or discover endpoints while a hook is running. OpenAPI is a build-time concern only.

## Architecture Rules

- `src/cli.ts` is a gateway. It parses the command, platform, and typed `--event`, reads stdin JSON as an opaque object, and dispatches through the platform registry.
- Keep platform-specific code inside `src/platforms/<platform>/`. The platform adapter entrypoint is `src/platforms/<platform>/index.ts`; helper parsers and platform-only utilities live beside it.
- Keep shared contracts in `src/interfaces.ts`. Add new hook events there before wiring platform implementations.
- `invocation.event` is typed. Do not infer hook event names from payload fields such as `hook_event_name`, `hookEventName`, or `event`.
- Use the static adapter registry in `src/platforms/index.ts`; avoid dynamic module discovery.
- Runtime code should use Node built-ins only. Do not add runtime npm dependencies without an explicit design change.
- TypeScript is the source language. Distribution output is generated JavaScript.

## NAMS Behavior

- The hook runner owns deterministic writes to NAMS; agents should not decide whether memory is written.
- Standard user messages are the reliable core memory stream.
- Assistant responses are best-effort where the harness exposes them cleanly.
- Tool logging stores metadata only: tool name, sanitized input, optional step id, status, and duration. Do not persist tool output in v1.
- Do not write hidden chain-of-thought. Reasoning traces may store operational summaries only when exposed safely.
- Do not create entities directly from hooks in v1. Rely on NAMS async entity extraction from stored messages.
- Keep secrets and local state under `.nams/`. Never print API keys to stdout, stderr, logs, or test output.
- Gemini observability logs are session-scoped under `.nams/logs/session-<created-at>-<session-part>.jsonl`. Keep hook events and diagnostics for one session together.
- All log records include `kind`. Hook payload logs use `hook.event`; NAMS REST metadata logs use `nams.request`.
- Gemini debug logs keep user prompt fields visible, but must continue redacting secrets, headers, tokens, request/response bodies, assistant responses, tool outputs, and generic content fields.

## Configuration And State

- Project-level installation is the default.
- `.nams/.env` has priority. Real environment variables are fallback values.
- Do not rely on agent harnesses as mutable session stores. Use harness IDs as keys and persist local mapping state under `.nams/state/`.
- `.nams/`, `.nams/state/`, `.nams/logs/`, and generated local artifacts must stay out of normal source changes.

## Build And Distribution

- `devel` is the source branch.
- `master` is the future generated release branch.
- `dist/` is generated and ignored on `devel`.
- `npm run build` compiles TypeScript into `.build/tsc` for local verification.
- `npm run dist` creates a Gemini-linkable extension tree under `dist/`.
- In the generated extension, compiled runtime files live under `dist/bin/`.
- Gemini root files are produced from `templates/gemini/`.
- Do not hand-edit generated `dist/` output as a source change.
- GitHub Actions `Build` runs on pull requests, pushes to `devel`, and manual dispatch. It runs `npm run build`, `npm test`, and `npm run openapi:test`.

## Testing Rules

- Use Node's built-in `node:test` runner.
- Add or update tests before changing behavior.
- Run `npm run check` before claiming the work is complete.
- Tests that touch the filesystem must create fixtures under the OS temp directory and clean them up.
- Tests must not leave `.nams/`, logs, state, or generated hook output in the repository directory.
- Avoid network calls in tests. Use `docs/nams-openapi.json` or mocks unless the task explicitly targets OpenAPI fetching.

## Development Workflow

- Prefer small, focused changes that preserve the existing adapter boundaries.
- Use `rg` to inspect code and docs.
- Respect unrelated user changes in the worktree. Do not revert or rewrite files outside the task.
- Keep docs and code ASCII unless an existing file clearly uses another character set.
- Update design docs when a decision changes the architecture, release model, or platform contract.
- Mark plan tasks complete when executing an existing plan.

## Useful Commands

```bash
npm run build
npm test
npm run check
npm run openapi:test
npm run dist
```

For Gemini local distribution testing, build first and then link the generated extension directory:

```bash
npm run dist
gemini extensions link ./dist
```

## Things To Avoid

- Runtime OpenAPI discovery.
- New runtime dependencies.
- Platform payload parsing in `cli.ts`.
- Implicit hook event inference from stdin JSON.
- Writing test artifacts into the project root.
- Capturing raw tool outputs.
- Logging secrets.
- Editing generated distribution files instead of their source templates or TypeScript inputs.
