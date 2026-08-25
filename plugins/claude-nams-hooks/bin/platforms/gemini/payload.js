import { pickStringFields } from "../payload.js";
export function parseGeminiPayload(payload, processCwd) {
    const strings = pickStringFields(payload, {
        sessionId: "session_id",
        transcriptPath: "transcript_path",
        prompt: "prompt",
        promptResponse: "prompt_response",
    });
    const projectDirectory = pickStringFields(payload, { cwd: "cwd" }).cwd ?? processCwd;
    return {
        ...strings,
        projectDirectory,
    };
}
