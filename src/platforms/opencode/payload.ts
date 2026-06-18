import { firstRecord, firstString } from "../../runtime/util.js";

export interface OpenCodePayloadInfo {
  hookName?: string;
  eventType?: string;
  sessionId?: string;
  messageId?: string;
  partId?: string;
  projectDirectory: string;
  userPrompt?: string;
  assistantText?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: unknown;
  toolTitle?: string;
  toolOutput?: string;
  toolStatus?: string;
}

export function parseOpenCodePayload(payload: Record<string, unknown>, processCwd: string): OpenCodePayloadInfo {
  const input = firstRecord(payload.input);
  const event = firstRecord(payload.event);
  const eventProperties = firstRecord(event?.properties);
  const eventInfo = firstRecord(eventProperties?.info);
  const output = firstRecord(payload.output);
  const outputMessage = firstRecord(output?.message);
  const inputMessage = firstRecord(input?.message);
  const message = firstRecord(outputMessage, inputMessage, payload.message);

  const hookName = firstString(payload.hook, payload.hookName);
  const eventType = firstString(event?.type);
  const sessionId = firstString(
    input?.sessionID,
    input?.sessionId,
    message?.sessionID,
    eventProperties?.sessionID,
    eventInfo?.id,
  );
  const messageId = firstString(input?.messageID, input?.messageId, outputMessage?.id, inputMessage?.id, message?.id);
  const partId = firstString(input?.partID, input?.partId);
  const projectDirectory =
    firstString(payload.directory, payload.cwd, eventInfo?.directory, payload.worktree) ?? processCwd;
  const userPrompt = extractUserPrompt(output?.parts, message?.parts);
  const assistantText = firstString(output?.text);
  const toolName = firstString(input?.tool);

  return {
    ...(hookName !== undefined ? { hookName } : {}),
    ...(eventType !== undefined ? { eventType } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(partId !== undefined ? { partId } : {}),
    projectDirectory,
    ...(userPrompt !== undefined ? { userPrompt } : {}),
    ...(assistantText !== undefined ? { assistantText } : {}),
    ...(toolName !== undefined
      ? {
          toolName,
          ...extractToolFields(input, output),
        }
      : {}),
  };
}

function extractUserPrompt(...values: unknown[]): string | undefined {
  const parts = firstArray(...values);
  if (parts === undefined) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const partValue of parts) {
    const part = firstRecord(partValue);
    if (part?.type !== "text" || part.ignored === true) {
      continue;
    }

    const text = firstString(part.text);
    if (text !== undefined) {
      textParts.push(text);
    }
  }

  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function extractToolFields(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined) {
  const toolCallId = firstString(input?.callID, input?.callId);
  const toolTitle = firstString(output?.title);
  const toolOutput = firstString(output?.output);
  const toolStatus = firstString(output?.status) ?? "completed";

  return {
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(input?.args !== undefined ? { toolInput: input.args } : {}),
    ...(toolTitle !== undefined ? { toolTitle } : {}),
    ...(toolOutput !== undefined ? { toolOutput } : {}),
    toolStatus,
  };
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

