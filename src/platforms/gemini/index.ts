import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import { loadNamsConfig } from "../../runtime/config.js";
import { sha256, stableJsonHash } from "../../runtime/hashing.js";
import { appendPlatformLog } from "../../runtime/logging.js";
import { NamsMemoryService } from "../../runtime/memory-service.js";
import {
  createInitialSessionState,
  loadSessionState,
  saveSessionState,
  type SessionState,
} from "../../runtime/session-state.js";
import { parseGeminiPayload } from "./payload.js";
import { readGeminiTranscript, type GeminiTranscriptEntry } from "./transcript.js";

export interface GeminiAdapterOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export class GeminiAdapter implements PlatformAdapter {
  constructor(private readonly options: GeminiAdapterOptions = {}) {}

  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state = (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendSanitizedPlatformLog(invocation, payloadInfo.projectDirectory, state);
    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);

    return { stdout: { continue: true, suppressOutput: true } };
  }

  async beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendSanitizedPlatformLog(invocation, payloadInfo.projectDirectory, state);

    if (payloadInfo.prompt === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const config = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    if (config === null) {
      await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    let additionalContext: string | undefined;
    try {
      const memory = new NamsMemoryService({
        ...config,
        ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
      });

      let conversationId = state.conversationId;
      if (conversationId === undefined) {
        conversationId = await memory.createConversation({
          harness: invocation.platform,
          projectDirectory: payloadInfo.projectDirectory,
        });
        state.conversationId = conversationId;
      }

      if (state.lastMemorySearchAt === undefined) {
        try {
          const recalledContext = await memory.recall(conversationId);
          state.lastMemorySearchAt = new Date().toISOString();
          if (recalledContext.trim() !== "") {
            additionalContext = recalledContext;
          }
        } catch {
          await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
        }
      }

      const promptHash = sha256([invocation.platform, state.sessionKey, "user", payloadInfo.prompt.trim()].join("\n"));
      if (state.lastUserMessageHash !== promptHash) {
        await memory.storeUserMessage(conversationId, payloadInfo.prompt);
        state.lastUserMessageHash = promptHash;
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput(additionalContext);
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput(additionalContext);
  }

  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendSanitizedPlatformLog(invocation, payloadInfo.projectDirectory, state);
    state.seenAssistantMessageHashes ??= [];
    state.seenTranscriptEntryIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.seenToolCallIds ??= [];
    state.reasoningStepIdsByHash ??= {};

    if (state.conversationId === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }
    const conversationId = state.conversationId;

    const config = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    if (config === null) {
      await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    try {
      const memory = new NamsMemoryService({
        ...config,
        ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
      });
      const response = payloadInfo.promptResponse?.trim();
      if (response !== undefined && response !== "") {
        const responseHash = sha256([invocation.platform, state.sessionKey, "assistant", response].join("\n"));
        if (!hasSeenAssistantMessage(state, responseHash)) {
          await memory.storeAssistantMessage(state.conversationId, response);
        }
        markAssistantMessageSeen(state, responseHash);
      }

      if (payloadInfo.transcriptPath !== undefined) {
        const entries = await readGeminiTranscript(payloadInfo.transcriptPath);
        if (response === undefined || response === "") {
          await storeAssistantMessagesFromTranscript(invocation.platform, conversationId, state, memory, entries);
        }
        await recordTraceFromTranscript(conversationId, state, memory, entries);
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  async afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendSanitizedPlatformLog(invocation, payloadInfo.projectDirectory, state);
    state.seenToolCallIds ??= [];

    if (state.conversationId === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const toolPayload = parseGeminiAfterToolPayload(invocation.rawPayload);
    if (toolPayload.toolName === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const config = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    if (config === null) {
      await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    try {
      const toolCallId = geminiAfterToolDedupeKey(state.sessionKey, toolPayload);
      if (!state.seenToolCallIds.includes(toolCallId)) {
        const memory = new NamsMemoryService({
          ...config,
          ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
        });
        await memory.recordToolCall({
          toolName: toolPayload.toolName,
          input: toolPayload.input,
          ...(toolPayload.status !== undefined ? { status: toolPayload.status } : {}),
          ...(toolPayload.durationMs !== undefined ? { durationMs: toolPayload.durationMs } : {}),
        });
        state.seenToolCallIds.push(toolCallId);
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput();
  }
}

function allowOutput(additionalContext?: string): HookResult {
  return {
    stdout: {
      continue: true,
      suppressOutput: true,
      ...(additionalContext !== undefined ? { additionalContext } : {}),
    },
  };
}

interface GeminiAfterToolPayload {
  id?: string;
  toolName?: string;
  input: unknown;
  status?: string;
  durationMs?: number;
}

function parseGeminiAfterToolPayload(payload: Record<string, unknown>): GeminiAfterToolPayload {
  return {
    ...optionalString("id", firstString(payload.tool_call_id, payload.toolCallId, payload.id)),
    ...optionalString("toolName", firstString(payload.tool_name, payload.toolName, payload.name, payload.displayName)),
    input: firstDefined(payload.tool_input, payload.toolInput, payload.input, payload.args, payload.arguments) ?? payload,
    ...optionalString("status", firstString(payload.status)),
    ...optionalNumber("durationMs", firstNumber(payload.duration_ms, payload.durationMs)),
  };
}

function geminiAfterToolDedupeKey(sessionKey: string, payload: GeminiAfterToolPayload): string {
  if (payload.id !== undefined) {
    return stableJsonHash({
      sessionKey,
      source: "afterTool",
      id: payload.id,
    });
  }

  return stableJsonHash({
    sessionKey,
    source: "afterTool",
    toolName: payload.toolName,
    input: payload.input,
    status: payload.status,
  });
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function optionalString<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value !== undefined ? ({ [key]: value } as { [P in K]: string }) : {};
}

function optionalNumber<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return value !== undefined ? ({ [key]: value } as { [P in K]: number }) : {};
}

async function appendNamsConfigDiagnostic(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
): Promise<void> {
  await appendGeminiDiagnosticLog({
    platform: invocation.platform,
    event: invocation.event,
    projectDirectory,
    state,
    payload: { message: "NAMS_API_KEY missing" },
  });
}

async function appendNamsFailureDiagnostic(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
): Promise<void> {
  await appendGeminiDiagnosticLog({
    platform: invocation.platform,
    event: invocation.event,
    projectDirectory,
    state,
    payload: { message: "NAMS request failed" },
  });
}

async function appendSanitizedPlatformLog(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
): Promise<void> {
  try {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: sanitizeGeminiLogPayload(invocation.rawPayload),
      projectDirectory,
      sessionCreatedAt: state.createdAt,
      sessionKey: state.sessionKey,
    });
  } catch {
    // Gemini hooks must not fail because observability writes failed.
  }
}

const geminiSensitiveLogFieldNames = new Set([
  "authorization",
  "content",
  "functionresponse",
  "headers",
  "output",
  "promptresponse",
  "response",
  "result",
  "resultdisplay",
  "tooloutput",
]);

const geminiVisiblePromptFieldNames = new Set(["prompt", "userprompt"]);

function sanitizeGeminiLogPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized = redactGeminiSensitiveLogFields(payload);
  return sanitized !== null && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

function redactGeminiSensitiveLogFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactGeminiSensitiveLogFields);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isSensitiveGeminiLogField(key)) {
      sanitized[key] = "[redacted]";
      continue;
    }
    sanitized[key] = redactGeminiSensitiveLogFields(nestedValue);
  }
  return sanitized;
}

function isSensitiveGeminiLogField(value: string): boolean {
  const normalized = normalizeGeminiLogFieldName(value);
  if (geminiVisiblePromptFieldNames.has(normalized)) {
    return false;
  }
  return (
    geminiSensitiveLogFieldNames.has(normalized) ||
    normalized.includes("apikey") ||
    normalized.includes("authorization") ||
    normalized.includes("body") ||
    normalized.includes("content") ||
    normalized.includes("functionresponse") ||
    normalized.includes("header") ||
    normalized.includes("output") ||
    normalized.includes("password") ||
    normalized.includes("response") ||
    normalized.includes("result") ||
    normalized.includes("resultdisplay") ||
    normalized.includes("secret") ||
    normalized.includes("token")
  );
}

function normalizeGeminiLogFieldName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

async function appendGeminiDiagnosticLog(entry: {
  platform: HookInvocation["platform"];
  event: HookInvocation["event"];
  projectDirectory: string;
  state: SessionState;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await appendPlatformLog({
      platform: entry.platform,
      event: entry.event,
      projectDirectory: entry.projectDirectory,
      payload: entry.payload,
      sessionCreatedAt: entry.state.createdAt,
      sessionKey: entry.state.sessionKey,
    });
  } catch {
    // Diagnostics are best-effort and must never block a hook response.
  }
}

type AssistantMessageState = {
  lastAssistantMessageHash?: string;
  seenAssistantMessageHashes: string[];
};

type TraceState = {
  sessionKey: string;
  seenReasoningStepHashes: string[];
  seenToolCallIds: string[];
  reasoningStepIdsByHash: Record<string, string>;
};

async function storeAssistantMessagesFromTranscript(
  platform: string,
  conversationId: string,
  state: AssistantMessageState & { sessionKey: string; seenTranscriptEntryIds: string[] },
  memory: NamsMemoryService,
  entries: GeminiTranscriptEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.kind !== "assistant") {
      continue;
    }
    if (entry.id !== undefined && state.seenTranscriptEntryIds.includes(entry.id)) {
      continue;
    }

    const content = entry.content.trim();
    if (content !== "") {
      const responseHash = sha256([platform, state.sessionKey, "assistant", content].join("\n"));
      if (!hasSeenAssistantMessage(state, responseHash)) {
        await memory.storeAssistantMessage(conversationId, content);
      }
      markAssistantMessageSeen(state, responseHash);
    }

    if (entry.id !== undefined) {
      state.seenTranscriptEntryIds.push(entry.id);
    }
  }
}

