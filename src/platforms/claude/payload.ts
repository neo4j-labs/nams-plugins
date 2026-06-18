import { pickStringFields } from "../../runtime/payload.js";

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
  const strings = pickStringFields(payload, {
    sessionId: "session_id",
    transcriptPath: "transcript_path",
    source: "source",
    prompt: "prompt",
    toolUseId: "tool_use_id",
    toolName: "tool_name",
    lastAssistantMessage: "last_assistant_message",
  });

  const projectDirectory = pickStringFields(payload, { cwd: "cwd" }).cwd ?? processCwd;
  const toolInput = payload.tool_input;
  const toolResponse = payload.tool_response;
  const durationMs = toNumber(payload.duration_ms);

  return {
    ...strings,
    projectDirectory,
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(toolResponse !== undefined ? { toolResponse } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
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
