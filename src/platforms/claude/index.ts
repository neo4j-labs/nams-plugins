import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import { loadNamsConfig } from "../../runtime/config.js";
import { sha256 } from "../../runtime/hashing.js";
import {
  appendNamsConfigDiagnostic,
  appendNamsFailureDiagnostic,
  appendRawPlatformLog,
} from "../../runtime/logging.js";
import {
  combineMemoryContexts,
  createNamsMemoryService,
} from "../../runtime/memory-service.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import { parseClaudePayload } from "./payload.js";

export class ClaudeAdapter implements PlatformAdapter {
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

    const configResult = await loadNamsConfig(payloadInfo.projectDirectory);
    await appendNamsConfigDiagnostic(invocation, state, configResult);
    if (!configResult.ok) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }
    const config = configResult.config;

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

    const configResult = await loadNamsConfig(payloadInfo.projectDirectory);
    await appendNamsConfigDiagnostic(invocation, state, configResult);
    if (!configResult.ok) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const assistantMessageHash = sha256([invocation.platform, state.sessionKey, "assistant", response].join("\n"));
    const alreadySeen =
      state.lastAssistantMessageHash === assistantMessageHash ||
      state.seenAssistantMessageHashes.includes(assistantMessageHash);

    try {
      if (!alreadySeen) {
        const memory = createNamsMemoryService(configResult.config, invocation, state);
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
    await appendRawPlatformLog(invocation);
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
