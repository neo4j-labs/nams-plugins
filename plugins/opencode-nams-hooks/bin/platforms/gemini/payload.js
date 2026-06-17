export function parseGeminiPayload(payload, processCwd) {
    const sessionId = payload.session_id;
    const projectDirectory = payload.cwd;
    const transcriptPath = payload.transcript_path;
    const prompt = payload.prompt;
    const promptResponse = payload.prompt_response;
    return {
        ...(!isBlankOrEmpty(sessionId) ? { sessionId } : {}),
        projectDirectory: !isBlankOrEmpty(projectDirectory) ? projectDirectory : processCwd,
        ...(!isBlankOrEmpty(transcriptPath) ? { transcriptPath } : {}),
        ...(!isBlankOrEmpty(prompt) ? { prompt } : {}),
        ...(!isBlankOrEmpty(promptResponse) ? { promptResponse } : {}),
    };
}
function isBlankOrEmpty(value) {
    return value === undefined || value.trim() === "";
}
