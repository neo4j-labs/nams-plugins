import { appendPlatformLog } from "../runtime/logging.js";
export class CodexAdapter {
    async startConversation(invocation) {
        await appendPlatformLog({
            platform: invocation.platform,
            event: invocation.event,
            payload: invocation.rawPayload,
            projectDirectory: resolveCodexProjectDirectory(invocation),
        });
        return { stdout: { continue: true, suppressOutput: true } };
    }
}
function resolveCodexProjectDirectory(invocation) {
    const value = invocation.rawPayload.cwd;
    return typeof value === "string" && value.trim() !== "" ? value : invocation.processCwd;
}
