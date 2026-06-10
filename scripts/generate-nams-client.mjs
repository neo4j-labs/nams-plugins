import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const specPath = path.join(root, "docs", "nams-openapi.json");
const outputPath = path.join(root, "src", "generated", "nams-client.ts");

const workspaceScopedEndpoints = [
  {
    methodName: "createConversation",
    httpMethod: "POST",
    path: "/v1/conversations",
    successStatus: "201",
    bodyRequired: false,
  },
  {
    methodName: "addMessage",
    httpMethod: "POST",
    path: "/v1/conversations/{id}/messages",
    successStatus: "201",
    bodyRequired: true,
    pathArgs: [{ argumentName: "conversationId", parameterName: "id" }],
  },
  {
    methodName: "addMessagesBulk",
    httpMethod: "POST",
    path: "/v1/conversations/{id}/messages/bulk",
    successStatus: "201",
    bodyRequired: true,
    pathArgs: [{ argumentName: "conversationId", parameterName: "id" }],
  },
  {
    methodName: "getConversationContext",
    httpMethod: "GET",
    path: "/v1/conversations/{id}/context",
    successStatus: "200",
    pathArgs: [{ argumentName: "conversationId", parameterName: "id" }],
  },
  {
    methodName: "searchConversationMessages",
    httpMethod: "POST",
    path: "/v1/conversations/{id}/search",
    successStatus: "200",
    bodyRequired: true,
    pathArgs: [{ argumentName: "conversationId", parameterName: "id" }],
  },
  {
    methodName: "searchEntities",
    httpMethod: "POST",
    path: "/v1/entities/search",
    successStatus: "200",
    bodyRequired: true,
  },
  {
    methodName: "recordReasoningStep",
    httpMethod: "POST",
    path: "/v1/reasoning/steps",
    successStatus: "201",
    bodyRequired: true,
  },
  {
    methodName: "recordToolCall",
    httpMethod: "POST",
    path: "/v1/reasoning/tool-calls",
    successStatus: "201",
    bodyRequired: true,
  },
];

const workspaceInfrastructureEndpoints = [
  {
    methodName: "listMyWorkspaces",
    httpMethod: "GET",
    path: "/v1/users/me/workspaces",
    successStatus: "200",
  },
];

const spec = JSON.parse(await readFile(specPath, "utf8"));
const definitions = spec.definitions ?? {};
const resolvedWorkspaceScopedEndpoints = workspaceScopedEndpoints.map((endpoint) => resolveEndpoint(spec, endpoint));
const resolvedWorkspaceInfrastructureEndpoints = workspaceInfrastructureEndpoints.map((endpoint) =>
  resolveEndpoint(spec, endpoint),
);
const referencedDefinitions = collectReferencedDefinitions(
  [...resolvedWorkspaceScopedEndpoints, ...resolvedWorkspaceInfrastructureEndpoints],
  definitions,
);
const source = renderClient(
  resolvedWorkspaceScopedEndpoints,
  resolvedWorkspaceInfrastructureEndpoints,
  referencedDefinitions,
  definitions,
);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, source, "utf8");

