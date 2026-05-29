export interface ClaudePayloadInfo {
  sessionId?: string;
  projectDirectory: string;
  transcriptPath?: string;
  source?: string;
  prompt?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  durationMs?: number;
  lastAssistantMessage?: string;
}

export function parseClaudePayload(payload: Record<string, unknown>, processCwd: string): ClaudePayloadInfo {
  const sessionId = payload.session_id as string | undefined;
  const projectDirectory = payload.cwd as string | undefined ?? processCwd;
  const transcriptPath = payload.transcript_path as string | undefined;
  const source = payload.source as string | undefined;
  const prompt = payload.prompt as string | undefined;
  const toolUseId = payload.tool_use_id as string | undefined;
  const toolName = payload.tool_name as string | undefined;
  const toolInput = payload.tool_input;
  const toolResponse = payload.tool_response;
  const durationMs = toNumber(payload.duration_ms);
  const lastAssistantMessage = payload.last_assistant_message as string | undefined;

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

function isBlankOrEmpty(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === "";
}

function toNumber(value: unknown): number | undefined {
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
