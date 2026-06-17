import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
import { runSessionWorkspaceUseCommand, slashWorkspaceCommandUsage } from "../../runtime/workspace-use-command.js";
export class OpenCodeWorkspaceAdapter {
    async installConfigure(invocation) {
        return configureWorkspaceSelection(invocation);
    }
    async commandExecuteBefore(invocation) {
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
    }
}
function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
