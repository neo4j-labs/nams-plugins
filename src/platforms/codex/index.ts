import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import type { NamsRequestEvent } from "../../generated/nams-client.js";
import { loadNamsConfig, type NamsRuntimeConfig } from "../../runtime/config.js";
import { sha256 } from "../../runtime/hashing.js";
import { appendPlatformLog } from "../../runtime/logging.js";
import {
  combineMemoryContexts,
  NamsMemoryService,
  serializeToolInput,
} from "../../runtime/memory-service.js";
import {
  createInitialSessionState,
  loadSessionState,
  saveSessionState,
  type SessionState,
} from "../../runtime/session-state.js";
import { parseCodexPayload } from "./payload.js";
import { readCodexTranscript, type CodexTranscriptEntry } from "./transcript.js";

export interface CodexAdapterOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export class CodexAdapter implements PlatformAdapter {
  constructor(private readonly options: CodexAdapterOptions = {}) {}

  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);
    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);

    return { stdout: { continue: true, suppressOutput: true } };
  }

  async beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);

    if (payloadInfo.prompt === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const configResult = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    if (!configResult.ok) {
      await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
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
          await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
        }
        try {
          recallContexts.push(await memory.searchEntities(payloadInfo.prompt));
        } catch {
          await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
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
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput(additionalContext);
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput(additionalContext);
  }

  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);
    state.seenAssistantMessageHashes ??= [];
    state.seenTranscriptEntryIds ??= [];
    state.seenToolCallIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.reasoningStepIdsByHash ??= {};

    if (state.conversationId === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }
    const conversationId = state.conversationId;

    const configResult = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    if (!configResult.ok) {
      await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }
    const config = configResult.config;

    try {
      const memory = this.createMemoryService(config, invocation, payloadInfo.projectDirectory, state);
      const response = payloadInfo.lastAssistantMessage?.trim();
      if (response !== undefined && response !== "") {
        const responseDedupeHash = assistantMessageDedupeHash(
          invocation.platform,
          state.sessionKey,
          response,
          payloadInfo.turnId,
        );
        if (!hasSeenAssistantMessage(state, responseDedupeHash)) {
          await memory.storeAssistantMessage(conversationId, response);
        }
        markAssistantMessageSeen(
          state,
          assistantMessageHashes(invocation.platform, state.sessionKey, response, payloadInfo.turnId),
        );
      }
      if (payloadInfo.transcriptPath !== undefined) {
        const entries = await readCodexTranscript(payloadInfo.transcriptPath);
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
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);
    state.seenToolCallIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.reasoningStepIdsByHash ??= {};

    const conversationId = state.conversationId;
    const toolName = payloadInfo.toolName;
    if (conversationId === undefined || toolName === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowPostToolUseOutput();
    }

    const configResult = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    if (!configResult.ok) {
      await appendNamsConfigDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowPostToolUseOutput();
    }
    const config = configResult.config;

    const toolInput = payloadInfo.toolInput ?? {};
    const toolCallId = codexToolCallId({
      sessionKey: state.sessionKey,
      toolName,
      turnId: payloadInfo.turnId,
      toolUseId: payloadInfo.toolUseId,
      toolInput,
    });
    if (state.seenToolCallIds.includes(toolCallId)) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowPostToolUseOutput();
    }

    const reasoningHash = codexReasoningStepHash({
      sessionKey: state.sessionKey,
      toolName,
      turnId: payloadInfo.turnId,
    });

    try {
      const memory = this.createMemoryService(config, invocation, payloadInfo.projectDirectory, state);
      let stepId: string | undefined = state.reasoningStepIdsByHash[reasoningHash];
      if (!state.seenReasoningStepHashes.includes(reasoningHash)) {
        stepId = await memory.recordReasoningStep({
          conversationId,
          reasoning: `Codex ran ${toolName} for the current turn.`,
          actionTaken: `Ran ${toolName}`,
          ...(payloadInfo.toolResponse !== undefined ? { result: "Codex exposed post-tool output." } : {}),
        });
        markReasoningStepSeen(state, reasoningHash, stepId);
      }

      await memory.recordToolCall({
        ...(stepId !== undefined ? { stepId } : {}),
        toolName,
        input: toolInput,
        ...(payloadInfo.toolResponse !== undefined ? { output: payloadInfo.toolResponse } : {}),
      });
      markToolCallSeen(state, toolCallId);
    } catch {
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowPostToolUseOutput();
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowPostToolUseOutput();
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
      onRequest: (event) => appendNamsRequestLog(invocation, projectDirectory, state, event, config.apiKey),
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
              hookEventName: "UserPromptSubmit",
              additionalContext,
            },
          }
        : {}),
    },
  };
}

