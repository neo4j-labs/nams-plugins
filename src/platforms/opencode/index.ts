import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { markSeen } from "../../runtime/dedupe.js";
import { sha256, stableJsonHash } from "../../runtime/hashing.js";
import {
  assistantContentHash,
  ensureConversation,
  recallMemoryContextOnce,
  recordToolCallOnce,
  storeAssistantMessageOnce,
  withHookSessionState,
} from "../../runtime/memory-turn.js";
import {
  appendNamsFailureDiagnostic,
} from "../../runtime/logging.js";
import { createNamsMemoryService, serializeToolInput } from "../../runtime/memory-service.js";
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
    return withHookSessionState(invocation, payloadInfo, async () => allowOutput());
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    if (payloadInfo.hookName === "experimental.chat.system.transform") {
      return consumePendingContext(invocation, payloadInfo);
    }
    if (payloadInfo.hookName !== "chat.message") {
      return allowOutput();
    }

    return withHookSessionState(invocation, payloadInfo, async (state) => {
      state.seenUserMessageIds ??= [];

      const userPrompt = payloadInfo.userPrompt;
      if (userPrompt === undefined || userPrompt.trim() === "") {
        return allowOutput();
      }

      const workspaceResult = await resolveWorkspaceForMemory({
        invocation,
        state,
        projectDirectory: payloadInfo.projectDirectory,
      });
      if (workspaceResult.status !== "ready") {
        return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
      }

      try {
        const memory = createNamsMemoryService(workspaceResult.config, invocation, state);
        const conversationId = await ensureConversation(memory, invocation, state, payloadInfo.projectDirectory);

        const recalledContext = await recallMemoryContextOnce(memory, invocation, state, conversationId, userPrompt);
        if (recalledContext !== undefined) {
          state.pendingMemoryContext = {
            ...(payloadInfo.messageId !== undefined ? { messageId: payloadInfo.messageId } : {}),
            content: recalledContext,
            createdAt: state.lastRecallAt ?? new Date().toISOString(),
          };
        }

        if (!hasSeenUserMessage(state, payloadInfo.messageId, invocation.platform, userPrompt)) {
          await memory.storeUserMessage(conversationId, userPrompt);
          markUserMessageSeen(state, payloadInfo.messageId, invocation.platform, userPrompt);
        }
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowOutput();
    });
}

async function afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      state.seenAssistantPartIds ??= [];

      if (payloadInfo.hookName !== "experimental.text.complete") {
        return allowOutput();
      }

      if (state.conversationId === undefined) {
        return allowOutput();
      }

      const assistantText = payloadInfo.assistantText?.trim();
      if (assistantText === undefined || assistantText === "") {
        return allowOutput();
      }

      const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
      if (config === undefined) {
        return allowOutput();
      }

      try {
        const memory = createNamsMemoryService(config, invocation, state);
        const assistantPartId = assistantPartKey(payloadInfo);
        if (assistantPartId !== undefined) {
          if (!state.seenAssistantPartIds.includes(assistantPartId)) {
            await memory.storeAssistantMessage(state.conversationId, assistantText);
            markSeen(state.seenAssistantPartIds, [assistantPartId]);
          }
        } else {
          const assistantHash = assistantContentHash(invocation.platform, state.sessionKey, assistantText);
          await storeAssistantMessageOnce(memory, state, state.conversationId, assistantText, {
            lookupHash: assistantHash,
            markHashes: [assistantHash],
          });
        }
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowOutput();
    });
}

async function afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      if (state.conversationId === undefined) {
        return allowOutput();
      }

      if (payloadInfo.hookName !== "tool.execute.after") {
        return allowOutput();
      }

      if (payloadInfo.toolName === undefined || payloadInfo.toolName.trim() === "") {
        return allowOutput();
      }

      const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
      if (config === undefined) {
        return allowOutput();
      }

      try {
        const memory = createNamsMemoryService(config, invocation, state);
        const dedupeKey = opencodeToolCallDedupeKey(
          state.sessionKey,
          payloadInfo.toolCallId,
          payloadInfo.toolName,
          payloadInfo.toolInput,
        );
        const reasoningStep = {
          conversationId: state.conversationId,
          reasoning: `OpenCode invoked ${payloadInfo.toolName} with the provided tool input.`,
          actionTaken: `Ran ${payloadInfo.toolName}`,
          ...(payloadInfo.toolTitle !== undefined ? { result: payloadInfo.toolTitle } : {}),
        };
        await recordToolCallOnce(
          memory,
          state,
          { lookupKeys: [dedupeKey], markKeys: [dedupeKey] },
          reasoningStep,
          stableJsonHash({ sessionKey: state.sessionKey, ...reasoningStep }),
          {
            toolName: payloadInfo.toolName,
            input: payloadInfo.toolInput,
            ...(payloadInfo.toolOutput !== undefined ? { output: payloadInfo.toolOutput } : {}),
            status: payloadInfo.toolStatus ?? "completed",
          },
        );
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowOutput();
    });
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
  return withHookSessionState(invocation, payloadInfo, async (state) => {
    const pendingContext = state.pendingMemoryContext;
    if (pendingContext === undefined) {
      return allowOutput();
    }

    delete state.pendingMemoryContext;
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
  });
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
