import type { HookInvocation, HookResult, PlatformAdapter } from "../interfaces.js";
import { appendPlatformLog } from "../runtime/logging.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../runtime/session-state.js";
import { parseGeminiPayload } from "./gemini-payload.js";

export class GeminiAdapter implements PlatformAdapter {
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
    return logAndContinue(invocation);
  }

  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    return logAndContinue(invocation);
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

function resolveGeminiProjectDirectory(invocation: HookInvocation): string {
  const value = invocation.rawPayload.cwd ?? invocation.rawPayload.GEMINI_PROJECT_DIR;
  return typeof value === "string" && value.trim() !== "" ? value : invocation.processCwd;
}
