# NAMS Hooks Live Tests

`live-tests` is a local-first smoke-test subproject for validating generated
`nams-hooks` artifacts against real agent platform CLIs. It is intentionally
separate from the normal Node test suite and uses Maven, JUnit 5,
Testcontainers, and REST-assured to run platform scenarios in Docker.

The suite tests generated release artifacts rather than TypeScript internals:

- `dist/`, the generated npm package installed inside platform containers.
- `dist-local/`, the generated project-local hook configuration linked into
  disposable test projects.
- real NAMS persistence through a configured workspace.

The current live scenario covers Codex. It installs `nams-hooks` in a container,
links the generated Codex project config, runs one small `codex exec` prompt,
and verifies that the resulting conversation exists in NAMS.

## Prerequisites

- Docker running locally.
- Java 25 and Maven.
- Generated artifacts from the repository root:

  ```bash
  npm run dist
  ```

- Live credentials in `live-tests/.env` or the process environment:

  ```bash
  cp live-tests/.env.example live-tests/.env
  ```

  Fill in `OPENAI_API_KEY`, `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, and
  `NAMS_BASE_URL`. Never commit `live-tests/.env`.

## Running Tests

From the repository root, build the generated artifacts first:

```bash
npm run dist
```

Run the full live suite from `live-tests/`:

```bash
cd live-tests
mvn test
```

Run only the Codex live scenario:

```bash
cd live-tests
mvn test -Dtest=CodexNamsLiveTest
```

The tests call real external services and may spend real model/API credits.
They are not part of `npm run check`.
