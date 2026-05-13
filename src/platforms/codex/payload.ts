export interface CodexPayloadInfo {
  sessionId?: string;
  turnId?: string;
  projectDirectory: string;
  transcriptPath?: string;
  hookEventName?: string;
  source?: string;
  model?: string;
  permissionMode?: string;
  prompt?: string;
  lastAssistantMessage?: string;
  stopHookActive?: boolean;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
}

export function parseCodexPayload(payload: Record<string, unknown>, processCwd: string): CodexPayloadInfo {
  const sessionId = firstString(payload.session_id, payload.sessionId);
  const turnId = firstString(payload.turn_id, payload.turnId);
  const projectDirectory = firstString(payload.cwd) ?? processCwd;
  const transcriptPath = firstString(payload.transcript_path, payload.transcriptPath);
  const hookEventName = firstString(payload.hook_event_name, payload.hookEventName);
  const source = firstString(payload.source);
  const model = firstString(payload.model);
  const permissionMode = firstString(payload.permission_mode, payload.permissionMode);
  const prompt = firstString(payload.prompt);
  const lastAssistantMessage = firstString(payload.last_assistant_message, payload.lastAssistantMessage);
  const stopHookActive = typeof payload.stop_hook_active === "boolean" ? payload.stop_hook_active : undefined;
  const toolName = firstString(payload.tool_name, payload.toolName);
  const toolUseId = firstString(payload.tool_use_id, payload.toolUseId);
  const toolInput = firstDefined(payload.tool_input, payload.toolInput);
  const toolResponse = firstDefined(payload.tool_response, payload.toolResponse);

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    projectDirectory,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(hookEventName !== undefined ? { hookEventName } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(lastAssistantMessage !== undefined ? { lastAssistantMessage } : {}),
    ...(stopHookActive !== undefined ? { stopHookActive } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(toolResponse !== undefined ? { toolResponse } : {}),
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
