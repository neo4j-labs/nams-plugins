import { pickStringFields } from "../payload.js";

export interface GeminiPayloadInfo {
  sessionId?: string;
  projectDirectory: string;
  transcriptPath?: string;
  prompt?: string;
  promptResponse?: string;
}

export function parseGeminiPayload(payload: Record<string, unknown>, processCwd: string): GeminiPayloadInfo {
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