function resolveEndpoint(openapi, endpoint) {
  const operation = openapi.paths?.[endpoint.path]?.[endpoint.httpMethod.toLowerCase()];
  if (operation === undefined) {
    throw new Error(`Missing endpoint ${endpoint.httpMethod} ${endpoint.path}`);
  }

  const pathParameters = (operation.parameters ?? []).filter((parameter) => parameter.in === "path");
  const pathArgs = endpoint.pathArgs ?? [];
  const placeholderNames = pathPlaceholders(endpoint.path);
  const pathArgNames = pathArgs.map((pathArg) => pathArg.parameterName);
  const missingPathArgs = placeholderNames.filter((placeholderName) => !pathArgNames.includes(placeholderName));
  const extraPathArgs = pathArgNames.filter((pathArgName) => !placeholderNames.includes(pathArgName));
  if (missingPathArgs.length > 0 || extraPathArgs.length > 0) {
    throw new Error(
      [
        `Path arguments for ${endpoint.methodName} must match placeholders in ${endpoint.path}.`,
        missingPathArgs.length > 0 ? `missing pathArgs for ${missingPathArgs.join(", ")}` : undefined,
        extraPathArgs.length > 0 ? `extra pathArgs for ${extraPathArgs.join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  for (const pathArg of pathArgs) {
    const parameter = pathParameters.find((candidate) => candidate.name === pathArg.parameterName);
    if (parameter === undefined || parameter.required !== true || parameter.type !== "string") {
      throw new Error(`Missing required string path parameter ${pathArg.parameterName} on ${endpoint.path}`);
    }
  }

  const bodyParameter = (operation.parameters ?? []).find((parameter) => parameter.in === "body");
  const bodyRef = bodyParameter?.schema?.$ref !== undefined ? parseDefinitionRef(bodyParameter.schema.$ref) : undefined;
  if (endpoint.bodyRequired && bodyRef === undefined) {
    throw new Error(`Missing required body schema on ${endpoint.methodName}`);
  }
  if (endpoint.bodyRequired && bodyParameter?.required !== true) {
    throw new Error(`Body schema must be marked required on ${endpoint.methodName}`);
  }

  const responseRef = parseDefinitionRef(operation.responses?.[endpoint.successStatus]?.schema?.$ref);
  if (responseRef === undefined) {
    throw new Error(`Missing ${endpoint.successStatus} response schema on ${endpoint.methodName}`);
  }

  return {
    ...endpoint,
    bodyRef,
    bodyType: bodyRef === undefined ? undefined : typeNameForDefinition(bodyRef),
    responseRef,
    responseType: typeNameForDefinition(responseRef),
  };
}

function pathPlaceholders(endpointPath) {
  return [...endpointPath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function collectReferencedDefinitions(resolved, allDefinitions) {
  const ordered = [];
  const seen = new Set();
  const queue = [];

  for (const endpoint of resolved) {
    add(endpoint.bodyRef);
    add(endpoint.responseRef);
  }

  while (queue.length > 0) {
    const definitionName = queue.shift();
    collectFromSchema(allDefinitions[definitionName]);
  }

  return ordered;

  function add(definitionName) {
    if (definitionName === undefined || seen.has(definitionName)) {
      return;
    }
    if (allDefinitions[definitionName] === undefined) {
      throw new Error(`Missing definition ${definitionName}`);
    }
    seen.add(definitionName);
    ordered.push(definitionName);
    queue.push(definitionName);
  }

  function collectFromSchema(schema) {
    if (schema === undefined) {
      return;
    }
    const ref = parseDefinitionRef(schema.$ref);
    if (ref !== undefined) {
      add(ref);
    }
    if (schema.items !== undefined) {
      collectFromSchema(schema.items);
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === "object") {
      collectFromSchema(schema.additionalProperties);
    }
    for (const property of Object.values(schema.properties ?? {})) {
      collectFromSchema(property);
    }
  }
}

function renderClient(workspaceScopedResolved, workspaceInfrastructureResolved, definitionNames, allDefinitions) {
  const lines = [
    "// This file is auto-generated by scripts/generate-nams-client.mjs",
    "",
    "export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };",
    "export type HttpMethod = \"GET\" | \"POST\";",
    "",
    "export interface NamsClientOptions {",
    "  baseUrl: string;",
    "  apiKey: string;",
    "  workspaceId: string;",
    "  defaultHeaders?: Record<string, string>;",
    "  fetch?: typeof fetch;",
    "  onRequest?: (event: NamsRequestEvent) => void | Promise<void>;",
    "}",
    "",
    "export interface NamsWorkspaceClientOptions {",
    "  baseUrl: string;",
    "  apiKey: string;",
    "  defaultHeaders?: Record<string, string>;",
    "  fetch?: typeof fetch;",
    "  onRequest?: (event: NamsRequestEvent) => void | Promise<void>;",
    "}",
    "",
    "export interface NamsRequestEvent {",
    "  operation: string;",
    "  method: HttpMethod;",
    "  path: string;",
    "  status?: number;",
    "  ok: boolean;",
    "  durationMs: number;",
    "  request: NamsHttpLogRequest;",
    "  response?: NamsHttpLogResponse;",
    "}",
    "",
    "export interface NamsHttpLogRequest {",
    "  method: HttpMethod;",
    "  url: string;",
    "  path: string;",
    "  headers: Record<string, string>;",
    "  body?: unknown;",
    "}",
    "",
    "export interface NamsHttpLogResponse {",
    "  status: number;",
    "  ok: boolean;",
    "  headers: Record<string, string>;",
    "  body: unknown;",
    "}",
    "",
    "export class NamsClientError extends Error {",
    "  constructor(",
    "    message: string,",
    "    public readonly status: number,",
    "    public readonly body: unknown,",
    "  ) {",
    "    super(message);",
    "    this.name = \"NamsClientError\";",
    "  }",
    "}",
    "",
    "interface RequestNamsOptions {",
    "  baseUrl: string;",
    "  apiKey: string;",
    "  workspaceId?: string;",
    "  defaultHeaders: Record<string, string>;",
    "  fetchImpl: typeof fetch;",
    "  onRequest?: (event: NamsRequestEvent) => void | Promise<void>;",
    "  operation: string;",
    "  httpMethod: HttpMethod;",
    "  pathTemplate: string;",
    "  pathParams?: Record<string, string>;",
    "  body?: unknown;",
    "}",
    "",
  ];

  for (const definitionName of definitionNames) {
    lines.push(renderDefinition(definitionName, allDefinitions[definitionName]), "");
  }

  lines.push(
    "export const NAMS_CLIENT_ENDPOINTS = [",
    ...workspaceScopedResolved.map(
      (endpoint) =>
        `  { methodName: "${endpoint.methodName}", httpMethod: "${endpoint.httpMethod}", path: "${endpoint.path}" },`,
    ),
    "] as const;",
    "",
    "export const NAMS_WORKSPACE_CLIENT_ENDPOINTS = [",
    ...workspaceInfrastructureResolved.map(
      (endpoint) =>
        `  { methodName: "${endpoint.methodName}", httpMethod: "${endpoint.httpMethod}", path: "${endpoint.path}" },`,
    ),
    "] as const;",
    "",
    "export class NamsClient {",
    "  private readonly baseUrl: string;",
    "  private readonly apiKey: string;",
    "  private readonly workspaceId: string;",
    "  private readonly defaultHeaders: Record<string, string>;",
    "  private readonly fetchImpl: typeof fetch;",
    "  private readonly onRequest?: (event: NamsRequestEvent) => void | Promise<void>;",
    "",
    "  constructor(options: NamsClientOptions) {",
    "    if (options.baseUrl === undefined || options.baseUrl.trim() === \"\") {",
    "      throw new Error(\"NamsClient requires a baseUrl\");",
    "    }",
    "    this.baseUrl = options.baseUrl.replace(/\\/+$/, \"\");",
    "    this.apiKey = options.apiKey;",
    "    this.workspaceId = options.workspaceId;",
    "    if (this.workspaceId === undefined || this.workspaceId === \"\") {",
    "      throw new Error(\"NamsClient requires a workspaceId\");",
    "    }",
    "    this.defaultHeaders = options.defaultHeaders ?? {};",
    "    this.fetchImpl = options.fetch ?? globalThis.fetch;",
    "    this.onRequest = options.onRequest;",
    "    if (this.fetchImpl === undefined) {",
    "      throw new Error(\"NamsClient requires a fetch implementation\");",
    "    }",
    "  }",
    "",
  );

  for (const endpoint of workspaceScopedResolved) {
    lines.push(renderMethod(endpoint), "");
  }

  lines.push(
    "  private async request<TResponse>(",
    "    operation: string,",
    "    httpMethod: HttpMethod,",
    "    pathTemplate: string,",
    "    pathParams?: Record<string, string>,",
    "    body?: unknown,",
    "  ): Promise<TResponse> {",
    "    return requestNams<TResponse>({",
    "      baseUrl: this.baseUrl,",
    "      apiKey: this.apiKey,",
    "      workspaceId: this.workspaceId,",
    "      defaultHeaders: this.defaultHeaders,",
    "      fetchImpl: this.fetchImpl,",
    "      onRequest: this.onRequest,",
    "      operation,",
    "      httpMethod,",
    "      pathTemplate,",
    "      pathParams,",
    "      body,",
    "    });",
    "  }",
    "}",
    "",
    "export class NamsWorkspaceClient {",
    "  private readonly baseUrl: string;",
    "  private readonly apiKey: string;",
    "  private readonly defaultHeaders: Record<string, string>;",
    "  private readonly fetchImpl: typeof fetch;",
    "  private readonly onRequest?: (event: NamsRequestEvent) => void | Promise<void>;",
    "",
    "  constructor(options: NamsWorkspaceClientOptions) {",
    "    if (options.baseUrl === undefined || options.baseUrl.trim() === \"\") {",
    "      throw new Error(\"NamsWorkspaceClient requires a baseUrl\");",
    "    }",
    "    this.baseUrl = options.baseUrl.replace(/\\/+$/, \"\");",
    "    this.apiKey = options.apiKey;",
    "    this.defaultHeaders = options.defaultHeaders ?? {};",
    "    this.fetchImpl = options.fetch ?? globalThis.fetch;",
    "    this.onRequest = options.onRequest;",
    "    if (this.fetchImpl === undefined) {",
    "      throw new Error(\"NamsWorkspaceClient requires a fetch implementation\");",
    "    }",
    "  }",
    "",
  );

  for (const endpoint of workspaceInfrastructureResolved) {
    lines.push(renderMethod(endpoint), "");
  }

  lines.push(
    "  private async request<TResponse>(",
    "    operation: string,",
    "    httpMethod: HttpMethod,",
    "    pathTemplate: string,",
    "    pathParams?: Record<string, string>,",
    "    body?: unknown,",
    "  ): Promise<TResponse> {",
    "    return requestNams<TResponse>({",
    "      baseUrl: this.baseUrl,",
    "      apiKey: this.apiKey,",
    "      defaultHeaders: this.defaultHeaders,",
    "      fetchImpl: this.fetchImpl,",
    "      onRequest: this.onRequest,",
    "      operation,",
    "      httpMethod,",
    "      pathTemplate,",
    "      pathParams,",
    "      body,",
    "    });",
    "  }",
    "}",
    "",
    "async function requestNams<TResponse>({",
    "  baseUrl,",
    "  apiKey,",
    "  workspaceId,",
    "  defaultHeaders,",
    "  fetchImpl,",
    "  onRequest,",
    "  operation,",
    "  httpMethod,",
    "  pathTemplate,",
    "  pathParams,",
    "  body,",
    "}: RequestNamsOptions): Promise<TResponse> {",
    "  const url = `${baseUrl}${formatPath(pathTemplate, pathParams)}`;",
    "  const headers: Record<string, string> = { ...defaultHeaders };",
    "  setHeader(headers, \"Accept\", \"application/json\");",
    "  setHeader(headers, \"Authorization\", `Bearer ${apiKey}`);",
    "  if (workspaceId !== undefined) {",
    "    setHeader(headers, \"X-Workspace-Id\", workspaceId);",
    "  } else {",
    "    deleteHeader(headers, \"X-Workspace-Id\");",
    "  }",
    "  const init: RequestInit = { method: httpMethod, headers };",
    "  if (body !== undefined) {",
    "    setHeader(headers, \"Content-Type\", \"application/json\");",
    "    init.body = JSON.stringify(body);",
    "  } else {",
    "    deleteHeader(headers, \"Content-Type\");",
    "  }",
    "  const requestLog: NamsHttpLogRequest = {",
    "    method: httpMethod,",
    "    url,",
    "    path: pathTemplate,",
    "    headers: headersForLog(headers),",
    "    ...(body !== undefined ? { body } : {}),",
    "  };",
    "",
    "  const startedAt = Date.now();",
    "  let response: Response;",
    "  try {",
    "    response = await fetchImpl(url, init);",
    "  } catch (error) {",
    "    await emitRequestEvent(onRequest, {",
    "      operation,",
    "      method: httpMethod,",
    "      path: pathTemplate,",
    "      ok: false,",
    "      durationMs: elapsedMs(startedAt),",
    "      request: requestLog,",
    "    });",
    "    throw error;",
    "  }",
    "  const responseBody = await readResponseBody(response);",
    "  await emitRequestEvent(onRequest, {",
    "    operation,",
    "    method: httpMethod,",
    "    path: pathTemplate,",
    "    status: response.status,",
    "    ok: response.ok,",
    "    durationMs: elapsedMs(startedAt),",
    "    request: requestLog,",
    "    response: {",
    "      status: response.status,",
    "      ok: response.ok,",
    "      headers: responseHeadersForLog(response.headers),",
    "      body: responseBody,",
    "    },",
    "  });",
    "  if (!response.ok) {",
    "    const message = extractErrorMessage(responseBody) ?? `NAMS request failed with status ${response.status}`;",
    "    throw new NamsClientError(message, response.status, responseBody);",
    "  }",
    "  return responseBody as TResponse;",
    "}",
    "",
    "function emitRequestEvent(",
    "  onRequest: ((event: NamsRequestEvent) => void | Promise<void>) | undefined,",
    "  event: NamsRequestEvent,",
    "): Promise<void> {",
    "  if (onRequest === undefined) {",
    "    return Promise.resolve();",
    "  }",
    "  try {",
    "    return Promise.resolve(onRequest(event)).catch(() => undefined);",
    "  } catch {",
    "    return Promise.resolve();",
    "  }",
    "}",
    "",
    "function elapsedMs(startedAt: number): number {",
    "  return Math.max(0, Date.now() - startedAt);",
    "}",
    "",
    "function headersForLog(headers: Record<string, string>): Record<string, string> {",
    "  const loggedHeaders: Record<string, string> = {};",
    "  for (const [key, value] of Object.entries(headers)) {",
    "    const normalizedKey = key.toLowerCase();",
    "    if (normalizedKey === \"authorization\" || normalizedKey === \"x-api-key\") {",
    "      continue;",
    "    }",
    "    loggedHeaders[key] = value;",
    "  }",
    "  return loggedHeaders;",
    "}",
    "",
    "function deleteHeader(headers: Record<string, string>, key: string): void {",
    "  for (const existingKey of Object.keys(headers)) {",
    "    if (existingKey.toLowerCase() === key.toLowerCase()) {",
    "      delete headers[existingKey];",
    "    }",
    "  }",
    "}",
    "",
    "function setHeader(headers: Record<string, string>, key: string, value: string): void {",
    "  deleteHeader(headers, key);",
    "  headers[key] = value;",
    "}",
    "",
    "function responseHeadersForLog(headers: Headers): Record<string, string> {",
    "  const loggedHeaders: Record<string, string> = {};",
    "  headers.forEach((value, key) => {",
    "    loggedHeaders[key] = value;",
    "  });",
    "  return loggedHeaders;",
    "}",
    "",
    "function formatPath(pathTemplate: string, pathParams: Record<string, string> = {}): string {",
    "  return pathTemplate.replace(/\\{([^}]+)\\}/g, (_match, key: string) => {",
    "    const value = pathParams[key];",
    "    if (value === undefined) {",
    "      throw new Error(`Missing path parameter ${key}`);",
    "    }",
    "    return encodeURIComponent(value);",
    "  });",
    "}",
    "",
    "async function readResponseBody(response: Response): Promise<unknown> {",
    "  const text = await response.text();",
    "  if (text.trim() === \"\") {",
    "    return undefined;",
    "  }",
    "  try {",
    "    return JSON.parse(text);",
    "  } catch {",
    "    return text;",
    "  }",
    "}",
    "",
    "function extractErrorMessage(body: unknown): string | undefined {",
    "  if (typeof body === \"object\" && body !== null && \"error\" in body) {",
    "    const value = (body as { error?: unknown }).error;",
    "    return typeof value === \"string\" ? value : undefined;",
    "  }",
    "  return undefined;",
    "}",
    "",
  );

  return lines.join("\n");
}

function renderMethod(endpoint) {
  const pathArgs = endpoint.pathArgs ?? [];
  const args = [
    ...pathArgs.map((pathArg) => `${pathArg.argumentName}: string`),
    endpoint.bodyType === undefined
      ? undefined
      : endpoint.bodyRequired
        ? `body: ${endpoint.bodyType}`
        : `body?: ${endpoint.bodyType}`,
  ].filter(Boolean);
  const pathParams =
    pathArgs.length === 0
      ? "undefined"
      : `{ ${pathArgs.map((pathArg) => `${pathArg.parameterName}: ${pathArg.argumentName}`).join(", ")} }`;
  const bodyArg = endpoint.bodyType === undefined ? "undefined" : "body";

  return [
    `  async ${endpoint.methodName}(${args.join(", ")}): Promise<${endpoint.responseType}> {`,
    `    return this.request<${endpoint.responseType}>("${endpoint.methodName}", "${endpoint.httpMethod}", "${endpoint.path}", ${pathParams}, ${bodyArg});`,
    "  }",
  ].join("\n");
}

function renderDefinition(definitionName, schema) {
  const typeName = typeNameForDefinition(definitionName);
  if (schema.type !== "object" || schema.properties === undefined) {
    return `export type ${typeName} = ${schemaToType(schema)};`;
  }

  const required = new Set(schema.required ?? []);
  const lines = [`export interface ${typeName} {`];
  for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
    const optional = required.has(propertyName) ? "" : "?";
    lines.push(`  ${propertyName}${optional}: ${schemaToType(propertySchema)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

function schemaToType(schema) {
  const ref = parseDefinitionRef(schema?.$ref);
  if (ref !== undefined) {
    return typeNameForDefinition(ref);
  }
  if (schema?.type === "array") {
    return `${schemaToType(schema.items)}[]`;
  }
  if (schema?.type === "object") {
    if (schema.additionalProperties !== undefined) {
      return `Record<string, ${schemaToType(schema.additionalProperties)}>`;
    }
    return "Record<string, JsonValue>";
  }
  if (schema?.type === "integer" || schema?.type === "number") {
    return "number";
  }
  if (schema?.type === "boolean") {
    return "boolean";
  }
  if (schema?.type === "string") {
    return "string";
  }
  return "JsonValue";
}

function parseDefinitionRef(ref) {
  if (typeof ref !== "string") {
    return undefined;
  }
  const prefix = "#/definitions/";
  if (!ref.startsWith(prefix)) {
    throw new Error(`Unsupported ref ${ref}`);
  }
  return ref.slice(prefix.length);
}

function typeNameForDefinition(definitionName) {
  const localName = definitionName.replace(/^handlers\./, "");
  return localName
    .replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_match, _prefix, char) => char.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, "");
}
