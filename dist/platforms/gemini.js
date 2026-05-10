import { appendPlatformLog } from "../runtime/logging.js";
export class GeminiAdapter {
    async startConversation(invocation) {
        await appendPlatformLog({
            platform: invocation.platform,
            event: invocation.event,
            payload: invocation.rawPayload,
            projectDirectory: resolveGeminiProjectDirectory(invocation),
        });
        return { stdout: { continue: true, suppressOutput: true } };
    }
}
function resolveGeminiProjectDirectory(invocation) {
    const value = invocation.rawPayload.cwd ?? invocation.rawPayload.GEMINI_PROJECT_DIR;
    return typeof value === "string" && value.trim() !== "" ? value : invocation.processCwd;
}
