# NAMS OpenAPI Client Build Design

Date: 2026-05-10
Status: Approved design, amended after generator spikes
Repository: nams-hooks

## Summary

`nams-hooks` uses a build-time OpenAPI workflow to fetch the latest NAMS API contract, generate a focused typed client for the endpoints used by hook runtime code, and run contract tests against that generated client.

The hook runtime must never resolve OpenAPI, inspect schemas, or discover endpoints while an agent is running. Runtime code imports the compiled generated client from the package artifact.

Distribution, branch model, platform installs, and release-package shape are owned by `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`. This document owns only the OpenAPI fetch, generator, generated client contract, and contract-test design.

## Goals

- Keep runtime deterministic and free of runtime npm dependencies.
- Use TypeScript for maintainable source code and generated client types.
- Generate a focused NAMS REST client from the pinned OpenAPI spec.
- Commit generated TypeScript source on the development branch so API drift is visible in review.
- Run contract tests that compare generated output to `docs/nams-openapi.json`.
- Keep all OpenAPI parsing and endpoint validation in build-time scripts.
- Produce generated client code with no runtime npm dependencies.
- Permit dev-only generator and contract-test dependencies when they stay out of generated runtime output.

## Non-Goals

- Runtime OpenAPI endpoint discovery.
- Full SDK generation for every NAMS endpoint.
- Generic API client output that exposes path-derived operation names to hook runtime code.
- Heavyweight OpenAPI generators that introduce large generated runtimes.
- User-side TypeScript compilation before runtime can use the generated client.
- Branch, release, and platform distribution policy. Those are described in the hooks design.

## Source Inputs

- Hosted NAMS OpenAPI contract: `https://memory.neo4jlabs.com/openapi.json`
- Pinned local copy: `docs/nams-openapi.json`
- Custom generator spike: `spike-custom-nams-client`
- Hey API spike: `spike-hey-api-nams-client`

The current NAMS contract is Swagger/OpenAPI 2 style: it uses `definitions`, body `parameters`, and no `operationId` values. Missing `operationId` values are the main reason the runtime should not consume generic path-derived SDK methods directly.

## Baseline Decision

Use the small custom NAMS generator as the baseline.

The spike generated one dependency-free file, `src/generated/nams-client.ts`, with 262 lines and stable NAMS-specific methods:

- `createConversation`
- `addMessage`
- `addMessagesBulk`
- `getConversationContext`
- `searchConversationMessages`
- `searchEntities`
- `recordReasoningStep`
- `recordToolCall`

The generated runtime shape is the intended hook-facing API:

```ts
import { NamsClient } from "../src/generated/nams-client.js";

const client = new NamsClient({
  apiKey: "<NAMS_API_KEY>",
  baseUrl: "https://memory.neo4jlabs.com",
});

const conversation = await client.createConversation({
  userId: "local-user",
  metadata: {
    harness: "gemini",
  },
});

await client.addMessage(conversation.id ?? "", {
  role: "user",
  content: "Remember that this project is testing NAMS hooks.",
});
```

Hook runtime code should import this generated client or a thin runtime wrapper around it. Runtime code should not import OpenAPI documents, generator modules, or generic SDK path functions.

## Alternative On Hold: Hey API

Hey API was spiked with `@hey-api/openapi-ts@0.97.1` against `docs/nams-openapi.json`.

Observed output:

- 16 generated TypeScript files.
- 3,962 generated lines.
- No runtime imports from `@hey-api/*`; the fetch client runtime is bundled into generated files.
- Generated SDK covers every endpoint in the spec, including auth and entity management endpoints not needed by hooks.
- The generated output compiles with this repository's TypeScript settings.

Because the Swagger file lacks `operationId`, Hey API generated path-derived method names such as:

- `postV1Conversations`
- `postV1ConversationsByIdMessages`
- `postV1ConversationsByIdMessagesBulk`
- `getV1ConversationsByIdContext`
- `postV1EntitiesSearch`
- `postV1ReasoningToolCalls`

Sample usage from the spike:

```ts
import { createClient } from "../src/generated/hey-api/client/index.js";
import {
  postV1Conversations,
  postV1ConversationsByIdMessages,
} from "../src/generated/hey-api/sdk.gen.js";

const client = createClient({
  auth: "Bearer <NAMS_API_KEY>",
  baseUrl: "https://memory.neo4jlabs.com",
});

const conversation = await postV1Conversations({
  body: {
    userId: "local-user",
    metadata: {
      harness: "gemini",
    },
  },
  client,
  throwOnError: true,
});

await postV1ConversationsByIdMessages({
  body: {
    role: "user",
    content: "Remember that this project is testing NAMS hooks.",
  },
  client,
  path: {
    id: conversation.data.id ?? "",
  },
  throwOnError: true,
});
```

Hey API remains a viable fallback if the NAMS surface grows enough that maintaining a focused generator becomes expensive. It is on hold for now because it generates more surface than the hook runtime needs and would still require a hand-authored facade to hide path-derived method names.

## Repository Integration

The development branch contains both the generator and generated source:

```text
scripts/
  generate-nams-client.mjs
src/
  generated/
    nams-client.ts
test/
  nams-client-generator.test.js
docs/
  nams-openapi.json
```

The generated TypeScript client is committed. This makes OpenAPI drift visible in code review and lets normal TypeScript compilation catch generated API changes before release artifacts are produced.

## Build Targets

- `openapi:fetch`: fetch `https://memory.neo4jlabs.com/openapi.json` and write `docs/nams-openapi.json`.
- `openapi:generate`: read `docs/nams-openapi.json` and write `src/generated/nams-client.ts`.
- `openapi:check`: verify the committed generated client is fresh relative to `docs/nams-openapi.json`.
- `openapi:test`: regenerate and build the client, then verify generated endpoint metadata, request shaping, and error behavior against the pinned spec.
- `check`: default verification target. Runs OpenAPI freshness checks, TypeScript build, and the full test suite.
- `package:check`: run the default checks, distribution build, and distribution checks.

