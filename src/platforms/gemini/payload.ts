export interface GeminiPayloadInfo {
  sessionId?: string;
  projectDirectory: string;
  transcriptPath?: string;
  prompt?: string;
  promptResponse?: string;
}

export function parseGeminiPayload(payload: Record<string, unknown>, processCwd: string): GeminiPayloadInfo {
  const sessionId = firstString(payload.session_id, payload.sessionId);
  const projectDirectory = firstString(payload.cwd, payload.GEMINI_PROJECT_DIR) ?? processCwd;
  const transcriptPath = firstString(payload.transcript_path, payload.transcriptPath);
  const prompt = firstString(payload.prompt, payload.user_prompt, payload.userPrompt);
  const promptResponse = firstString(payload.prompt_response, payload.promptResponse);

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    projectDirectory,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(promptResponse !== undefined ? { promptResponse } : {}),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}
