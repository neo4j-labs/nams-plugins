import type { WorkspaceHookInvocation, WorkspaceHookResult, WorkspacePlatformAdapter } from "../../interfaces.js";
import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
import { runActiveSessionWorkspaceUseCommand } from "../../runtime/workspace-use-command.js";

export class GeminiWorkspaceAdapter implements WorkspacePlatformAdapter {
  async installConfigure(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<WorkspaceHookResult> {
    return configureWorkspaceSelection(invocation);
  }

  async customCommand(invocation: WorkspaceHookInvocation<"CustomCommand">): Promise<WorkspaceHookResult> {
    const result = await runActiveSessionWorkspaceUseCommand(invocation, {
      commandName: stringValue(invocation.rawPayload.command_name),
      arguments: invocation.rawPayload.command_args,
      projectDirectory: invocation.processCwd,
      sessionLabel: "Gemini",
    });

    if (result.status === "ignored") {
      return { stdout: { continue: true, suppressOutput: true } };
    }

    const message = result.code === 0 ? result.stdout : result.stderr;
    return {
      stdout: {
        continue: result.code === 0,
        suppressOutput: false,
        exitCode: result.code,
        message,
      },
    };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
