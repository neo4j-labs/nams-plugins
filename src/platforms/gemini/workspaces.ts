import type { WorkspaceHookInvocation, WorkspaceHookResult, WorkspacePlatformAdapter } from "../../interfaces.js";
import { appendRawPlatformLog } from "../../runtime/logging.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
import { resolveWorkspaceForMemory } from "../../runtime/workspace-resolution.js";
import { parseGeminiPayload } from "./payload.js";

export class GeminiWorkspaceAdapter implements WorkspacePlatformAdapter {
  async beforeAgent(invocation: WorkspaceHookInvocation<"BeforeAgent">): Promise<WorkspaceHookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendRawPlatformLog(invocation, state);

    const result = await resolveWorkspaceForMemory({
      invocation,
      state,
      projectDirectory: payloadInfo.projectDirectory,
      interaction: "gemini-blocking",
    });
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return result.status === "ready" ? allowOutput() : result.output;
  }

  async installConfigure(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<WorkspaceHookResult> {
    return configureWorkspaceSelection(invocation);
  }
}

function allowOutput(): WorkspaceHookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}
