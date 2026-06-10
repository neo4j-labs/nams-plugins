import type { WorkspaceHookInvocation, WorkspaceHookResult, WorkspacePlatformAdapter } from "../../interfaces.js";
import { appendRawPlatformLog } from "../../runtime/logging.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";
import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
import {
  type PublicWorkspaceSummary,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
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
    });
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return result.status === "ready" ? allowOutput() : workspaceResultOutput(result);
  }

  async installConfigure(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<WorkspaceHookResult> {
    return configureWorkspaceSelection(invocation);
  }
}

function allowOutput(): WorkspaceHookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}

function workspaceResultOutput(result: Exclude<WorkspaceResolutionResult, { status: "ready" }>): WorkspaceHookResult {
  if (result.reason === "selection-required") {
    const message = workspaceSelectionReason(result.workspaces);
    return {
      stdout: {
        continue: true,
        suppressOutput: false,
        systemMessage: message,
        hookSpecificOutput: {
          additionalContext: message,
        },
      },
    };
  }
  return allowOutput();
}

function workspaceSelectionReason(workspaces: PublicWorkspaceSummary[]): string {
  return [
    "NAMS memory is inactive for this turn.",
    "No memory messages were stored. Multiple NAMS workspaces are available, and no workspaceId is configured.",
    "Configure an explicit workspace before memory can resume: nams-hooks workspaces configure gemini --scope project --workspace-id <workspace-id>",
    "Available NAMS workspaces:",
    ...workspaces.map((workspace, index) => {
      const name = workspace.name?.trim() || "(unnamed workspace)";
      const role = workspace.role?.trim() || "unknown-role";
      const status = workspace.status?.trim() || "unknown-status";
      return `${index + 1}. ${name} (${role}, ${status}) - ${workspace.id}`;
    }),
  ].join("\n");
}
