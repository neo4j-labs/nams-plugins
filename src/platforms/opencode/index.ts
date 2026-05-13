import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import { appendPlatformLog } from "../../runtime/logging.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import { parseOpenCodePayload } from "./payload.js";

export class OpenCodeAdapter implements PlatformAdapter {
  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      projectDirectory: payloadInfo.projectDirectory,
      sessionId: payloadInfo.sessionId,
    });
    const state =
      (await loadSessionState(payloadInfo.projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;

    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: payloadInfo.projectDirectory,
      sessionCreatedAt: state.createdAt,
      sessionKey: state.sessionKey,
    });
    await saveSessionState(payloadInfo.projectDirectory, invocation.platform, state.sessionKey, state);

    return allowOutput();
  }

  async beforeAgent(_invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    return allowOutput();
  }

  async afterAgent(_invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    return allowOutput();
  }

  async afterTool(_invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    return allowOutput();
  }
}

function allowOutput(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}
