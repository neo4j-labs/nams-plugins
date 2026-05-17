# TypeScript Test Runner Design

Date: 2026-05-16
Status: Draft design
Repository: nams-hooks

## Summary

`nams-hooks` should keep Node's built-in `node:test` runner while moving repository tests from JavaScript to TypeScript. Tests will be authored as `.ts` files and executed through the dev-only `tsx` loader so the suite remains compatible with Node `>=20`.

This preserves the existing test style and avoids a Jest migration. Production runtime and generated release artifacts remain plain JavaScript with no runtime npm dependencies. `tsx` is a development dependency only and must not appear in `dependencies`, generated `dist/bin/`, runtime imports, or target-project hook requirements.

## Source Inputs

- Approved hook architecture: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- OpenAPI client build design: `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`
- Pre-migration project config: `package.json`, `tsconfig.json`, and `test/**/*.test.js`
- User preference: keep Node `>=20`, author tests in TypeScript, use `tsx` with `node:test`
- TypeScript unit testing article shared by the user: `https://www.testim.io/blog/typescript-unit-testing-101/`
- Node TypeScript execution guidance: `https://nodejs.org/learn/typescript/run`
- `tsx` documentation: `https://tsx.hirok.io/`

## Pre-Migration State

Before this migration, the repository kept production TypeScript under `src/` and JavaScript tests under `test/`.

`tsconfig.json` included only `src/**/*.ts`, so the normal TypeScript build emitted production runtime files to `.build/tsc`. The test command ran JavaScript tests directly:

```bash
node --test test/*.test.js test/**/*.test.js
```

Many tests dynamically imported compiled files from `.build/tsc`, for example `.build/tsc/runtime/memory-service.js`. This meant test execution depended on a successful build and mostly validated emitted JavaScript. That had useful distribution parity, but it also meant tests were not type-checked as tests, test imports were noisier than source imports, and test fixtures/helpers could not share TypeScript types directly.

## Goals

- Author repository tests and test support files in TypeScript.
- Keep Node's built-in `node:test` runner and `node:assert/strict` assertion style.
- Keep package compatibility at Node `>=20`.
- Use `tsx` as a dev-only TypeScript execution layer for tests.
- Keep runtime source, generated client source, release output, and hook templates free of runtime npm dependencies.
- Add explicit type-checking for test files because `tsx` transpiles TypeScript for execution and does not replace `tsc`.
- Preserve coverage of compiled CLI and distribution-sensitive behavior where it matters.
- Keep `npm run check` as the default verification target.

## Non-Goals

- Switching to Jest, `ts-jest`, Mocha, Vitest, or another test framework.
- Requiring Node 22 or newer to run tests.
- Using Node's native TypeScript type stripping as the primary test execution path.
- Adding runtime dependencies.
- Changing hook runtime behavior.
- Rewriting generated `dist/` output by hand.

## Recommended Approach

Use `tsx` as the TypeScript execution bridge for Node's built-in test runner:

```bash
node --import=tsx --test test/*.test.ts test/**/*.test.ts
```

This keeps the runner as `node:test` while allowing `.ts` test files on Node 20. `tsx` remains a development tool and should be installed in `devDependencies`.

Because runtime execution through `tsx` does not type-check tests, add a dedicated test type-check target. The repository should keep `npm run build` focused on production runtime output and add a separate test TypeScript config that includes source and tests without emitting JavaScript.

The expected command shape is:

```bash
tsc -p tsconfig.test.json
```

`npm run check` should run:

1. `npm run openapi:generate`
2. `npm run build`
3. the test type-check target
4. `npm test`

This keeps OpenAPI client generation, production compilation, test type safety, and test execution as separate, readable gates.

## Alternatives Considered

### Compile Tests With `tsc`, Then Run Emitted JavaScript

Tests could be compiled into `.build/test` and executed with `node --test` against emitted JavaScript. This would preserve Node-only execution and avoid `tsx`, but it adds another build output tree and gives a slower edit-test loop. The user explicitly prefers `tsx` with `node:test`, so this is not the chosen path.

### Switch To Jest With `ts-jest`

The shared article demonstrates a common Jest and `ts-jest` workflow. That would support TypeScript-authored tests, but it would replace the current runner, add more test-framework surface area, and move away from the repository's existing `node:test` convention. The project does not need Jest-specific mocking, snapshotting, globals, or watch behavior for this migration.

### Use Node Native TypeScript Execution