`openapi:fetch` is the only target that needs network access. Hook runtime, normal tests, and contract tests use the pinned local spec. Build-time and test-time dependencies may support these checks, but generated client code must remain dependency-free at runtime.

## Custom Generator Scope

The generator is intentionally small and NAMS-specific. It generates methods only for endpoints used by hooks:

- `createConversation`: `POST /v1/conversations`
- `addMessage`: `POST /v1/conversations/{id}/messages`
- `addMessagesBulk`: `POST /v1/conversations/{id}/messages/bulk`
- `getConversationContext`: `GET /v1/conversations/{id}/context`
- `searchConversationMessages`: `POST /v1/conversations/{id}/search`
- `searchEntities`: `POST /v1/entities/search`
- `recordReasoningStep`: `POST /v1/reasoning/steps`
- `recordToolCall`: `POST /v1/reasoning/tool-calls`

Each generated method includes:

- stable method name chosen by `nams-hooks`
- static HTTP method
- static path template
- typed path parameters
- typed request body when the endpoint has a body schema
- typed success response when the spec provides a response schema
- normalized error handling through `NamsClientError`
- no runtime dependency on OpenAPI data

The generator validates the selected endpoint paths, HTTP methods, required path parameters, body schemas, and success response schemas before writing output. If an endpoint disappears or changes shape, generation fails.

## Generated Client Runtime Contract

The generated client exposes:

```ts
export interface NamsClientOptions {
  baseUrl?: string;
  apiKey: string;
  fetch?: typeof fetch;
  onRequest?: (event: NamsRequestEvent) => void | Promise<void>;
}

export interface NamsRequestEvent {
  operation: string;
  method: HttpMethod;
  path: string;
  status?: number;
  ok: boolean;
  durationMs: number;
  request: NamsHttpLogRequest;
  response?: NamsHttpLogResponse;
}

export interface NamsHttpLogRequest {
  method: HttpMethod;
  url: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface NamsHttpLogResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
}

export class NamsClientError extends Error {
  readonly status: number;
  readonly body: unknown;
}

export class NamsClient {
  createConversation(body?: CreateConversationRequest): Promise<CreateConversationResponse>;
  addMessage(conversationId: string, body: AddMessageRequest): Promise<AddMessageResponse>;
  addMessagesBulk(conversationId: string, body: AddMessagesBulkRequest): Promise<AddMessagesBatchResponse>;
  getConversationContext(conversationId: string): Promise<ContextResponse>;
  searchConversationMessages(conversationId: string, body: SearchMessagesRequest): Promise<SearchMessagesResponse>;
  searchEntities(body: SearchEntitiesRequest): Promise<SearchEntitiesResponse>;
  recordReasoningStep(body: RecordStepRequest): Promise<RecordReasoningStepResponse>;
  recordToolCall(body: RecordToolCallRequest): Promise<RecordToolCallResponse>;
}
```

Requests use:

- `Authorization: Bearer <NAMS_API_KEY>`
- `Accept: application/json`
- `Content-Type: application/json` only when a request body is present
- `NAMS_BASE_URL` from runtime configuration, defaulting to `https://memory.neo4jlabs.com`

The generated client should prefer global `fetch`. The package engine remains responsible for selecting a Node version where `fetch` is available.

Each generated request method passes its stable operation name into the shared request helper. The optional `onRequest` callback receives request and response details for observability. Request headers omit `Authorization` so API keys are not logged. Request bodies, response headers, response bodies, and concrete request URLs are included for debugging. Network failures include the request details but no raw exception text. Callback failures are ignored so observability cannot block hook execution. NAMS request observability remains always-on at the runtime layer for now; `NAMS_LOG_LEVEL` is tracked as follow-up work.

## Contract Tests

Contract tests compare the generated client against `docs/nams-openapi.json`.

They must verify:

- required endpoint paths exist in the spec
- generated endpoint metadata maps to expected HTTP method and path
- path parameters required by generated methods exist as required string parameters
- request body schemas exist for endpoints that require bodies
- generated client source does not import or read `docs/nams-openapi.json`
- mocked successful responses are parsed consistently
- mocked error responses produce stable `NamsClientError` objects
- `Authorization` and JSON headers are shaped correctly
- `onRequest` receives request and response details on success and HTTP errors
- `onRequest` receives request details without raw exception text on network failures
- `onRequest` omits `Authorization` from logged request headers

Contract tests should fail when:

- an endpoint is removed or renamed
- required path parameters change
- required request body fields change
- generated output is stale after `openapi:generate`
- runtime code attempts OpenAPI inspection

## Open Risks

- The custom schema converter supports only the schema features needed by the selected NAMS endpoints. Expanding to broader NAMS API coverage may require generator work.
- The current NAMS spec does not define `operationId`. If that changes, the custom method manifest should remain the hook-facing contract unless we deliberately redesign it.
- Generated response types mirror optionality from the Swagger definitions. Runtime callers still need to handle absent IDs defensively.
- If agent platforms ship Node versions without stable global `fetch`, the generated client may need a tiny internal `node:https` transport.

## Approval Record

Approved decisions from brainstorming and spikes:

- Use TypeScript for source.
- Release vanilla JavaScript through the hooks distribution flow.
- Generate a focused client with a small custom NAMS OpenAPI generator.
- Commit generated client source.
- Do not discover endpoints at runtime.
- Keep Hey API on hold as a researched fallback.
