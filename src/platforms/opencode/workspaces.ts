import type { WorkspaceHookInvocation, WorkspaceHookResult, WorkspacePlatformAdapter } from "../../interfaces.js";
import { appendRawPlatformLog } from "../../runtime/logging.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
import {
  type PublicWorkspaceSummary,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
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
    return result.status === "ready" ? memoryReadyOutput() : workspaceResultOutput(result);
  }

  async installConfigure(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<WorkspaceHookResult> {
    return configureWorkspaceSelection(invocation);
  }
}

function memoryReadyOutput(): WorkspaceHookResult {
  return { stdout: { continue: true, suppressOutput: true, namsMemoryReady: true } };
}

function allowOutput(): WorkspaceHookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}

function workspaceResultOutput(result: Exclude<WorkspaceResolutionResult, { status: "ready" }>): WorkspaceHookResult {
  if (result.reason === "selection-required") {
    return {
      stdout: {
        continue: true,
        suppressOutput: true,
        namsWorkspaceSelectionRequired: true,
        reason: workspaceSelectionReason(result.workspaces),
      },
    };
  }
  return allowOutput();
}

function workspaceSelectionReason(workspaces: PublicWorkspaceSummary[]): string {
  return [
    "NAMS workspace selection required. Configure one workspace before memory starts:",
    ...workspaces.map((workspace, index) => {
      const name = workspace.name?.trim() || "(unnamed workspace)";
      const role = workspace.role?.trim() || "unknown-role";
      const status = workspace.status?.trim() || "unknown-status";
      return `${index + 1}. ${name} (${role}, ${status}) - ${workspace.id}`;
    }),
  ].join("\n");
}
