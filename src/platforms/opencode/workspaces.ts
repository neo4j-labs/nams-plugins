import type { WorkspaceHookInvocation, WorkspaceHookResult, WorkspacePlatformAdapter } from "../../interfaces.js";
import { appendRawPlatformLog } from "../../runtime/logging.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import { resolveWorkspaceForMemory } from "../../runtime/workspace-resolution.js";
import { parseOpenCodePayload } from "./payload.js";

export class OpenCodeWorkspaceAdapter implements WorkspacePlatformAdapter {
  async beforeAgent(invocation: WorkspaceHookInvocation<"BeforeAgent">): Promise<WorkspaceHookResult> {
    const payloadInfo = parseOpenCodePayload(invocation.rawPayload, invocation.processCwd);
    if (payloadInfo.hookName !== "chat.message") {
      return allowOutput();
    }

    const initialState = createInitialSessionState({
      platform: invocation.platform,
      projectDirectory: payloadInfo.projectDirectory,
      sessionId: payloadInfo.sessionId,
    });
    const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendRawPlatformLog(invocation, state);

    const result = await resolveWorkspaceForMemory({
      invocation,
      state,
      projectDirectory: payloadInfo.projectDirectory,
      interaction: "single-only",
    });
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return result.status === "ready" ? memoryReadyOutput() : result.output;
  }
}

function memoryReadyOutput(): WorkspaceHookResult {
  return { stdout: { continue: true, suppressOutput: true, namsMemoryReady: true } };
}

function allowOutput(): WorkspaceHookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}
