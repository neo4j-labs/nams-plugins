import type { WorkspaceHookInvocation, WorkspaceHookResult, WorkspacePlatformAdapter } from "../../interfaces.js";
import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
import { runSessionWorkspaceUseCommand } from "../../runtime/workspace-use-command.js";

export class OpenCodeWorkspaceAdapter implements WorkspacePlatformAdapter {
  async installConfigure(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<WorkspaceHookResult> {
    return configureWorkspaceSelection(invocation);
  }

  async commandExecuteBefore(invocation: WorkspaceHookInvocation<"CommandExecuteBefore">): Promise<WorkspaceHookResult> {
    const result = await runSessionWorkspaceUseCommand(invocation, {
      commandName: stringValue(invocation.rawPayload.command),
      arguments: invocation.rawPayload.arguments,
      sessionId: stringValue(invocation.rawPayload.sessionID),
      invalidSubcommandMode: "ignore",
      sessionLabel: "OpenCode",
    });

    if (result.status === "ignored") {
      return { stdout: {} };
    }

    return {
      stdout: {
        stop: true,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
