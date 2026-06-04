export function parseClaudePayload(payload, processCwd) {
    const sessionId = payload.session_id;
    const projectDirectory = payload.cwd ?? processCwd;
    const transcriptPath = payload.transcript_path;
    const source = payload.source;
    const prompt = payload.prompt;
    const toolUseId = payload.tool_use_id;
    const toolName = payload.tool_name;
    const toolInput = payload.tool_input;
    const toolResponse = payload.tool_response;
    const durationMs = toNumber(payload.duration_ms);
    const lastAssistantMessage = payload.last_assistant_message;
    return {
        ...(!isBlankOrEmpty(sessionId) ? { sessionId } : {}),
        projectDirectory: !isBlankOrEmpty(projectDirectory) ? projectDirectory : processCwd,
        ...(!isBlankOrEmpty(transcriptPath) ? { transcriptPath } : {}),
        ...(!isBlankOrEmpty(source) ? { source } : {}),
        ...(!isBlankOrEmpty(prompt) ? { prompt } : {}),
        ...(!isBlankOrEmpty(toolUseId) ? { toolUseId } : {}),
        ...(!isBlankOrEmpty(toolName) ? { toolName } : {}),
        ...(toolInput !== undefined ? { toolInput } : {}),
        ...(toolResponse !== undefined ? { toolResponse } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(!isBlankOrEmpty(lastAssistantMessage) ? { lastAssistantMessage } : {}),
    };
}
function isBlankOrEmpty(value) {
    return value === undefined || value.trim() === "";
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
