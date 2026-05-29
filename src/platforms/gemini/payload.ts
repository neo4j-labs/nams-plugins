export interface GeminiPayloadInfo {
  sessionId?: string;
  projectDirectory: string;
  transcriptPath?: string;
  prompt?: string;
  promptResponse?: string;
}

export function parseGeminiPayload(payload: Record<string, unknown>, processCwd: string): GeminiPayloadInfo {
  const sessionId = payload.session_id as string | undefined;
  const projectDirectory = payload.cwd as string | undefined;
  const transcriptPath = payload.transcript_path as string | undefined;
  const prompt = payload.prompt as string | undefined;
  const promptResponse = payload.prompt_response as string | undefined;

  return {
    ...(!isBlankOrEmpty(sessionId) ? { sessionId } : {}),
    projectDirectory: !isBlankOrEmpty(projectDirectory) ? projectDirectory : processCwd,
    ...(!isBlankOrEmpty(transcriptPath) ? { transcriptPath } : {}),
    ...(!isBlankOrEmpty(prompt) ? { prompt } : {}),
    ...(!isBlankOrEmpty(promptResponse) ? { promptResponse } : {}),
  };
}

function isBlankOrEmpty(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === "";
}
