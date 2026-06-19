import type { HookResult, WorkspaceHookInvocation } from "../../interfaces.js";
import { runSessionWorkspaceUseCommand, slashWorkspaceCommandUsage } from "../../runtime/workspace-use-command.js";
import { makeWorkspaceAdapter, stringValue } from "../workspaces.js";

export const opencodeWorkspaceAdapter = makeWorkspaceAdapter(
  "commandExecuteBefore",
  async (invocation: WorkspaceHookInvocation<"CommandExecuteBefore">): Promise<HookResult> => {
    const result = await runSessionWorkspaceUseCommand(invocation, {
      commandName: stringValue(invocation.rawPayload.command),
      arguments: invocation.rawPayload.arguments,
      sessionId: stringValue(invocation.rawPayload.sessionID),
      invalidSubcommandMode: "ignore",
      sessionLabel: "OpenCode",
      usage: slashWorkspaceCommandUsage,
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
  },
);
