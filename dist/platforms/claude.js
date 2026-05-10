import { appendPlatformLog } from "../runtime/logging.js";
export class ClaudeAdapter {
    async startConversation(invocation) {
        await appendPlatformLog({
            platform: invocation.platform,
            event: invocation.event,
            payload: invocation.rawPayload,
            projectDirectory: resolveClaudeProjectDirectory(invocation),
        });
        return { stdout: { continue: true, suppressOutput: true } };
    }
}
function resolveClaudeProjectDirectory(invocation) {
    const value = invocation.rawPayload.cwd;
    return typeof value === "string" && value.trim() !== "" ? value : invocation.processCwd;
}
