import type { WorkspaceHookInvocation, WorkspaceHookResult } from "../../interfaces.js";
import { runSessionWorkspaceUseCommand, slashWorkspaceCommandUsage } from "../../runtime/workspace-use-command.js";
import { makeWorkspaceAdapter, stringValue } from "../workspaces.js";

const claudeWorkspaceCommandUsage = [
  slashWorkspaceCommandUsage,
  "Marketplace plugin: /nams-hooks:nams:workspace use <workspace-id-or-name>",
].join("\n");

export const claudeWorkspaceAdapter = makeWorkspaceAdapter(
  "userPromptExpansion",
  async (invocation: WorkspaceHookInvocation<"UserPromptExpansion">): Promise<WorkspaceHookResult> => {
    const result = await runSessionWorkspaceUseCommand(invocation, {
      commandName: stringValue(invocation.rawPayload.command_name),
      arguments: invocation.rawPayload.command_args,
      sessionId: stringValue(invocation.rawPayload.session_id),
      invalidSubcommandMode: "usage",
      sessionLabel: "Claude",
      usage: claudeWorkspaceCommandUsage,
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
  },
);
