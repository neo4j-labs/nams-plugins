import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { sha256, stableJsonHash } from "../../runtime/hashing.js";
import { hasSeenAny, markSeen } from "../dedupe.js";
import { appendNamsFailureDiagnostic } from "../../runtime/logging.js";
import { createNamsMemoryService } from "../../runtime/memory-service.js";
import {
  ensureConversation,
  loadHookSessionState,
  recallMemoryContextOnce,
  storeUserPromptOnce,
} from "../../runtime/memory-turn.js";
import { saveSessionState } from "../../runtime/session-state.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { discoverClaudeNamsConfig } from "./config.js";
import { parseClaudePayload } from "./payload.js";

async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);
    await saveSessionState(invocation.platform, state.sessionKey, state);

    return allowOutput();
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);

    if (payloadInfo.prompt === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const workspaceResult = await resolveWorkspaceForMemory({
      invocation,
      state,
      projectDirectory: payloadInfo.projectDirectory,
      discoverConfig: discoverClaudeNamsConfig,
    });
    if (workspaceResult.status !== "ready") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
    }

    let additionalContext: string | undefined;
    try {
      const memory = createNamsMemoryService(workspaceResult.config, invocation, state);
      const conversationId = await ensureConversation(memory, invocation, state, payloadInfo.projectDirectory);
      additionalContext = await recallMemoryContextOnce(memory, invocation, state, conversationId, payloadInfo.prompt);
      await storeUserPromptOnce(memory, invocation, state, conversationId, payloadInfo.prompt);
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput(additionalContext);
}

async function afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);

    if (state.conversationId === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const response = payloadInfo.lastAssistantMessage?.trim();
    if (response === undefined || response === "") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const config = await loadEffectiveNamsConfigForMemory(
      invocation,
      state,
      payloadInfo.projectDirectory,
      discoverClaudeNamsConfig,
    );
    if (config === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const assistantMessageHash = sha256([invocation.platform, state.sessionKey, "assistant", response].join("\n"));
    const alreadySeen =
      state.lastAssistantMessageHash === assistantMessageHash ||
      state.seenAssistantMessageHashes.includes(assistantMessageHash);

    try {
      if (!alreadySeen) {
        const memory = createNamsMemoryService(config, invocation, state);
        await memory.storeAssistantMessage(state.conversationId, response);
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    state.lastAssistantMessageHash = assistantMessageHash;
    if (!state.seenAssistantMessageHashes.includes(assistantMessageHash)) {
      state.seenAssistantMessageHashes.push(assistantMessageHash);
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
}

async function afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const state = await loadHookSessionState(invocation, payloadInfo);

    if (state.conversationId === undefined || payloadInfo.toolName === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const config = await loadEffectiveNamsConfigForMemory(
      invocation,
      state,
      payloadInfo.projectDirectory,
      discoverClaudeNamsConfig,
    );
    if (config === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    try {
      const toolCallKeys = claudeToolCallDedupeKeys(
        state.sessionKey,
        payloadInfo.toolUseId,
        payloadInfo.toolName,
        payloadInfo.toolInput,
      );
      if (!hasSeenAny(state.seenToolCallIds, toolCallKeys.lookupKeys)) {
        const memory = createNamsMemoryService(config, invocation, state);
        const reasoningStep = {
          conversationId: state.conversationId,
          reasoning: `Claude Code ran ${payloadInfo.toolName} with the provided tool input.`,
          actionTaken: `Ran ${payloadInfo.toolName}`,
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
          ...(payloadInfo.toolResponse !== undefined ? { output: payloadInfo.toolResponse } : {}),
          status: "success",
          ...(payloadInfo.durationMs !== undefined ? { durationMs: payloadInfo.durationMs } : {}),
        });
        markSeen(state.seenToolCallIds, toolCallKeys.markKeys);
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
}

export const claudeMemoryAdapter: Required<MemoryPlatformAdapter> = { startSession, beforeAgent, afterAgent, afterTool };

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

function workspaceResultOutput(
  result: Exclude<WorkspaceResolutionResult, { status: "ready" }>,
  sessionId?: string,
): HookResult {
  if (result.reason === "selection-required") {
    const message = formatWorkspaceSelectionNotice("claude", result.workspaces, sessionId, [
      "In Claude Code sessions with nams-hooks installed, you can select a workspace with: /nams:workspace use <workspace-id-or-name>",
      "For marketplace plugin installs, use: /nams-hooks:nams:workspace use <workspace-id-or-name>",
    ]);
    return {
      stdout: {
        continue: true,
        suppressOutput: false,
        systemMessage: message,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: message,
        },
      },
    };
  }
  return allowOutput();
}

function claudeToolCallDedupeKeys(
  sessionKey: string,
  toolUseId: string | undefined,
  toolName: string,
  toolInput: unknown,
): { lookupKeys: string[]; markKeys: string[] } {
  const fallbackHash = stableJsonHash({ sessionKey, toolName, input: toolInput });
  const fallbackKey = `claude-fallback:${fallbackHash}`;

  if (toolUseId !== undefined && toolUseId.trim() !== "") {
    const idKey = `claude-tool-use-id:${stableJsonHash({ sessionKey, toolUseId })}`;
    return {
      lookupKeys: [idKey],
      markKeys: [idKey],
    };
  }

  return {
    lookupKeys: [fallbackKey, fallbackHash],
    markKeys: [fallbackKey, fallbackHash],
  };
}
