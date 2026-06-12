import type { WorkspaceHookInvocation, WorkspaceHookResult, WorkspacePlatformAdapter } from "../../interfaces.js";
import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
import { runSessionWorkspaceUseCommand } from "../../runtime/workspace-use-command.js";

export class ClaudeWorkspaceAdapter implements WorkspacePlatformAdapter {
  async installConfigure(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<WorkspaceHookResult> {
    return configureWorkspaceSelection(invocation);
  }

  async userPromptExpansion(invocation: WorkspaceHookInvocation<"UserPromptExpansion">): Promise<WorkspaceHookResult> {
    const result = await runSessionWorkspaceUseCommand(invocation, {
      commandName: stringValue(invocation.rawPayload.command_name),
      arguments: invocation.rawPayload.command_args,
      sessionId: stringValue(invocation.rawPayload.session_id),
      invalidSubcommandMode: "usage",
      sessionLabel: "Claude",
    });

    if (result.status === "ignored") {
      return { stdout: { continue: true, suppressOutput: true } };
    }

    return {
      stdout: {
        decision: "block",
        reason: result.code === 0 ? result.stdout : result.stderr,
      },
    };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
