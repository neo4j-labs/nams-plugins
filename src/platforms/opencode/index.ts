import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import type { NamsRequestEvent } from "../../generated/nams-client.js";
import { loadNamsConfig, type NamsRuntimeConfig } from "../../runtime/config.js";
import { sha256, stableJsonHash } from "../../runtime/hashing.js";
import { appendPlatformLog } from "../../runtime/logging.js";
import { combineMemoryContexts, NamsMemoryService, serializeToolInput } from "../../runtime/memory-service.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import type { SessionState } from "../../runtime/session-state.js";
import { parseOpenCodePayload, type OpenCodePayloadInfo } from "./payload.js";

export interface OpenCodeAdapterOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export class OpenCodeAdapter implements PlatformAdapter {
  constructor(private readonly options: OpenCodeAdapterOptions = {}) {}

  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      projectDirectory: payloadInfo.projectDirectory,
      sessionId: payloadInfo.sessionId,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;

    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);
    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);

    return allowOutput();
  }

  async beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    if (payloadInfo.hookName === "experimental.chat.system.transform") {
      return consumePendingContext(invocation, payloadInfo);
    }
    if (payloadInfo.hookName !== "chat.message") {
      return allowOutput();
    }

    const initialState = createInitialSessionState({
      platform: invocation.platform,
      projectDirectory: payloadInfo.projectDirectory,
      sessionId: payloadInfo.sessionId,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);
    state.seenUserMessageIds ??= [];

    const userPrompt = payloadInfo.userPrompt;
    if (userPrompt === undefined || userPrompt.trim() === "") {
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
          recallContexts.push(await memory.searchEntities(userPrompt));
        } catch {
          await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
        }
        const createdAt = new Date().toISOString();
        state.lastRecallAt = createdAt;
        const recalledContext = combineMemoryContexts(recallContexts);
        if (recalledContext.trim() !== "") {
          state.pendingMemoryContext = {
            ...(payloadInfo.messageId !== undefined ? { messageId: payloadInfo.messageId } : {}),
            content: recalledContext,
            createdAt,
          };
        }
      }

      if (hasSeenUserMessage(state, payloadInfo.messageId, invocation.platform, userPrompt)) {
        await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
        return allowOutput();
      }

      await memory.storeUserMessage(conversationId, userPrompt);
      markUserMessageSeen(state, payloadInfo.messageId, invocation.platform, userPrompt);
    } catch {
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      projectDirectory: payloadInfo.projectDirectory,
      sessionId: payloadInfo.sessionId,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);
    state.seenAssistantPartIds ??= [];
    state.seenAssistantMessageHashes ??= [];

    if (payloadInfo.hookName !== "experimental.text.complete") {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    if (state.conversationId === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const assistantText = payloadInfo.assistantText?.trim();
    if (assistantText === undefined || assistantText === "") {
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
      const memory = this.createMemoryService(config, invocation, payloadInfo.projectDirectory, state);
      const assistantPartId = assistantPartKey(payloadInfo);
      if (assistantPartId !== undefined) {
        if (state.seenAssistantPartIds.includes(assistantPartId)) {
          await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
          return allowOutput();
        }

        await memory.storeAssistantMessage(state.conversationId, assistantText);
        markSeen(state.seenAssistantPartIds, [assistantPartId]);
      } else {
        const assistantHash = assistantMessageHash(invocation.platform, state.sessionKey, assistantText);
        if (!hasSeenAssistantMessage(state, assistantHash)) {
          await memory.storeAssistantMessage(state.conversationId, assistantText);
          markAssistantMessageSeen(state, assistantHash);
        }
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
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      projectDirectory: payloadInfo.projectDirectory,
      sessionId: payloadInfo.sessionId,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);
    state.seenToolCallIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.reasoningStepIdsByHash ??= {};

    if (state.conversationId === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    if (payloadInfo.hookName !== "tool.execute.after") {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    if (payloadInfo.toolName === undefined || payloadInfo.toolName.trim() === "") {
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
      const dedupeKey = opencodeToolCallDedupeKey(
        state.sessionKey,
        payloadInfo.toolCallId,
        payloadInfo.toolName,
        payloadInfo.toolInput,
      );
      if (!state.seenToolCallIds.includes(dedupeKey)) {
        const memory = this.createMemoryService(config, invocation, payloadInfo.projectDirectory, state);
        const reasoningStep = {
          conversationId: state.conversationId,
          reasoning: `OpenCode invoked ${payloadInfo.toolName} with the provided tool input.`,
          actionTaken: `Ran ${payloadInfo.toolName}`,
          ...(payloadInfo.toolTitle !== undefined ? { result: payloadInfo.toolTitle } : {}),
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
          toolName: payloadInfo.toolName,
          input: payloadInfo.toolInput,
          ...(payloadInfo.toolOutput !== undefined ? { output: payloadInfo.toolOutput } : {}),
          status: payloadInfo.toolStatus ?? "completed",
        });
        markSeen(state.seenToolCallIds, [dedupeKey]);
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, payloadInfo.projectDirectory, state);
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
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
      onRequest: (event) => appendNamsRequestLog(invocation, projectDirectory, state, event),
    });
  }
}

function allowOutput(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}

async function consumePendingContext(
  invocation: HookInvocation<"BeforeAgent">,
  payloadInfo: OpenCodePayloadInfo,
): Promise<HookResult> {
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    projectDirectory: payloadInfo.projectDirectory,
    sessionId: payloadInfo.sessionId,
  });
  const state =
    (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
  await appendRawPlatformLog(invocation, payloadInfo.projectDirectory, state);

  const pendingContext = state.pendingMemoryContext;
  if (pendingContext === undefined) {
    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  delete state.pendingMemoryContext;
  await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
  return {
    stdout: {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "BeforeAgent",
        additionalContext: pendingContext.content,
      },
    },
  };
}