function allowPostToolUseOutput(): HookResult {
  return { stdout: { continue: true } };
}

type AssistantMessageState = {
  lastAssistantMessageHash?: string;
  seenAssistantMessageHashes: string[];
  seenTranscriptEntryIds: string[];
  sessionKey: string;
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
  state: AssistantMessageState,
  memory: NamsMemoryService,
  entries: CodexTranscriptEntry[],
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
      const responseHash = assistantContentHash(platform, state.sessionKey, content);
      if (!hasSeenAssistantMessage(state, responseHash)) {
        await memory.storeAssistantMessage(conversationId, content);
      }
      markAssistantMessageSeen(state, [responseHash]);
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
  entries: CodexTranscriptEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.kind !== "toolCall") {
      continue;
    }

    const toolCallId = codexTranscriptToolCallId(state.sessionKey, entry);
    if (state.seenToolCallIds.includes(toolCallId)) {
      continue;
    }

    const reasoningHash = codexTranscriptReasoningStepHash(state.sessionKey, entry.name, entry.status);
    let stepId: string | undefined = state.reasoningStepIdsByHash[reasoningHash];
    if (!state.seenReasoningStepHashes.includes(reasoningHash)) {
      stepId = await memory.recordReasoningStep({
        conversationId,
        reasoning: `Codex exposed ${entry.name} from the session transcript.`,
        actionTaken: `Ran ${entry.name}`,
        ...(entry.status !== undefined ? { result: `Codex transcript recorded status: ${entry.status}.` } : {}),
      });
      markReasoningStepSeen(state, reasoningHash, stepId);
    }

    await memory.recordToolCall({
      ...(stepId !== undefined ? { stepId } : {}),
      toolName: entry.name,
      input: entry.args,
      ...(entry.status !== undefined ? { status: entry.status } : {}),
    });
    markToolCallSeen(state, toolCallId);
  }
}

function assistantMessageDedupeHash(platform: string, sessionKey: string, content: string, turnId?: string): string {
  if (turnId === undefined) {
    return assistantContentHash(platform, sessionKey, content);
  }
  return sha256([platform, sessionKey, "assistant", "turn", turnId, content].join("\n"));
}

function assistantMessageHashes(platform: string, sessionKey: string, content: string, turnId?: string): string[] {
  const contentHash = assistantContentHash(platform, sessionKey, content);
  if (turnId === undefined) {
    return [contentHash];
  }
  return [assistantMessageDedupeHash(platform, sessionKey, content, turnId), contentHash];
}

function assistantContentHash(platform: string, sessionKey: string, content: string): string {
  return sha256([platform, sessionKey, "assistant", content].join("\n"));
}

function hasSeenAssistantMessage(state: AssistantMessageState, hash: string): boolean {
  return state.lastAssistantMessageHash === hash || state.seenAssistantMessageHashes.includes(hash);
}

function markAssistantMessageSeen(state: AssistantMessageState, hashes: string[]): void {
  state.lastAssistantMessageHash = hashes[0];
  for (const hash of hashes) {
    if (!state.seenAssistantMessageHashes.includes(hash)) {
      state.seenAssistantMessageHashes.push(hash);
    }
  }
}

