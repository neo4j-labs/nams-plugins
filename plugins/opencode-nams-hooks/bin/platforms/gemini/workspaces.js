import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
import { runActiveSessionWorkspaceUseCommand, slashWorkspaceCommandUsage } from "../../runtime/workspace-use-command.js";
export class GeminiWorkspaceAdapter {
    async installConfigure(invocation) {
        return configureWorkspaceSelection(invocation);
    }
    async customCommand(invocation) {
        const result = await runActiveSessionWorkspaceUseCommand(invocation, {
            commandName: stringValue(invocation.rawPayload.command_name),
            arguments: invocation.rawPayload.command_args,
            projectDirectory: invocation.processCwd,
            sessionLabel: "Gemini",
            usage: slashWorkspaceCommandUsage,
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
function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
