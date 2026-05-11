import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { HookInvocation, HookResult, PlatformAdapter } from "../interfaces.js";
import { loadNamsConfig } from "../runtime/config.js";
import { sha256, stableJsonHash } from "../runtime/hashing.js";
import { appendPlatformLog } from "../runtime/logging.js";
import { NamsMemoryService } from "../runtime/memory-service.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../runtime/session-state.js";
import { parseGeminiPayload } from "./gemini-payload.js";
import { readGeminiTranscript, type GeminiTranscriptEntry } from "./gemini-transcript.js";

export interface GeminiAdapterOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export class GeminiAdapter implements PlatformAdapter {
  constructor(private readonly options: GeminiAdapterOptions = {}) {}

  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    await appendSanitizedPlatformLog(invocation);

    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state = (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);

    return { stdout: { continue: true, suppressOutput: true } };
  }

  async beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    await appendSanitizedPlatformLog(invocation);

    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;

    if (payloadInfo.prompt === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const config = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    if (config === null) {
      await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory);
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
          await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory);
        }
      }

      const promptHash = sha256([invocation.platform, state.sessionKey, "user", payloadInfo.prompt.trim()].join("\n"));
      if (state.lastUserMessageHash !== promptHash) {
        await memory.storeUserMessage(conversationId, payloadInfo.prompt);
        state.lastUserMessageHash = promptHash;
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput(additionalContext);
  }

  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    await appendSanitizedPlatformLog(invocation);

    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
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
      await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory);
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
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  async afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    return logAndContinue(invocation);
  }
}

async function logAndContinue(invocation: HookInvocation): Promise<HookResult> {
  await appendSanitizedPlatformLog(invocation);
  return { stdout: { continue: true, suppressOutput: true } };
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

async function appendNamsConfigDiagnostic(invocation: HookInvocation, projectDirectory: string): Promise<void> {
  await appendGeminiDiagnosticLog({
    platform: invocation.platform,
    event: invocation.event,
    projectDirectory,
    payload: { message: "NAMS_API_KEY missing" },
  });
}

async function appendNamsFailureDiagnostic(
  invocation: HookInvocation,
  projectDirectory: string,
): Promise<void> {
  await appendGeminiDiagnosticLog({
    platform: invocation.platform,
    event: invocation.event,
    projectDirectory,
    payload: { message: "NAMS request failed" },
  });
}

async function appendSanitizedPlatformLog(invocation: HookInvocation): Promise<void> {
  try {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: sanitizeGeminiLogPayload(invocation.rawPayload),
      projectDirectory: resolveGeminiProjectDirectory(invocation),
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
  "prompt",
  "promptresponse",
  "response",
  "result",
  "resultdisplay",
  "tooloutput",
  "userprompt",
]);

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
    normalized.includes("prompt") ||
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
  payload: Record<string, unknown>;
}): Promise<void> {
  const logDir = path.join(entry.projectDirectory, ".nams", "logs");
  const logPath = path.join(logDir, `${entry.platform}-${entry.event.toLowerCase()}.jsonl`);
  const logEntry = {
    timestamp: new Date().toISOString(),
    harness: entry.platform,
    event: entry.event,
    payload: entry.payload,
  };

  try {
    await mkdir(logDir, { recursive: true });
    await appendFile(logPath, `${JSON.stringify(logEntry)}\n`, "utf8");
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

function resolveGeminiProjectDirectory(invocation: HookInvocation): string {
  const value = invocation.rawPayload.cwd ?? invocation.rawPayload.GEMINI_PROJECT_DIR;
  return typeof value === "string" && value.trim() !== "" ? value : invocation.processCwd;
}
