# Live Platform Validation Design

Date: 2026-06-09
Status: Draft design pending written-spec review
Repository: nams-hooks

## Summary

`nams-hooks` needs an explicit live validation suite that exercises real agent
platform CLIs against the generated hook runtime. The suite is an extended smoke
test, not a replacement for `npm run check`: it verifies that current Codex and
Claude Code releases still load project-local hooks, trigger the expected hook
lifecycle on Linux, create local NAMS state and logs, and persist a real user and
assistant exchange to an existing NAMS workspace.

The first implementation is a separate Maven project under `live-tests/`. Maven,
JUnit 5, Testcontainers, and REST-assured own orchestration and assertions. Node
is required inside platform containers to run the generated hook runtime, but the
test orchestrator itself is Java. The suite consumes `dist/` and `dist-local/`
from `npm run dist` as the artifacts under test.

## Source Inputs

- Approved hook architecture:
  `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- OpenAPI client build design:
  `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`
- Workspace ID design:
  `docs/superpowers/specs/2026-06-03-nams-workspace-id-design.md`
- Codex memory-flow design:
  `docs/superpowers/specs/2026-05-12-codex-memory-flow-design.md`
- Claude Code memory-flow design:
  `docs/superpowers/specs/2026-05-12-claude-memory-flow-design.md`
- Runtime install and local testing docs: `INSTALL.md`, `DEVELOPMENT.md`
- Local Linux platform research: `docs/platform-hooks-linux-support.md`
- Pinned NAMS OpenAPI contract: `docs/nams-openapi.json`
- Codex CLI command reference:
  `https://developers.openai.com/codex/cli/reference`
- Claude Code CLI and environment reference:
  `https://code.claude.com/docs/en/cli-reference`,
  `https://code.claude.com/docs/en/env-vars`,
  `https://code.claude.com/docs/en/authentication`

## Goals

- Provide local-first live validation for Codex and Claude Code on Linux Docker.
- Exercise project-local hook configuration, not marketplace installation.
- Treat `dist/` and `dist-local/` as generated artifacts under test.
- Use committed, reviewable Dockerfiles for platform images.
- Fail fast when live NAMS credentials or workspace preflight are invalid.
- Verify local `.nams` state and JSONL logs for each platform run.
- Verify NAMS persistence of a unique user prompt and assistant response.
- Keep live tests out of `npm run check` and normal unit/integration tests.
- Leave CI scheduling and GitHub Actions integration for a later design/update.

## Non-Goals

- Marketplace, plugin marketplace, or extension install validation.
- Gemini, OpenCode, or other platform coverage in v1.
- macOS, Windows, or host-installed platform validation.
- Mock NAMS mode for the live suite.
- Entity extraction, memory quality, or async derived-memory validation.
- A Java NAMS SDK. REST-assured usage stays focused on live assertions.
- Runtime OpenAPI discovery or schema inspection inside hooks.
- Adding runtime npm dependencies to `nams-hooks`.

## Decisions

### Scope

The first platform matrix is:

- `codex`
- `claude`

Both use project-local hook configuration. This validates real platform hook
behavior while avoiding marketplace installation prompts, review flows, and
repository marketplace concerns.

### Test Orchestrator

The live suite lives in `live-tests/` as a standalone Maven project. It uses:

- JUnit 5 for test lifecycle and assertions.
- Testcontainers for Docker image build, container lifecycle, command execution,
  mounted files, and diagnostics.
- REST-assured for NAMS preflight and persistence assertions.
- Plain Java JSON parsing or a small test-only JSON dependency if it materially
  reduces test noise.

The expected local command sequence is:

```bash
npm run dist
cd live-tests
mvn test
```

Maven fails if `../dist/bin/cli.js` and the platform hook templates needed by
the scenario are not present under `../dist-local/`.

### Container Images

The repository commits platform Dockerfiles:

```text
live-tests/
  docker/
    codex/Dockerfile
    claude/Dockerfile
```

