import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { appendRawPlatformLog } from "../../runtime/logging.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import { parseAntigravityPayload } from "./payload.js";

async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
  return logOnly(invocation);
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
  return logOnly(invocation);
}

async function afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
  return logOnly(invocation);
}

async function afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
  return logOnly(invocation);
}

async function logOnly(invocation: HookInvocation): Promise<HookResult> {
  const payloadInfo = parseAntigravityPayload(invocation.rawPayload, invocation.processCwd);
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    projectDirectory: payloadInfo.projectDirectory,
    sessionId: payloadInfo.conversationId,
  });
  const state =
    (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
    initialState;

  await appendRawPlatformLog(invocation, state);
  await saveSessionState(invocation.platform, state.sessionKey, state);

  return { stdout: {} };
}

export const antigravityMemoryAdapter: Required<MemoryPlatformAdapter> = {
  startSession,
  beforeAgent,
  afterAgent,
  afterTool,
};
