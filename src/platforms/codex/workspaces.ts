import type { WorkspaceHookResult, WorkspacePlatformAdapter } from "../../interfaces.js";

export class CodexWorkspaceAdapter implements WorkspacePlatformAdapter {
  async installConfigure(): Promise<WorkspaceHookResult> {
    return {
      stdout: {
        continue: true,
        suppressOutput: true,
        message: "NAMS workspace configuration should be provided through nams-hooks workspaces configure or .nams/config.json.",
      },
    };
  }
}