The Dockerfiles install Linux, Node.js, and the real platform CLI. Testcontainers
builds the images locally. Docker layer caching, local build cache, or future
GitHub Actions cache can make repeated runs faster, but the source of the image
definition remains reviewable in this repository.

Each platform test prints or records the platform CLI version during setup. CLI
version drift should fail as a clear platform preflight or scenario failure, not
as a vague missing-log assertion.

### NAMS Workspace

The suite uses an existing active NAMS workspace connected to the supplied key.
Required inputs are:

- `NAMS_API_KEY`
- `NAMS_WORKSPACE_ID`

Optional input:

- `NAMS_BASE_URL`, defaulting to `https://memory.neo4jlabs.com`

Missing required inputs are hard failures. Before starting a platform container,
the suite calls `GET /v1/workspace` with:

- `Authorization: Bearer <NAMS_API_KEY>`
- `X-Workspace-Id: <NAMS_WORKSPACE_ID>`

If the workspace does not exist, is unauthorized, cannot be validated, or returns
an `id` different from `NAMS_WORKSPACE_ID`, the test fails immediately.

### Platform Authentication

The suite also requires real platform authentication because v1 validates
assistant-message persistence after a real platform response.

Codex required input:

- `OPENAI_API_KEY`

The Codex container logs in non-interactively before the scenario:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
codex login status
```

Claude Code required input is one of:

- `ANTHROPIC_API_KEY`, for direct Anthropic API-key usage
- `ANTHROPIC_AUTH_TOKEN`, for a gateway or proxy bearer token
- `CLAUDE_CODE_OAUTH_TOKEN`, for a long-lived token generated by
  `claude setup-token`

The Claude container preflights authentication with:

```bash
claude auth status
```

Missing platform credentials are hard failures for that platform's test. The
test harness must pass only the credentials needed by the current platform
container and must include all platform credentials in the central redaction set.

## Architecture

`npm run dist` remains responsible for compiling TypeScript and assembling the
generated distribution trees. The Maven suite treats both `dist/` and
`dist-local/` as immutable input.

The live harness owns these concerns:

- platform image build and startup
- disposable project and HOME setup inside containers
- project-local hook config installation
- platform CLI invocation
- collection of stdout, stderr, exit codes, state files, and logs
- NAMS REST preflight and persistence assertions

The generated hook runtime still owns actual memory behavior. The live harness
does not import TypeScript modules, call platform adapters directly, or inspect
OpenAPI at runtime.

The live test installs the generated npm package from `dist/` inside the
platform container:

```bash
npm install -g /nams-hooks/dist
```

The project-local configuration remains exactly the generated `dist-local/`
configuration. The harness mounts `dist-local/` read-only and creates project
symlinks to the relevant platform folder, for example:

```text
/workspace/project/.codex  -> /nams-hooks/dist-local/codex/.codex
/workspace/project/.claude -> /nams-hooks/dist-local/claude/.claude
```

The tests should not rewrite generated hook commands. Before running a platform
scenario, the harness preflights the installed `nams-hooks` command with a
minimal JSON payload in a disposable HOME/project so global install or command
resolution failures are reported before the platform CLI starts.

## Project Layout

```text
live-tests/
  pom.xml
  docker/
    codex/
      Dockerfile
    claude/
      Dockerfile
  src/test/java/
    .../NamsLiveClient.java
    .../PlatformContainer.java
    .../ProjectFixture.java
    .../LogAssertions.java
    .../CodexProjectHooksLiveTest.java
    .../ClaudeProjectHooksLiveTest.java
