import { pickStringFields } from "../../runtime/payload.js";

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
  const strings = pickStringFields(payload, {
    sessionId: "session_id",
    turnId: "turn_id",
    transcriptPath: "transcript_path",
    hookEventName: "hook_event_name",
    source: "source",
    model: "model",
    permissionMode: "permission_mode",
    prompt: "prompt",
    lastAssistantMessage: "last_assistant_message",
    toolName: "tool_name",
    toolUseId: "tool_use_id",
  });

  const projectDirectory = pickStringFields(payload, { cwd: "cwd" }).cwd ?? processCwd;
  const stopHookActive = typeof payload.stop_hook_active === "boolean" ? payload.stop_hook_active : undefined;
  const toolInput = payload.tool_input;
  const toolResponse = payload.tool_response;

  return {
    ...strings,
    projectDirectory,
    ...(stopHookActive !== undefined ? { stopHookActive } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(toolResponse !== undefined ? { toolResponse } : {}),
  };
}
