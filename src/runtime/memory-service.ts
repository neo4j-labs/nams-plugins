import { NamsClient, type ContextResponse, type NamsRequestEvent } from "../generated/nams-client.js";
import type { NamsRuntimeConfig } from "./config.js";

export interface NamsMemoryServiceOptions extends NamsRuntimeConfig {
  fetch?: typeof fetch;
  onRequest?: (event: NamsRequestEvent) => void | Promise<void>;
}

export interface CreateConversationInput {
  harness: string;
  projectDirectory: string;
}

export interface ReasoningStepInput {
  conversationId: string;
  reasoning: string;
  actionTaken: string;
  result?: string;
}

export interface ToolCallInput {
  stepId?: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  status?: string;
  durationMs?: number;
}

const toolOutputFieldNames = new Set(["body", "functionresponse", "output", "response", "result", "resultdisplay"]);
const memoryContextHeader = "Relevant memory context:";
const memoryContextInstruction = "Use this context silently when it is relevant. Do not narrate memory mechanics.";

export class NamsMemoryService {
  private readonly client: NamsClient;

  constructor(options: NamsMemoryServiceOptions) {
    this.client = new NamsClient({
      apiKey: options.apiKey,
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.onRequest !== undefined ? { onRequest: options.onRequest } : {}),
    });
  }

  async createConversation(input: CreateConversationInput): Promise<string> {
    const response = await this.client.createConversation({
      metadata: {
        harness: input.harness,
        projectDirectory: input.projectDirectory,
      },
    });
    if (response.id === undefined || response.id.trim() === "") {
      throw new Error("NAMS conversation response did not include id");
    }
    return response.id;
  }

  async recall(conversationId: string): Promise<string> {
    const context = await this.client.getConversationContext(conversationId);
    return formatMemoryContext(context);
  }

  async searchEntities(query: string): Promise<string> {
    const response = await this.client.searchEntities({ query, limit: 5 });
    const observations = (response.entities ?? [])
      .map((entity) => [entity.name, entity.description].filter(isNonBlankString).join(": "))
      .filter(isNonBlankString)
      .map((content) => ({ content }));
    return formatMemoryContext({ observations });
  }

  async storeUserMessage(conversationId: string, content: string): Promise<void> {
    await this.client.addMessage(conversationId, { role: "user", content });
  }

  async storeAssistantMessage(conversationId: string, content: string): Promise<void> {
    await this.client.addMessage(conversationId, { role: "assistant", content });
  }

  async recordReasoningStep(input: ReasoningStepInput): Promise<string | undefined> {
    const response = await this.client.recordReasoningStep(input);
    return response.id;
  }

  async recordToolCall(input: ToolCallInput): Promise<void> {
    await this.client.recordToolCall({
      toolName: input.toolName,
      input: serializeToolInput(input.input),
      output: serializeToolOutput(input.output ?? ""),
      ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    });
  }
}

export function formatMemoryContext(context: ContextResponse): string {
  const lines = [
    ...sectionLines(
      "Reflections",
      context.reflections?.map((entry) => entry.content),
    ),
    ...sectionLines(
      "Observations",
      context.observations?.map((entry) => entry.content),
    ),
    ...sectionLines(
      "Recent messages",
      context.recentMessages?.map((entry) => [entry.role, entry.content].filter(isNonBlankString).join(": ")),
    ),
  ];
  if (lines.length === 0) {
    return "";
  }
  return [
    memoryContextHeader,
    ...lines.slice(0, 24),
    "",
    memoryContextInstruction,
  ].join("\n");
}

export function combineMemoryContexts(contexts: string[]): string {
  const bodyLines = contexts
    .flatMap((context) => contextLines(context))
    .filter((line) => line.trim() !== "");
  if (bodyLines.length === 0) {
    return "";
  }
  return [memoryContextHeader, ...bodyLines, "", memoryContextInstruction].join("\n");
}

export function serializeToolInput(input: unknown): string {
  const serialized = JSON.stringify(removeToolOutputFields(input) ?? {});
  return capSerializedToolText(serialized);
}

export function serializeToolOutput(output: unknown): string {
  const serialized = typeof output === "string" ? output : JSON.stringify(output ?? "");
  return capSerializedToolText(serialized);
}

function capSerializedToolText(serialized: string): string {
  if (serialized.length <= 4000) {
    return serialized;
  }
  const suffix = "...[truncated]";
  return `${serialized.slice(0, 4000 - suffix.length)}${suffix}`;
}

function contextLines(context: string): string[] {
  return context
    .split("\n")
    .filter((line) => line !== memoryContextHeader)
    .filter((line) => line !== memoryContextInstruction);
}

function sectionLines(label: string, values: Array<string | undefined> | undefined): string[] {
  const presentValues = (values ?? []).filter(isNonBlankString);
  if (presentValues.length === 0) {
    return [];
  }
  return [`${label}:`, ...presentValues.map((value) => `- ${value}`)];
}

function removeToolOutputFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeToolOutputFields);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isToolOutputField(key)) {
      continue;
    }
    sanitized[key] = removeToolOutputFields(nestedValue);
  }
  return sanitized;
}

function isToolOutputField(value: string): boolean {
  const normalized = value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return (
    toolOutputFieldNames.has(normalized) ||
    normalized.includes("body") ||
    normalized.includes("functionresponse") ||
    normalized.includes("output") ||
    normalized.includes("response") ||
    normalized.includes("result")
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