Newer Node versions can execute erasable TypeScript syntax directly, but the repository supports Node `>=20`. Relying on that feature would either raise the minimum Node version or create version-specific test behavior. `tsx` gives a consistent Node 20-compatible path.

## Test Layout And Imports

Rename existing tests from `.js` to `.ts`, including nested platform tests and support helpers.

Most unit and adapter tests should import source modules directly from `src/` using normal TypeScript imports. Because the project uses `module` and `moduleResolution` `NodeNext`, local import specifiers should keep `.js` extensions even when importing `.ts` source files. This matches the production source style and lets TypeScript resolve to `.ts` during type-checking while emitted JavaScript keeps valid ESM specifiers.

Example:

```ts
import { NamsMemoryService } from "../src/runtime/memory-service.js";
```

Tests that intentionally verify the compiled CLI command path may continue to execute `.build/tsc/cli.js` after `npm run build`. Those tests are distribution-sensitive and should keep exercising emitted JavaScript where the behavior under test is the runnable command artifact.

Architecture tests should continue to inspect source files under `src/`. If they need to inspect test files after the migration, they should inspect `.ts` files directly.

## Configuration

Add `tsx` to `devDependencies`.

Add a test TypeScript config such as `tsconfig.test.json`. It should extend the production config or mirror its relevant compiler options, include `src/**/*.ts` and `test/**/*.ts`, and use `noEmit` for type checking.

Add `test/tsconfig.json` as a thin editor-facing config that extends `../tsconfig.test.json`. This lets TypeScript language servers attach open test files to the same Node-aware test project that `npm run test:typecheck` uses, without broadening the production build config.

The production `tsconfig.json` should continue to include only `src/**/*.ts`. This avoids accidentally emitting tests into production build output or generated release artifacts.

Package scripts should make the new responsibilities explicit:

- `build`: compile production TypeScript to `.build/tsc`
- `test:typecheck`: type-check source plus tests without emitting
- `test`: run `.ts` tests through `node:test` with `tsx`
- `check`: run OpenAPI generation, production build, test type-check, and test execution
- generated client tests: continue to run through `test/nams-client-generator.test.ts` as part of `npm test`

Do not use `npx` in package scripts. `tsx` should be a declared dev dependency, and npm scripts automatically place local binaries and packages on the execution path. Avoiding `npx` prevents accidental package fetching or prompts during deterministic verification.

## Data Flow

Normal verification should flow as:

```text
docs/nams-openapi.json
  -> openapi:generate

src/**/*.ts
  -> npm run build
  -> .build/tsc

src/**/*.ts + test/**/*.ts
  -> npm run test:typecheck

test/**/*.test.ts
  -> node --import=tsx --test
  -> source imports from src/**/*.ts
  -> selected CLI tests execute .build/tsc/cli.js
```

The runtime hook path remains unchanged:

```text
src/**/*.ts
  -> npm run dist
  -> dist/bin/**/*.js
  -> target project hook execution
```

`tsx` participates only in local development and automated tests.

## Error Handling And Compatibility

If a developer runs `npm test` before `npm install`, the command should fail in the usual npm way because `tsx` is missing. It should not fetch dependencies implicitly.

If a developer runs `npm test` before `npm run build`, most source-importing tests should still execute. Tests that intentionally execute `.build/tsc/cli.js` require compiled output. The default `npm run check` preserves the safe order by building before running the suite.

Node 20 compatibility is preserved by using `tsx` instead of Node's newer built-in TypeScript execution path. CI and local development should continue to run under the package's declared `engines.node` range.

## Testing Strategy

The migration itself should be verified by:

- `npm run test:typecheck`
- `npm test`
- `npm run check`

Existing behavioral tests should remain equivalent after renaming and import cleanup. Any failures during migration should be treated as migration errors unless the TypeScript type-check step exposes a real bug in a test fixture or source contract.

Add no new behavioral runtime features as part of this migration. The desired observable change is the test authoring and execution model, not hook behavior.

## Acceptance Criteria

- All existing `.js` tests and test support files are migrated to `.ts`.
- `npm test` runs TypeScript tests through `tsx` and Node's built-in test runner.
- Tests import source TypeScript directly except where compiled CLI output is intentionally under test.
- `npm run test:typecheck` type-checks source and tests.
- `npm run check` runs OpenAPI generation, production build, test type-check, and the full TypeScript test suite.
- Generated NAMS client tests still validate the generated client workflow as part of `npm test`.
- `dependencies` remains free of test tooling.
- Runtime source and generated release artifacts do not import or require `tsx`.
