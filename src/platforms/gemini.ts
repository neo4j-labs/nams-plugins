import type { HookInvocation, HookResult, PlatformAdapter } from "../interfaces.js";
import { loadNamsConfig } from "../runtime/config.js";
import { sha256 } from "../runtime/hashing.js";
import { appendPlatformLog } from "../runtime/logging.js";
import { NamsMemoryService } from "../runtime/memory-service.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../runtime/session-state.js";
import { parseGeminiPayload } from "./gemini-payload.js";
import { readGeminiTranscript } from "./gemini-transcript.js";

export interface GeminiAdapterOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export class GeminiAdapter implements PlatformAdapter {
  constructor(private readonly options: GeminiAdapterOptions = {}) {}

  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: resolveGeminiProjectDirectory(invocation),
    });

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
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: resolveGeminiProjectDirectory(invocation),
    });

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
        const recalledContext = await memory.recall(conversationId);
        state.lastMemorySearchAt = new Date().toISOString();
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
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
    return allowOutput(additionalContext);
  }

  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: resolveGeminiProjectDirectory(invocation),
    });

    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;
    state.seenAssistantMessageHashes ??= [];

    if (state.conversationId === undefined) {
      await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const config = await loadNamsConfig(payloadInfo.projectDirectory, this.options.env);
    if (config === null) {
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
      } else if (payloadInfo.transcriptPath !== undefined) {
        const entries = await readGeminiTranscript(payloadInfo.transcriptPath);
        for (const entry of entries) {
          if (entry.kind !== "assistant") {
            continue;
          }
          if (entry.id !== undefined && state.seenTranscriptEntryIds.includes(entry.id)) {
            continue;
          }

          const content = entry.content.trim();
          if (content !== "") {
            const responseHash = sha256([invocation.platform, state.sessionKey, "assistant", content].join("\n"));
            if (!hasSeenAssistantMessage(state, responseHash)) {
              await memory.storeAssistantMessage(state.conversationId, content);
            }
            markAssistantMessageSeen(state, responseHash);
          }

          if (entry.id !== undefined) {
            state.seenTranscriptEntryIds.push(entry.id);
          }
        }
      }
    } catch {
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
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: resolveGeminiProjectDirectory(invocation),
    });
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

type AssistantMessageState = {
  lastAssistantMessageHash?: string;
  seenAssistantMessageHashes: string[];
};

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