```

Java test sources use the package prefix `com.neo4jlabs.nams`. Common live-test
support stays shared, while platform-specific CLI flags and fixture details stay
in platform scenario code.

## Components

### Maven Project

`live-tests/pom.xml` defines the Java test suite. It is not wired into
`npm run check`. It may define a Maven profile later for CI, but v1 is local
first and runs with `mvn test`.

### NamsLiveClient

`NamsLiveClient` is a small REST-assured wrapper. It provides only the operations
needed by the live assertions:

- validate the configured workspace
- list messages for the conversation ID created by the hook runtime
- verify role-specific user and assistant persistence

It should not become a complete NAMS SDK.

### PlatformContainer

`PlatformContainer` builds and starts a per-platform Testcontainer. It handles:

- image build from the committed Dockerfile
- environment variables for NAMS credentials
- environment variables for the current platform credential
- mounting `dist/` and `dist-local/`
- installing `dist/` globally with npm inside the container
- command execution with timeouts
- version/preflight command execution
- stdout, stderr, exit-code capture
- safe diagnostics on failure

### ProjectFixture

`ProjectFixture` creates disposable container paths:

- a clean project directory
- a clean HOME
- project-local `.nams/` config only when useful for the scenario
- project-local `.codex` or `.claude` symlink pointing at generated
  `dist-local/<platform>/` configuration

The runtime `.nams/state/<platform>/` and `.nams/logs/<platform>/` files should
land under the disposable HOME. Test artifacts must not be written to the source
repository.

### Platform Scenarios

Each platform scenario owns the exact CLI invocation needed to trigger hooks
non-interactively.

Codex uses `codex exec`, the non-interactive Codex command. The scenario should
enable hooks for the invocation and bypass persisted hook trust because the
fixture has already written the hook file being tested:

```bash
codex exec \
  --cd /workspace/project \
  --enable hooks \
  --dangerously-bypass-hook-trust \
  --ask-for-approval never \
  --sandbox workspace-write \
  --output-last-message /workspace/project/.live-tests/codex-answer.txt \
  "<unique prompt>"
```

The exact sandbox mode can be tightened during implementation if the prompt does
not require filesystem writes. `--dangerously-bypass-hook-trust` is deliberately
scoped to this isolated container smoke test; v1 validates hook execution, not
Codex's interactive hook-review UX.

Claude Code uses print mode and stream JSON output so hook lifecycle events can
be diagnosed directly from stdout:

```bash
claude -p \
  --output-format stream-json \
  --verbose \
  --include-hook-events \
  --permission-mode dontAsk \
  --setting-sources user,project,local \
  "<unique prompt>"
```

If a platform cannot produce an answer through the chosen invocation, that is a
scenario failure for v1 because the extended smoke target includes
assistant-message persistence.

### LogAssertions

`LogAssertions` parses JSONL files from `.nams/logs/<platform>/`. It verifies:

- at least one `hook.event` record exists for the run
- NAMS request records exist for the relevant persistence flow
- configuration diagnostics are present when expected
- no API key or bearer token appears in logs

It can also extract a conversation ID from state or from logged NAMS request and
response records when needed for REST assertions.

## Data Flow

For each platform:

1. JUnit verifies `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and the current
   platform's credential input are present.
2. REST-assured calls `GET /v1/workspace`.
3. The test fails fast if workspace validation fails.
4. Testcontainers starts the platform container.
5. The test checks the platform CLI version and platform authentication inside
   the container.
6. The test creates a clean project directory and HOME inside the container.
7. The test mounts `dist/` and `dist-local/` under `/nams-hooks/`.
8. The test installs project-local hook config:
   - `npm install -g /nams-hooks/dist` installs the generated runtime package.
   - Codex: project `.codex` symlink points to
     `/nams-hooks/dist-local/codex/.codex`.
   - Claude Code: project `.claude` symlink points to
     `/nams-hooks/dist-local/claude/.claude`.
9. The test runs the platform CLI with a unique marker prompt.
10. The test captures process exit code, stdout, and stderr.
11. The test reads `.nams/logs/<platform>/session-*.jsonl`.
12. The test reads `.nams/state/<platform>/session-*.json`.
13. The test extracts the NAMS `conversationId` from session state. If state is
    missing the ID, it may fall back to the `createConversation` response in
    `nams.request` logs.
