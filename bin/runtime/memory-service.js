import { NamsClient } from "../generated/nams-client.js";
import { appendNamsRequestLog } from "./logging.js";
import { namsProvenanceHeaders } from "./provenance.js";
const toolOutputFieldNames = new Set(["body", "functionresponse", "output", "response", "result", "resultdisplay"]);
const memoryContextHeader = "Relevant memory context:";
const memoryContextInstruction = "Use this context silently when it is relevant. Do not narrate memory mechanics.";
export class NamsMemoryService {
    client;
    constructor(client) {
        this.client = client;
    }
    async createConversation(input) {
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
    async recall(conversationId) {
        const context = await this.client.getConversationContext(conversationId);
        return formatMemoryContext(context);
    }
    async searchEntities(query) {
        const response = await this.client.searchEntities({ query, limit: 5 });
        const observations = (response.entities ?? [])
            .map((entity) => [entity.name, entity.description].filter(isNonBlankString).join(": "))
            .filter(isNonBlankString)
            .map((content) => ({ content }));
        return formatMemoryContext({ observations });
    }
    async storeUserMessage(conversationId, content) {
        await this.client.addMessage(conversationId, { role: "user", content });
    }
    async storeAssistantMessage(conversationId, content) {
        await this.client.addMessage(conversationId, { role: "assistant", content });
    }
    async recordReasoningStep(input) {
        const response = await this.client.recordReasoningStep(input);
        return response.id;
    }
    async recordToolCall(input) {
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
export function createNamsMemoryService(config, invocation, state) {
    const client = new NamsClient({
        apiKey: config.apiKey,
        workspaceId: config.workspaceId,
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
        defaultHeaders: namsProvenanceHeaders(invocation),
        onRequest: (event) => appendNamsRequestLog(invocation, state, event),
    });
    return new NamsMemoryService(client);
}
export function formatMemoryContext(context) {
    const lines = [
        ...sectionLines("Reflections", context.reflections?.map((entry) => entry.content)),
        ...sectionLines("Observations", context.observations?.map((entry) => entry.content)),
        ...sectionLines("Recent messages", context.recentMessages?.map((entry) => [entry.role, entry.content].filter(isNonBlankString).join(": "))),
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
export function combineMemoryContexts(contexts) {
    const bodyLines = contexts
        .flatMap((context) => contextLines(context))
        .filter((line) => line.trim() !== "");
    if (bodyLines.length === 0) {
        return "";
    }
    return [memoryContextHeader, ...bodyLines, "", memoryContextInstruction].join("\n");
}
export function serializeToolInput(input) {
    const serialized = JSON.stringify(removeToolOutputFields(input) ?? {});
    return capSerializedToolText(serialized);
}
export function serializeToolOutput(output) {
    return typeof output === "string" ? output : JSON.stringify(output ?? "");
}
function capSerializedToolText(serialized) {
    if (serialized.length <= 4000) {
        return serialized;
    }
    const suffix = "...[truncated]";
    return `${serialized.slice(0, 4000 - suffix.length)}${suffix}`;
}
function contextLines(context) {
    return context
        .split("\n")
        .filter((line) => line !== memoryContextHeader)
        .filter((line) => line !== memoryContextInstruction);
}
function sectionLines(label, values) {
    const presentValues = (values ?? []).filter(isNonBlankString);
    if (presentValues.length === 0) {
        return [];
    }
    return [`${label}:`, ...presentValues.map((value) => `- ${value}`)];
}
function removeToolOutputFields(value) {
    if (Array.isArray(value)) {
        return value.map(removeToolOutputFields);
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    const sanitized = {};
    for (const [key, nestedValue] of Object.entries(value)) {
        if (isToolOutputField(key)) {
            continue;
        }
        sanitized[key] = removeToolOutputFields(nestedValue);
    }
    return sanitized;
}
function isToolOutputField(value) {
    const normalized = value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    return (toolOutputFieldNames.has(normalized) ||
        normalized.includes("body") ||
        normalized.includes("functionresponse") ||
        normalized.includes("output") ||
        normalized.includes("response") ||
        normalized.includes("result"));
}
function isNonBlankString(value) {
    return typeof value === "string" && value.trim() !== "";
}
