import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import { appendPlatformLog, appendRawPlatformLog } from "../../runtime/logging.js";
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
    await logClaudeInvocation(invocation);
    return allowOutput();
  }

  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    await logClaudeInvocation(invocation);
    return allowOutput();
  }

  async afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    await logClaudeInvocation(invocation);
    return allowOutput();
  }
}

async function logClaudeInvocation(invocation: HookInvocation): Promise<void> {
  await appendPlatformLog({
    platform: invocation.platform,
    event: invocation.event,
    payload: invocation.rawPayload
  });
}

function allowOutput(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}
