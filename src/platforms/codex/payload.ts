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
  const sessionId = payload.session_id as string | undefined;
  const turnId = payload.turn_id as string | undefined;
  const projectDirectory = payload.cwd as string | undefined;
  const transcriptPath = payload.transcript_path as string | undefined;
  const hookEventName = payload.hook_event_name as string | undefined;
  const source = payload.source as string | undefined;
  const model = payload.model as string | undefined;
  const permissionMode = payload.permission_mode as string | undefined;
  const prompt = payload.prompt as string | undefined;
  const lastAssistantMessage = payload.last_assistant_message as string | undefined;
  const stopHookActive = typeof payload.stop_hook_active === "boolean" ? payload.stop_hook_active : undefined;
  const toolName = payload.tool_name as string | undefined;
  const toolUseId = payload.tool_use_id as string | undefined;
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

function isBlankOrEmpty(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === "";
}
