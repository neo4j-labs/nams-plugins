import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { sha256, stableJsonHash } from "../../runtime/hashing.js";
import {
  appendNamsFailureDiagnostic,
  appendRawPlatformLog,
} from "../../runtime/logging.js";
import {
  combineMemoryContexts,
  createNamsMemoryService,
} from "../../runtime/memory-service.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
} from "../../runtime/workspace-resolution.js";
import { discoverClaudeNamsConfig } from "./config.js";
import { parseClaudePayload } from "./payload.js";

export class ClaudeAdapter implements MemoryPlatformAdapter {
  async startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    await appendRawPlatformLog(invocation, state);
    await saveSessionState(invocation.platform, state.sessionKey, state);

    return allowOutput();
  }

  async beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    await appendRawPlatformLog(invocation, state);

    if (payloadInfo.prompt === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const workspaceResult = await resolveWorkspaceForMemory({
      invocation,
      state,
      projectDirectory: payloadInfo.projectDirectory,
      interaction: "single-only",
      discoverConfig: discoverClaudeNamsConfig,
    });
    if (workspaceResult.status !== "ready") {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return workspaceResult.output;
    }
    const config = workspaceResult.config;

    let additionalContext: string | undefined;
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
        const recallContexts = await Promise.all([
          memory.recall(conversationId).catch(async () => {
            await appendNamsFailureDiagnostic(invocation, state);
            return "";
          }),
          memory.searchEntities(payloadInfo.prompt).catch(async () => {
            await appendNamsFailureDiagnostic(invocation, state);
            return "";
          }),
        ]);
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
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput(additionalContext);
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput(additionalContext);
  }

  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    state.seenAssistantMessageHashes ??= [];
    await appendRawPlatformLog(invocation, state);

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

  async afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    await appendRawPlatformLog(invocation, state);
    state.seenToolCallIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.reasoningStepIdsByHash ??= {};

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
