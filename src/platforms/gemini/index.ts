import type { HookInvocation, HookResult, PlatformAdapter, PlatformAdapterOptions } from "../../interfaces.js";
import type { NamsRequestEvent } from "../../generated/nams-client.js";
import {
  configDiagnosticPayload,
  loadNamsConfig,
  type NamsConfigLoadResult,
  type NamsRuntimeConfig,
} from "../../runtime/config.js";
import { sha256, stableJsonHash } from "../../runtime/hashing.js";
import { appendPlatformLog } from "../../runtime/logging.js";
import { combineMemoryContexts, NamsMemoryService } from "../../runtime/memory-service.js";
import {
  createInitialSessionState,
  loadSessionState,
  saveSessionState,
  type SessionState,
} from "../../runtime/session-state.js";
import { parseGeminiPayload } from "./payload.js";
import { readGeminiTranscript, type GeminiTranscriptEntry } from "./transcript.js";

export class GeminiAdapter implements PlatformAdapter {
  constructor(private readonly options: PlatformAdapterOptions = {}) {}

  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey, this.options.env)) ??
      initialState;
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state, this.options.env);
    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);

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
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey, this.options.env)) ??
      initialState;
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state, this.options.env);

    if (payloadInfo.prompt === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
      return allowOutput();
    }

    const configResult = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state, configResult, this.options.env);
    if (!configResult.ok) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
      return allowOutput();
    }
    const config = configResult.config;

    let additionalContext: string | undefined;
    try {
      const memory = this.createMemoryService(config, invocation, payloadInfo.projectDirectory, state);

      let conversationId = state.conversationId;
      if (conversationId === undefined) {
        conversationId = await memory.createConversation({
          harness: invocation.platform,
          projectDirectory: payloadInfo.projectDirectory,
        });
        state.conversationId = conversationId;
      }

      if (state.lastRecallAt === undefined) {
        const recallContexts: string[] = [];
        try {
          recallContexts.push(await memory.recall(conversationId));
        } catch {
          await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state, this.options.env);
        }
        try {
          recallContexts.push(await memory.searchEntities(payloadInfo.prompt));
        } catch {
          await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state, this.options.env);
        }
        state.lastRecallAt = new Date().toISOString();
        const recalledContext = combineMemoryContexts(recallContexts);
        if (recalledContext.trim() !== "") {
          additionalContext = recalledContext;
        }
      }

      const promptHash = sha256([invocation.platform, state.sessionKey, "user", payloadInfo.prompt.trim()].join("\n"));
      if (state.lastUserMessageHash !== promptHash) {
        await memory.storeUserMessage(conversationId, payloadInfo.prompt);
        state.lastUserMessageHash = promptHash;
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state, this.options.env);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
      return allowOutput(additionalContext);
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
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
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey, this.options.env)) ??
      initialState;
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state, this.options.env);
    state.seenAssistantMessageHashes ??= [];
    state.seenTranscriptEntryIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.seenToolCallIds ??= [];
    state.reasoningStepIdsByHash ??= {};

    if (state.conversationId === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
      return allowOutput();
    }
    const conversationId = state.conversationId;

    const configResult = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state, configResult, this.options.env);
    if (!configResult.ok) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
      return allowOutput();
    }
    const config = configResult.config;

    try {
      const memory = this.createMemoryService(config, invocation, payloadInfo.projectDirectory, state);
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
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state, this.options.env);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
      return allowOutput();
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
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
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey, this.options.env)) ??
      initialState;
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state, this.options.env);
    state.seenToolCallIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.reasoningStepIdsByHash ??= {};

    if (state.conversationId === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
      return allowOutput();
    }

    const toolPayload = parseGeminiAfterToolPayload(invocation.rawPayload);
    if (toolPayload.toolName === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
      return allowOutput();
    }

    const configResult = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state, configResult, this.options.env);
    if (!configResult.ok) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
      return allowOutput();
    }
    const config = configResult.config;

    try {
      const toolCallKeys = geminiToolCallDedupeKeys(
        state.sessionKey,
        toolPayload.id,
        toolPayload.toolName,
        toolPayload.input,
      );
      if (!hasSeenAny(state.seenToolCallIds, toolCallKeys.lookupKeys)) {
        const memory = this.createMemoryService(config, invocation, payloadInfo.projectDirectory, state);
        const reasoningStep = {
          conversationId: state.conversationId,
          reasoning: `Gemini invoked ${toolPayload.toolName} with the provided tool input.`,
          actionTaken: `Ran ${toolPayload.toolName}`,
          ...(toolPayload.outputSummary !== undefined ? { result: toolPayload.outputSummary } : {}),
        };
        const reasoningStepHash = stableJsonHash({
          sessionKey: state.sessionKey,
          ...reasoningStep,
        });
        let stepId: string | undefined = state.reasoningStepIdsByHash[reasoningStepHash];
        if (!state.seenReasoningStepHashes.includes(reasoningStepHash)) {
          stepId = await memory.recordReasoningStep(reasoningStep);
          state.seenReasoningStepHashes.push(reasoningStepHash);
          if (stepId !== undefined) {
            state.reasoningStepIdsByHash[reasoningStepHash] = stepId;
          }
        }
        await memory.recordToolCall({
          ...(stepId !== undefined ? { stepId } : {}),
          toolName: toolPayload.toolName,
          input: toolPayload.input,
          ...(toolPayload.output !== undefined ? { output: toolPayload.output } : {}),
          ...(toolPayload.status !== undefined ? { status: toolPayload.status } : {}),
          ...(toolPayload.durationMs !== undefined ? { durationMs: toolPayload.durationMs } : {}),
        });
        markSeen(state.seenToolCallIds, toolCallKeys.markKeys);
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state, this.options.env);
        await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
      return allowOutput();
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state, this.options.env);
    return allowOutput();
  }

  private createMemoryService(
    config: NamsRuntimeConfig,
    invocation: HookInvocation,
    projectDirectory: string,
    state: SessionState,
  ): NamsMemoryService {
    return new NamsMemoryService({
      ...config,
      ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
      onRequest: (event) => appendNamsRequestLog(invocation, projectDirectory, state, event, this.options.env),
    });
  }
}

