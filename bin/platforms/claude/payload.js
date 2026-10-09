import { pickStringFields } from "../payload.js";
export function parseClaudePayload(payload, processCwd) {
    const strings = pickStringFields(payload, {
        sessionId: "session_id",
        transcriptPath: "transcript_path",
        source: "source",
        prompt: "prompt",
        toolUseId: "tool_use_id",
        toolName: "tool_name",
        lastAssistantMessage: "last_assistant_message",
    });
    const projectDirectory = pickStringFields(payload, { cwd: "cwd" }).cwd ?? processCwd;
    const toolInput = payload.tool_input;
    const toolResponse = payload.tool_response;
    const durationMs = toNumber(payload.duration_ms);
    return {
        ...strings,
        projectDirectory,
        ...(toolInput !== undefined ? { toolInput } : {}),
        ...(toolResponse !== undefined ? { toolResponse } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
    };
}
function toNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return undefined;
}
