export function parseCodexPayload(payload, processCwd) {
    const sessionId = payload.session_id;
    const turnId = payload.turn_id;
    const projectDirectory = payload.cwd;
    const transcriptPath = payload.transcript_path;
    const hookEventName = payload.hook_event_name;
    const source = payload.source;
    const model = payload.model;
    const permissionMode = payload.permission_mode;
    const prompt = payload.prompt;
    const lastAssistantMessage = payload.last_assistant_message;
    const stopHookActive = typeof payload.stop_hook_active === "boolean" ? payload.stop_hook_active : undefined;
    const toolName = payload.tool_name;
    const toolUseId = payload.tool_use_id;
    const toolInput = payload.tool_input;
    const toolResponse = payload.tool_response;
    return {
        ...(!isBlankOrEmpty(sessionId) ? { sessionId } : {}),
        ...(!isBlankOrEmpty(turnId) ? { turnId } : {}),
        projectDirectory: !isBlankOrEmpty(projectDirectory) ? projectDirectory : processCwd,
        ...(!isBlankOrEmpty(transcriptPath) ? { transcriptPath } : {}),
        ...(!isBlankOrEmpty(hookEventName) ? { hookEventName } : {}),
        ...(!isBlankOrEmpty(source) ? { source } : {}),
        ...(!isBlankOrEmpty(model) ? { model } : {}),
        ...(!isBlankOrEmpty(permissionMode) ? { permissionMode } : {}),
        ...(!isBlankOrEmpty(prompt) ? { prompt } : {}),
        ...(!isBlankOrEmpty(lastAssistantMessage) ? { lastAssistantMessage } : {}),
        ...(stopHookActive !== undefined ? { stopHookActive } : {}),
        ...(!isBlankOrEmpty(toolName) ? { toolName } : {}),
        ...(!isBlankOrEmpty(toolUseId) ? { toolUseId } : {}),
        ...(toolInput !== undefined ? { toolInput } : {}),
        ...(toolResponse !== undefined ? { toolResponse } : {}),
    };
}
function isBlankOrEmpty(value) {
    return value === undefined || value.trim() === "";
}
