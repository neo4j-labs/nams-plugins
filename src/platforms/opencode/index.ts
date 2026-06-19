import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { hasSeenAssistantMessage, markAssistantMessageSeen, markSeen } from "../dedupe.js";
import { sha256, stableJsonHash } from "../../runtime/hashing.js";
import {
  appendNamsFailureDiagnostic,
  appendRawPlatformLog,
} from "../../runtime/logging.js";
import { combineMemoryContexts, createNamsMemoryService, serializeToolInput } from "../../runtime/memory-service.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import type { SessionState } from "../../runtime/session-state.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { parseOpenCodePayload, type OpenCodePayloadInfo } from "./payload.js";

async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      projectDirectory: payloadInfo.projectDirectory,
      sessionId: payloadInfo.sessionId,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;

    await appendRawPlatformLog(invocation, state);
    await saveSessionState(invocation.platform, state.sessionKey, state);

    return allowOutput();
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
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
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    await appendRawPlatformLog(invocation, state);
    state.seenUserMessageIds ??= [];

    const userPrompt = payloadInfo.userPrompt;
    if (userPrompt === undefined || userPrompt.trim() === "") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const workspaceResult = await resolveWorkspaceForMemory({
      invocation,
      state,
      projectDirectory: payloadInfo.projectDirectory,
    });
    if (workspaceResult.status !== "ready") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
    }
    const config = workspaceResult.config;

    try {
      const memory = createNamsMemoryService(config, invocation, state);

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
          await appendNamsFailureDiagnostic(invocation, state);
        }
        try {
          recallContexts.push(await memory.searchEntities(userPrompt));
        } catch {
          await appendNamsFailureDiagnostic(invocation, state);
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
        await saveSessionState(invocation.platform, state.sessionKey, state);
        return allowOutput();
      }

      await memory.storeUserMessage(conversationId, userPrompt);
      markUserMessageSeen(state, payloadInfo.messageId, invocation.platform, userPrompt);
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
}

async function afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      projectDirectory: payloadInfo.projectDirectory,
      sessionId: payloadInfo.sessionId,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    await appendRawPlatformLog(invocation, state);
    state.seenAssistantPartIds ??= [];
    state.seenAssistantMessageHashes ??= [];

    if (payloadInfo.hookName !== "experimental.text.complete") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    if (state.conversationId === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const assistantText = payloadInfo.assistantText?.trim();
    if (assistantText === undefined || assistantText === "") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
    if (config === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    try {
      const memory = createNamsMemoryService(config, invocation, state);
      const assistantPartId = assistantPartKey(payloadInfo);
      if (assistantPartId !== undefined) {
        if (state.seenAssistantPartIds.includes(assistantPartId)) {
          await saveSessionState(invocation.platform, state.sessionKey, state);
          return allowOutput();
        }

        await memory.storeAssistantMessage(state.conversationId, assistantText);
        markSeen(state.seenAssistantPartIds, [assistantPartId]);
      } else {
        const assistantHash = assistantMessageHash(invocation.platform, state.sessionKey, assistantText);
        if (!hasSeenAssistantMessage(state, assistantHash)) {
          await memory.storeAssistantMessage(state.conversationId, assistantText);
          markAssistantMessageSeen(state, [assistantHash]);
        }
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
}

async function afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      projectDirectory: payloadInfo.projectDirectory,
      sessionId: payloadInfo.sessionId,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    await appendRawPlatformLog(invocation, state);
    state.seenToolCallIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.reasoningStepIdsByHash ??= {};

    if (state.conversationId === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    if (payloadInfo.hookName !== "tool.execute.after") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    if (payloadInfo.toolName === undefined || payloadInfo.toolName.trim() === "") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
    if (config === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
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
        const memory = createNamsMemoryService(config, invocation, state);
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
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
}

export const opencodeMemoryAdapter: Required<MemoryPlatformAdapter> = { startSession, beforeAgent, afterAgent, afterTool };

function allowOutput(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}

function workspaceResultOutput(
  result: Exclude<WorkspaceResolutionResult, { status: "ready" }>,
  sessionId?: string,
): HookResult {
  if (result.reason === "selection-required") {
    return {
      stdout: {
        continue: true,
        suppressOutput: true,
        namsWorkspaceSelectionRequired: true,
        reason: formatWorkspaceSelectionNotice("opencode", result.workspaces, sessionId),
      },
    };
  }
  return allowOutput();
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
    (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
    initialState;
  await appendRawPlatformLog(invocation, state);

  const pendingContext = state.pendingMemoryContext;
  if (pendingContext === undefined) {
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  delete state.pendingMemoryContext;
  await saveSessionState(invocation.platform, state.sessionKey, state);
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