async function recordTraceFromTranscript(
  conversationId: string,
  state: TraceState,
  memory: NamsMemoryService,
  entries: GeminiTranscriptEntry[],
): Promise<void> {
  let currentParentKey: string | undefined;
  let currentParentStepIds: string[] = [];

  for (const entry of entries) {
    if (entry.kind === "thought") {
      const parentKey = transcriptParentKey(entry);
      if (parentKey !== currentParentKey) {
        currentParentKey = parentKey;
        currentParentStepIds = [];
      }

      const reasoningStepHash = stableJsonHash({
        sessionKey: state.sessionKey,
        id: entry.id,
        subject: entry.subject,
        description: entry.description,
        timestamp: entry.timestamp,
      });
      if (state.seenReasoningStepHashes.includes(reasoningStepHash)) {
        addCurrentParentStepId(currentParentStepIds, state.reasoningStepIdsByHash[reasoningStepHash]);
        continue;
      }

      const stepId = await memory.recordReasoningStep({
        conversationId,
        reasoning: entry.description,
        actionTaken: entry.subject,
      });
      state.seenReasoningStepHashes.push(reasoningStepHash);
      if (stepId !== undefined) {
        state.reasoningStepIdsByHash[reasoningStepHash] = stepId;
        addCurrentParentStepId(currentParentStepIds, stepId);
      }
      continue;
    }

    if (entry.kind === "toolCall") {
      const parentKey = transcriptParentKey(entry);
      if (parentKey !== currentParentKey) {
        currentParentKey = parentKey;
        currentParentStepIds = [];
      }

      const toolCallId = transcriptToolCallDedupeKey(state.sessionKey, entry);
      if (state.seenToolCallIds.includes(toolCallId)) {
        continue;
      }

      await memory.recordToolCall({
        ...(currentParentStepIds.length === 1 ? { stepId: currentParentStepIds[0] } : {}),
        toolName: entry.name,
        input: entry.args,
        ...(entry.status !== undefined ? { status: entry.status } : {}),
      });
      state.seenToolCallIds.push(toolCallId);
    }
  }
}

