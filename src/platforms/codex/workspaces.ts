import type { HookResult, WorkspaceHookInvocation } from "../../interfaces.js";
import { codexWorkspaceCommandUsage, runActiveSessionWorkspaceUseCommand } from "../../runtime/workspace-use-command.js";
import { makeWorkspaceAdapter, stringValue } from "../workspaces.js";

export const codexWorkspaceAdapter = makeWorkspaceAdapter(
  "customCommand",
  async (invocation: WorkspaceHookInvocation<"CustomCommand">): Promise<HookResult> => {
    const result = await runActiveSessionWorkspaceUseCommand(invocation, {
      commandName: stringValue(invocation.rawPayload.command_name),
      arguments: invocation.rawPayload.command_args,
      projectDirectory: invocation.processCwd,
      sessionLabel: "Codex",
      usage: codexWorkspaceCommandUsage,
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
  },
);
