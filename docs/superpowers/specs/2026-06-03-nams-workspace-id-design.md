# NAMS Workspace ID Design

Date: 2026-06-03
Status: Approved design
Repository: nams-hooks

## Summary

NAMS now requires a workspace ID on every API request through the `X-Workspace-Id` header. `nams-hooks` will treat `workspaceId` as a first-class runtime configuration value, resolved through the same hierarchy as `apiKey`: user-global JSON config, project-local JSON config, then an environment override.

The change stays inside shared runtime boundaries. Platform adapters continue to parse platform payloads and call shared memory services; they do not parse, infer, or store workspace IDs. The generated NAMS client sends the workspace header for every request, keeping request shaping centralized and deterministic.

## Source Inputs

- User-provided NAMS API example requiring `X-Workspace-Id` on `POST /v1/conversations`.
- `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- `docs/superpowers/specs/2026-05-10-nams-openapi-client-build-design.md`
- `docs/superpowers/plans/2026-05-10-walking-skeleton.md`
- `docs/nams-skill.md`
- `docs/nams-openapi.json`
- Live OpenAPI check on 2026-06-03, used only as build-time context. The live spec describes workspace-scoped responses and `workspace_id required` errors but does not model `X-Workspace-Id` as a header parameter.

## Goals

- Send `X-Workspace-Id` with every NAMS request.
- Resolve `workspaceId` through the same convention as `apiKey`.
- Preserve local-over-global workspace selection.
- Keep platform-specific code unaware of workspace configuration details.
- Keep runtime code and generated release artifacts dependency-free.
- Preserve fail-open hook behavior when required NAMS configuration is missing.
- Keep API keys out of logs and diagnostics.

## Non-Goals

- Runtime OpenAPI discovery or schema inspection.
- New platform-specific workspace parsing.
- New project-local state files for workspace selection.
- Per-session workspace IDs in existing session mapping files.
- New runtime npm dependencies.
- Entity creation or broader NAMS API behavior changes.

## Configuration Model

`workspaceId` joins the existing JSON-first config model:

1. Read `~/.nams/config.json`.
2. Overlay `<project>/.nams/config.json`.
3. Overlay environment variables.

Supported JSON keys:

- `apiKey`: required NAMS API key.
- `workspaceId`: required NAMS workspace ID.
- `baseUrl`: optional NAMS base URL.

Supported environment overrides:

- `NAMS_API_KEY`: overrides `apiKey`.
- `NAMS_WORKSPACE_ID`: overrides `workspaceId`.
- `NAMS_BASE_URL`: overrides `baseUrl`.

Example user-global config:

```json
{
  "apiKey": "nams-api-key",
  "workspaceId": "5e5c0535-8d85-491c-b92c-33be13659998",
  "baseUrl": "https://memory.neo4jlabs.com"
}
```

Example project override:

```json
{
  "workspaceId": "project-workspace-id"
}
```

The effective priority is project over global, with `NAMS_WORKSPACE_ID` as the final operational override. This lets a user work mostly from one global workspace while allowing specific projects to route memory to different workspaces.

## Runtime Architecture

The implementation should update only shared runtime and generated-client surfaces:

- `src/runtime/config.ts`
  - Add `workspaceId` to `NamsRuntimeConfig`.
  - Parse `workspaceId` from global and project JSON configs.
  - Apply `NAMS_WORKSPACE_ID` as the environment override.
  - Track sanitized source metadata for `workspaceId`.
  - Return a structured non-ok result when `workspaceId` is missing.
- `src/runtime/memory-service.ts`
  - Pass `config.workspaceId` to `NamsClient`.
- `scripts/generate-nams-client.mjs`
  - Emit `workspaceId` in `NamsClientOptions`.
  - Store it privately on `NamsClient`.
  - Set `X-Workspace-Id` on every request.
- `src/generated/nams-client.ts`
  - Regenerate from the updated generator.
- `README.md` and `INSTALL.md`
  - Document `workspaceId` as required and `NAMS_WORKSPACE_ID` as its environment override.

Platform adapters under `src/platforms/<platform>/` should remain unchanged except where tests naturally assert their fail-open behavior through the stricter shared config result.

## Request Shape

Every NAMS request should include:

- `Authorization: Bearer <apiKey>`
- `X-Workspace-Id: <workspaceId>`
- `Accept: application/json`
- `Content-Type: application/json` only when a request body is present
- Existing provenance headers from `defaultHeaders`

Header precedence should mirror existing required headers. `defaultHeaders` may provide provenance or caller metadata, but it must not override:

- `Authorization`
- `Accept`
- `X-Workspace-Id`
- `Content-Type`, when the request has a JSON body

Request observability must continue to remove `Authorization` from logged request headers. `X-Workspace-Id` is not treated as a secret and may appear in sanitized request diagnostics as a routing identifier.

## Error Handling

If `workspaceId` is missing after JSON and environment resolution, hooks should behave the same way they behave when `apiKey` is missing:

- Continue the harness.
- Skip NAMS recall, write, and tool-log requests.
- Save conservative local state when applicable.
- Log a sanitized diagnostic, for example `NAMS workspaceId missing`.
- Include config source metadata such as `workspaceId: "missing"` or `workspaceId: "env:NAMS_WORKSPACE_ID"`.
- Never log API key values or raw invalid config contents.

Invalid or unreadable JSON config behavior remains unchanged: return a structured invalid-config result and avoid leaking raw file contents.

## Testing

Tests should be added or updated before implementation code changes.

Required runtime config tests:

- Global config loads `workspaceId`.
- Project config overrides global `workspaceId`.
- `NAMS_WORKSPACE_ID` overrides global and project JSON config.
- Missing `workspaceId` returns a structured non-ok config result.
- Config diagnostics include `workspaceId` source metadata.
- Diagnostics do not include API key values.

Required generated client tests:

- `NamsClient` requires and sends `X-Workspace-Id` on POST and GET requests.
- `defaultHeaders` cannot override `Authorization`, `Accept`, or `X-Workspace-Id`.
- Request log events omit `Authorization`.
- Request log events include `X-Workspace-Id`.
- Error and network-failure request logs preserve the same sanitization behavior.

Required memory/platform tests:

- `createNamsMemoryService` passes the configured `workspaceId` into `NamsClient`.
- At least one platform memory-flow test verifies requests include `X-Workspace-Id`.
- Platform flows continue and log sanitized diagnostics when `workspaceId` is missing.
- Existing missing-`apiKey` tests are updated for the new source metadata shape.

Required docs checks:

- `README.md` describes `workspaceId` as required runtime config.
- `INSTALL.md` shows `workspaceId` in the sample config.
- `INSTALL.md` documents `NAMS_WORKSPACE_ID`.

## OpenAPI And Build Notes

The runtime must not fetch or inspect OpenAPI while hooks run. The workspace header is a required API contract even though the currently observed OpenAPI document does not model it as a header parameter. The custom generator should emit the header logic explicitly as part of the hook-facing NAMS client contract.

`npm run check` remains the completion gate. It runs OpenAPI generation, TypeScript build, test typechecking, and the full test suite.

## Approval Record

Approved decisions from brainstorming:

- Use the existing global and project JSON config files for workspace selection.
- Follow the exact same convention as `NAMS_API_KEY` by adding `NAMS_WORKSPACE_ID`.
- Implement workspace ID as a first-class runtime config value and generated client option.
- Send `X-Workspace-Id` from the generated client on every request.
- Do not create new workspace-specific state files.