function addCurrentParentStepId(stepIds: string[], stepId: string | undefined): void {
  if (stepId !== undefined && !stepIds.includes(stepId)) {
    stepIds.push(stepId);
  }
}

function transcriptParentKey(
  entry: Extract<GeminiTranscriptEntry, { kind: "thought" | "toolCall" }>,
): string {
  return stableJsonHash({
    parentTranscriptEntryId: entry.parentTranscriptEntryId,
    parentTranscriptEntryIndex: entry.parentTranscriptEntryIndex,
  });
}

function transcriptToolCallDedupeKey(
  sessionKey: string,
  entry: Extract<GeminiTranscriptEntry, { kind: "toolCall" }>,
): string {
  if (entry.id !== undefined) {
    return stableJsonHash({
      sessionKey,
      parentTranscriptEntryId: entry.parentTranscriptEntryId,
      parentTranscriptEntryIndex: entry.parentTranscriptEntryIndex,
      id: entry.id,
    });
  }

  return stableJsonHash({
    sessionKey,
    parentTranscriptEntryId: entry.parentTranscriptEntryId,
    parentTranscriptEntryIndex: entry.parentTranscriptEntryIndex,
    name: entry.name,
    args: entry.args,
    status: entry.status,
    timestamp: entry.timestamp,
  });
}

function hasSeenAssistantMessage(state: AssistantMessageState, messageHash: string): boolean {
  return state.lastAssistantMessageHash === messageHash || state.seenAssistantMessageHashes.includes(messageHash);
}

function markAssistantMessageSeen(state: AssistantMessageState, messageHash: string): void {
  state.lastAssistantMessageHash = messageHash;
  if (!state.seenAssistantMessageHashes.includes(messageHash)) {
    state.seenAssistantMessageHashes.push(messageHash);
  }
}