14. REST-assured lists `GET /v1/conversations/{id}/messages`.
15. REST-assured verifies the user prompt was persisted in that conversation.
16. REST-assured verifies an assistant message for the run was persisted in that
    conversation.

The unique marker should include platform, timestamp, and random UUID, for
example:

```text
nams-hooks-live codex 2026-06-09T12:34:56Z 018f9f77-...
```

This prevents old workspace data from satisfying current assertions.

## NAMS Assertions

The live tests should prefer deterministic message assertions over async entity
or memory-quality assertions.

The minimum success condition is:

- the workspace preflight passed
- a conversation associated with the run can be identified
- a user message containing the unique marker can be retrieved
- an assistant message associated with the same run/conversation can be
  retrieved

If a platform run exits successfully but no assistant answer is visible locally,
the test should fail because v1 is explicitly an extended smoke test for the
complete user/assistant lifecycle.

Conversation lookup is deterministic. The primary source is the
`conversationId` saved under `.nams/state/<platform>/session-*.json`. The
fallback source is the logged `createConversation` NAMS response. Workspace-wide
message search is not part of v1 because the NAMS API surface used by hooks is
conversation scoped.

## Error Handling

The suite should fail loudly and early, but with useful sanitized diagnostics.

Hard failures include:

- missing required NAMS inputs
- missing platform credentials for the platform under test
- workspace preflight failure
- missing `dist/` or `dist-local/` artifact
- platform CLI missing or version preflight failure
- platform authentication preflight failure
- generated package install or `nams-hooks` command preflight failure
- platform CLI prompt scenario exits unsuccessfully
- no assistant answer visible in the platform CLI result
- missing `.nams/logs/<platform>/session-*.jsonl`
- missing `.nams/state/<platform>/session-*.json`
- no NAMS conversation ID or no message match for the unique marker
- assistant answer produced locally but no assistant message persisted
- API key or bearer token found in logs

On failure, diagnostics should include:

- platform and CLI version
- scenario command exit code
- scenario stdout and stderr
- names of `.nams` log and state files
- sanitized relevant JSONL entries
- REST status/body for failed NAMS assertions, redacted when needed

Timeouts should be explicit:

- short timeout for workspace preflight
- short timeout for CLI version checks
- moderate timeout for platform prompt execution
- bounded polling for NAMS message visibility

The test should not wait for entity extraction or derived memory state.

## Security And Secret Handling

The Java harness and container commands must not print `NAMS_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or
`CLAUDE_CODE_OAUTH_TOKEN`.

Diagnostics must redact:

- `Authorization` headers
- bearer tokens
- raw API keys and OAuth tokens
- any environment dump containing known secret variable names
- all configured secret values, not just fixed variable-name patterns

The `.nams` files created by the runtime should retain the runtime's owner-only
permission behavior. The live test can assert absence of secrets in logs, but it
does not need to enforce every filesystem mode in v1 unless that becomes a live
regression concern.

## Local Usage

The initial local workflow is:

```bash
export NAMS_API_KEY=...
export NAMS_WORKSPACE_ID=...
export NAMS_BASE_URL=https://memory.neo4jlabs.com
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
# or export ANTHROPIC_AUTH_TOKEN=...
# or export CLAUDE_CODE_OAUTH_TOKEN=...

npm run dist
cd live-tests
mvn test
```

`NAMS_BASE_URL` is optional. Claude requires one supported Claude credential,
not every Claude credential shown above. Required inputs are intentionally not
skipped. A developer who runs the live suite without secrets should get an
immediate failure explaining which inputs are missing.

## Future Extensions

Future work can add:

- CI workflow dispatch or scheduled runs
- image layer caching in GitHub Actions
- Gemini and OpenCode live scenarios
- per-run workspace creation if NAMS exposes a fully active workspace creation
  flow
- optional marketplace-install validation jobs
- richer platform version compatibility reporting
- async entity or memory-search assertions if they become stable enough for live
  smoke tests