function allowOutput(additionalContext?: string): HookResult {
  return {
    stdout: {
      continue: true,
      suppressOutput: true,
      ...(additionalContext !== undefined
        ? {
            hookSpecificOutput: {
              hookEventName: "BeforeAgent",
              additionalContext,
            },
          }
        : {}),
    },
  };
}

interface GeminiAfterToolPayload {
  id?: string;
  toolName?: string;
  input: unknown;
  output?: string;
  outputSummary?: string;
  status?: string;
  durationMs?: number;
}

function parseGeminiAfterToolPayload(payload: Record<string, unknown>): GeminiAfterToolPayload {
  const toolResponse = firstRecord(payload.tool_response, payload.toolResponse);
  return {
    ...optionalString("id", firstString(payload.tool_call_id, payload.toolCallId, payload.id)),
    ...optionalString("toolName", firstString(payload.tool_name, payload.toolName, payload.name, payload.displayName)),
    input: firstDefined(payload.tool_input, payload.toolInput, payload.input, payload.args, payload.arguments) ?? payload,
    ...optionalString(
      "output",
      firstString(toolResponse?.llmContent, toolResponse?.output, payload.llmContent, payload.output, payload.result),
    ),
    ...optionalString(
      "outputSummary",
      firstString(toolResponse?.returnDisplay, payload.returnDisplay, toolResponse?.display, toolResponse?.summary),
    ),
    ...optionalString("status", firstString(payload.status)),
    ...optionalNumber("durationMs", firstNumber(payload.duration_ms, payload.durationMs)),
  };
}

