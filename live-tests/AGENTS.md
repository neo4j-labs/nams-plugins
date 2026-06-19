# AGENTS.md

Guidelines for coding agents working in `live-tests/`.

## Direction

`live-tests` is a local-first extended smoke-test harness for validating
`nams-hooks` against real agent platform CLIs. It is intentionally separate from
the normal Node test suite: use Maven, JUnit 5, Testcontainers, and REST-assured
here, while the main project continues to use Node's built-in test runner.

The live suite validates generated artifacts, not TypeScript internals:

- Build `dist/` and `dist-local/` from the repo root before running live tests.
- Mount `dist/` and `dist-local/` into platform containers read-only.
- Install `nams-hooks` from the mounted `dist/` package inside the container.
- Link project-local platform configuration from `dist-local/`.
- Do not hand-edit generated `dist/` or `dist-local/` content as a fix.

Project-local hook configuration is the point of these tests. Do not switch live
tests to marketplace, extension-store, or interactive installation flows unless a
new design explicitly asks for it.

## Credentials And Secrets

Live tests use real credentials and a real existing NAMS workspace. Load them
through environment variables or `live-tests/.env`; never commit `.env`, print
secrets, or include raw env lines in assertion messages.

Required NAMS inputs are:

- `NAMS_API_KEY`
- `NAMS_WORKSPACE_ID`

Platform tests should pass only the credential variables required by that
platform. Missing credentials should fail or skip according to the current test
contract for that platform, but must never result in an interactive prompt.

## Prompt Execution

Use platform CLIs only far enough to trigger project-local hooks and obtain a
binary result: response produced or command failed. Keep prompts short,
deterministic, and cheap.

When a platform command invokes a real model from inside a container:

- Pin the cheapest practical model for that platform.
- Pin low reasoning, low thinking, or the closest equivalent.
- Centralize those options in a small platform helper so future tests cannot
inherit expensive user defaults by accident.

For Codex, use `CodexCli.exec(...)`; it pins `gpt-5.4-mini` and
`model_reasoning_effort=low`.

## Adding A New Platform Test

Add platforms incrementally. Prefer one small passing slice before adding deeper
NAMS assertions.

1. Add `live-tests/docker/<platform>/Dockerfile`.
   Keep it simple, Linux-only, and install the real platform CLI plus Node if the
   platform image does not already include it.

2. Add or reuse a Testcontainers wrapper.
   Mount generated `dist/`, generated `dist-local/`, disposable HOME, and
   disposable project directories. Keep generated artifact mounts read-only.

3. Add a container smoke test.
   Verify the platform CLI is installed and that a minimal non-interactive
   command produces either a response or a clear auth/runtime error.

4. Add an install/config test.
   Install `nams-hooks` from mounted `dist/`, link the platform's project-local
   config from `dist-local/`, preflight the installed hook command, authenticate
   non-interactively, run one tiny prompt, and assert the answer file or stdout
   contains a unique marker.

5. Add NAMS verification only after the platform run is stable.
   Preflight that the configured workspace exists before starting the platform
   scenario, then assert that the unique conversation or message marker appears
   through the NAMS REST API.

6. Keep platform-specific details isolated.
   Put model flags, trust flags, auth commands, hook event flags, and CLI quirks
   in platform-specific helpers or tests. Do not make Codex assumptions leak into
   Claude Code, or vice versa.

## Verification

Never skip test!!

Useful commands from the repo root:

```bash
npm run dist
```

Useful commands from `live-tests/`:

```bash
mvn test
mvn test -Dtest=CodexContainerSmokeTest
mvn test -Dtest=CodexNamsInstallLiveTest
```

Run the narrow test for the platform you changed, then run `mvn test` before
claiming the live-test harness is passing.