function hasSeenUserMessage(
  state: SessionState,
  messageId: string | undefined,
  platform: HookInvocation["platform"],
  content: string,
): boolean {
  if (messageId !== undefined) {
    return state.seenUserMessageIds?.includes(messageId) === true;
  }
  return state.lastUserMessageHash === userMessageHash(platform, state.sessionKey, content);
}

function markUserMessageSeen(
  state: SessionState,
  messageId: string | undefined,
  platform: HookInvocation["platform"],
  content: string,
): void {
  state.seenUserMessageIds ??= [];
  if (messageId !== undefined && !state.seenUserMessageIds.includes(messageId)) {
    state.seenUserMessageIds.push(messageId);
    return;
  }
  state.lastUserMessageHash = userMessageHash(platform, state.sessionKey, content);
}

function userMessageHash(platform: HookInvocation["platform"], sessionKey: string, content: string): string {
  return sha256([platform, sessionKey, "user", content.trim()].join("\n"));
}

function assistantPartKey(payloadInfo: OpenCodePayloadInfo): string | undefined {
  if (payloadInfo.messageId === undefined || payloadInfo.partId === undefined) {
    return undefined;
  }
  return JSON.stringify([payloadInfo.messageId, payloadInfo.partId]);
}

function hasSeenAssistantMessage(state: SessionState, messageHash: string): boolean {
  return state.lastAssistantMessageHash === messageHash || state.seenAssistantMessageHashes.includes(messageHash);
}

function markAssistantMessageSeen(state: SessionState, messageHash: string): void {
  state.lastAssistantMessageHash = messageHash;
  markSeen(state.seenAssistantMessageHashes, [messageHash]);
}

function assistantMessageHash(platform: HookInvocation["platform"], sessionKey: string, content: string): string {
  return sha256([platform, sessionKey, "assistant", content.trim()].join("\n"));
}

function opencodeToolCallDedupeKey(
  sessionKey: string,
  toolCallId: string | undefined,
  toolName: string,
  toolInput: unknown,
): string {
  if (toolCallId !== undefined && toolCallId.trim() !== "") {
    return `opencode-call-id:${stableJsonHash({ sessionKey, toolCallId })}`;
  }
  return stableJsonHash({ sessionKey, toolName, input: serializeToolInput(toolInput) });
}

function markSeen(seen: string[], keys: string[]): void {
  for (const key of keys) {
    if (!seen.includes(key)) {
      seen.push(key);
    }
  }
}

async function appendNamsConfigDiagnostic(
  invocation: HookInvocation,
  projectDirectory: string,
  state: SessionState,
): Promise<void> {
  await appendOpenCodeDiagnosticLog({
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
  await appendOpenCodeDiagnosticLog({
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
): Promise<void> {
  await appendPlatformLog({
    platform: invocation.platform,
    event: invocation.event,
    kind: "nams.request",
    projectDirectory,
    payload: { ...payload },
    sessionCreatedAt: state.createdAt,
    sessionKey: state.sessionKey,
  });
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
    // OpenCode hooks must not fail because observability writes failed.
  }
}

async function appendOpenCodeDiagnosticLog(entry: {
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