function geminiToolCallDedupeKeys(
  sessionKey: string,
  geminiToolCallId: string | undefined,
  toolName: string,
  input: unknown,
): { lookupKeys: string[]; markKeys: string[] } {
  const fallbackHash = stableJsonHash({
    sessionKey,
    toolName,
    input,
  });
  const fallbackKey = `fallback:${fallbackHash}`;
  const idFallbackKey = `gemini-id-fallback:${fallbackHash}`;

  if (geminiToolCallId !== undefined && geminiToolCallId.trim() !== "") {
    const idKey = `gemini-id:${stableJsonHash({ sessionKey, geminiToolCallId })}`;
    return {
      lookupKeys: [idKey, fallbackKey, fallbackHash],
      markKeys: [idKey, idFallbackKey],
    };
  }

  return {
    lookupKeys: [fallbackKey, idFallbackKey, fallbackHash],
    markKeys: [fallbackKey, fallbackHash],
  };
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

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
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
  result: NamsConfigLoadResult,
  env: Record<string, string | undefined> | undefined,
): Promise<void> {
  await appendGeminiDiagnosticLog({
    platform: invocation.platform,
    event: invocation.event,
    projectDirectory,
    state,
    payload: configDiagnosticPayload(result),
    env,
  });
}

async function appendNamsFailureDiagnostic(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
  env: Record<string, string | undefined> | undefined,
): Promise<void> {
  await appendGeminiDiagnosticLog({
    platform: invocation.platform,
    event: invocation.event,
    projectDirectory,
    state,
    payload: { message: "NAMS request failed" },
    env,
  });
}

async function appendNamsRequestLog(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
  payload: NamsRequestEvent,
  env: Record<string, string | undefined> | undefined,
): Promise<void> {
  await appendPlatformLog({
    platform: invocation.platform,
    event: invocation.event,
    kind: "nams.request",
    projectDirectory,
    payload: { ...payload },
    env,
    sessionCreatedAt: state.createdAt,
    sessionKey: state.sessionKey,
  });
}

async function appendRawPlatformLog(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
  env: Record<string, string | undefined> | undefined,
): Promise<void> {
  try {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      kind: "hook.event",
      payload: invocation.rawPayload,
      env,
      projectDirectory,
      sessionCreatedAt: state.createdAt,
      sessionKey: state.sessionKey,
    });
  } catch {
    // Gemini hooks must not fail because observability writes failed.
  }
}

async function appendGeminiDiagnosticLog(entry: {
  platform: HookInvocation["platform"];
  event: HookInvocation["event"];
  projectDirectory: string;
  state: SessionState;
  payload: Record<string, unknown>;
  env: Record<string, string | undefined> | undefined;
}): Promise<void> {
  try {
    await appendPlatformLog({
      platform: entry.platform,
      event: entry.event,
      kind: "diagnostic",
      projectDirectory: entry.projectDirectory,
      payload: entry.payload,
      env: entry.env,
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
        conversationId,
        actionTaken: entry.subject.trim(),
        reasoning: entry.description.trim(),
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

      const toolCallKeys = geminiToolCallDedupeKeys(state.sessionKey, entry.id, entry.name, entry.args);
      if (hasSeenAny(state.seenToolCallIds, toolCallKeys.lookupKeys)) {
        continue;
      }

      await memory.recordToolCall({
        ...(currentParentStepIds.length === 1 ? { stepId: currentParentStepIds[0] } : {}),
        toolName: entry.name,
        input: entry.args,
        ...(entry.status !== undefined ? { status: entry.status } : {}),
      });
      markSeen(state.seenToolCallIds, toolCallKeys.markKeys);
    }
  }
}

function addCurrentParentStepId(stepIds: string[], stepId: string | undefined): void {
  if (stepId !== undefined && !stepIds.includes(stepId)) {
    stepIds.push(stepId);
  }
}

function hasSeenAny(seen: string[], keys: string[]): boolean {
  return keys.some((key) => seen.includes(key));
}

function markSeen(seen: string[], keys: string[]): void {
  for (const key of keys) {
    if (!seen.includes(key)) {
      seen.push(key);
    }
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

function hasSeenAssistantMessage(state: AssistantMessageState, messageHash: string): boolean {
  return state.lastAssistantMessageHash === messageHash || state.seenAssistantMessageHashes.includes(messageHash);
}

function markAssistantMessageSeen(state: AssistantMessageState, messageHash: string): void {
  state.lastAssistantMessageHash = messageHash;
  if (!state.seenAssistantMessageHashes.includes(messageHash)) {
    state.seenAssistantMessageHashes.push(messageHash);
  }
}
