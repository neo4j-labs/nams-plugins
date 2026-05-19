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
  const sessionId = firstString(payload.session_id, payload.sessionId);
  const projectDirectory = firstString(payload.cwd, payload.CLAUDE_PROJECT_DIR) ?? processCwd;
  const transcriptPath = firstString(payload.transcript_path, payload.transcriptPath);
  const source = firstString(payload.source);
  const prompt = firstString(payload.prompt);
  const toolUseId = firstString(payload.tool_use_id, payload.toolUseId);
  const toolName = firstString(payload.tool_name, payload.toolName);
  const toolInput = firstDefined(payload.tool_input, payload.toolInput);
  const toolResponse = firstDefined(payload.tool_response, payload.toolResponse);
  const durationMs = firstFiniteNumber(payload.duration_ms, payload.durationMs);
  const lastAssistantMessage = firstString(payload.last_assistant_message, payload.lastAssistantMessage);

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    projectDirectory,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(toolResponse !== undefined ? { toolResponse } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(lastAssistantMessage !== undefined ? { lastAssistantMessage } : {}),
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

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}