function codexToolCallId(input: {
  sessionKey: string;
  toolName: string;
  turnId?: string;
  toolUseId?: string;
  toolInput: unknown;
}): string {
  if (input.toolUseId !== undefined) {
    return `codex-tool-use-id:${input.toolUseId}`;
  }
  return `codex-tool-fallback:${sha256(
    [input.sessionKey, input.turnId ?? "", input.toolName, serializeToolInput(input.toolInput)].join("\n"),
  )}`;
}

function codexReasoningStepHash(input: { sessionKey: string; toolName: string; turnId?: string }): string {
  return sha256([input.sessionKey, "codex-reasoning-step", input.turnId ?? "", input.toolName].join("\n"));
}

function codexTranscriptToolCallId(
  sessionKey: string,
  entry: Extract<CodexTranscriptEntry, { kind: "toolCall" }>,
): string {
  if (entry.id !== undefined) {
    return `codex-transcript-tool-id:${entry.id}`;
  }
  return `codex-transcript-tool-fallback:${sha256(
    [sessionKey, String(entry.transcriptEntryIndex), entry.name, serializeToolInput(entry.args)].join("\n"),
  )}`;
}

function codexTranscriptReasoningStepHash(sessionKey: string, toolName: string, status?: string): string {
  return sha256([sessionKey, "codex-transcript-reasoning-step", toolName, status ?? ""].join("\n"));
}

function markReasoningStepSeen(state: TraceState, hash: string, stepId: string | undefined): void {
  if (!state.seenReasoningStepHashes.includes(hash)) {
    state.seenReasoningStepHashes.push(hash);
  }
  if (stepId !== undefined) {
    state.reasoningStepIdsByHash[hash] = stepId;
  }
}

function markToolCallSeen(state: TraceState, toolCallId: string): void {
  if (!state.seenToolCallIds.includes(toolCallId)) {
    state.seenToolCallIds.push(toolCallId);
  }
}

async function appendNamsConfigDiagnostic(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
): Promise<void> {
  await appendCodexDiagnosticLog({
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
  await appendCodexDiagnosticLog({
    platform: invocation.platform,
    event: invocation.event,
    projectDirectory,
    state,
    payload: { message: "NAMS request failed" },
  });
}

async function appendNamsRequestLog(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
  payload: NamsRequestEvent,
  apiKey: string,
): Promise<void> {
  try {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      kind: "nams.request",
      projectDirectory,
      payload: sanitizeNamsRequestLogPayload(payload, apiKey) as Record<string, unknown>,
      sessionCreatedAt: state.createdAt,
      sessionKey: state.sessionKey,
    });
  } catch {
    // Codex hooks must not fail because observability writes failed.
  }
}

function sanitizeNamsRequestLogPayload(value: unknown, apiKey: string): unknown {
  if (typeof value === "string") {
    if (/authorization|bearer|api[-_ ]?key/i.test(value)) {
      return "[redacted]";
    }
    return redactSecretValue(value, apiKey);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeNamsRequestLogPayload(entry, apiKey));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isSensitiveLogKey(key)) {
      continue;
    }
    sanitized[key] = sanitizeNamsRequestLogPayload(nestedValue, apiKey);
  }
  return sanitized;
}

function isSensitiveLogKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "authorization" ||
    normalized === "apikey" ||
    normalized === "xapikey" ||
    normalized.includes("token") ||
    normalized.includes("secret")
  );
}

function redactSecretValue(value: string, secret: string): string {
  if (secret === "") {
    return value;
  }
  return value.split(secret).join("[redacted]");
}

async function appendRawPlatformLog(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
): Promise<void> {
  try {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      kind: "hook.event",
      payload: invocation.rawPayload,
      projectDirectory,
      sessionCreatedAt: state.createdAt,
      sessionKey: state.sessionKey,
    });
  } catch {
    // Codex hooks must not fail because observability writes failed.
  }
}

async function appendCodexDiagnosticLog(entry: {
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
      kind: "diagnostic",
      projectDirectory: entry.projectDirectory,
      payload: entry.payload,
      sessionCreatedAt: entry.state.createdAt,
      sessionKey: entry.state.sessionKey,
    });
  } catch {
    // Diagnostics are best-effort and must never block a hook response.
  }
}
