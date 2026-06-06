import type { WorkspaceHookResult, WorkspacePlatformAdapter } from "../../interfaces.js";

export class ClaudeWorkspaceAdapter implements WorkspacePlatformAdapter {
  async installConfigure(): Promise<WorkspaceHookResult> {
    return {
      stdout: {
        continue: true,
        suppressOutput: true,
        message: "NAMS workspace configuration should be provided through Claude plugin userConfig or .nams/config.json.",
      },
    };
  }
}
