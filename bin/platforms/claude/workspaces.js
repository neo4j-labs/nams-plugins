import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
import { runSessionWorkspaceUseCommand, slashWorkspaceCommandUsage } from "../../runtime/workspace-use-command.js";
export class ClaudeWorkspaceAdapter {
    async installConfigure(invocation) {
        return configureWorkspaceSelection(invocation);
    }
    async userPromptExpansion(invocation) {
        const result = await runSessionWorkspaceUseCommand(invocation, {
            commandName: stringValue(invocation.rawPayload.command_name),
            arguments: invocation.rawPayload.command_args,
            sessionId: stringValue(invocation.rawPayload.session_id),
            invalidSubcommandMode: "usage",
            sessionLabel: "Claude",
            usage: slashWorkspaceCommandUsage,
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
function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
