export interface ClaudeFixtureRecord {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId: string;
  cwd: string;
  timestamp: string;
  isSidechain: boolean;
  agentId?: string;
  origin?: { kind: string };
  isMeta?: boolean;
  message?: Record<string, unknown>;
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: string;
}

export function claudeRecord(input: Omit<ClaudeFixtureRecord, "timestamp"> & {
  timestamp?: string;
}): ClaudeFixtureRecord {
  return {
    ...input,
    timestamp: input.timestamp ?? "2026-08-26T12:00:00.000Z",
  };
}

export function assistantBlock(input: {
  sessionId: string;
  cwd: string;
  uuid: string;
  parentUuid: string;
  messageId: string;
  block: Record<string, unknown>;
  isSidechain?: boolean;
  agentId?: string;
  timestamp?: string;
}): ClaudeFixtureRecord {
  return claudeRecord({
    type: "assistant",
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    isSidechain: input.isSidechain ?? false,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    message: {
      id: input.messageId,
      role: "assistant",
      content: [input.block],
    },
  });
}

export function humanMessage(input: {
  sessionId: string;
  cwd: string;
  uuid: string;
  parentUuid: string;
  content: string;
  timestamp?: string;
}): ClaudeFixtureRecord {
  return claudeRecord({
    type: "user",
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    isSidechain: false,
    origin: { kind: "human" },
    message: { role: "user", content: input.content },
  });
}

export function toolResult(input: {
  sessionId: string;
  cwd: string;
  uuid: string;
  parentUuid: string;
  toolUseId: string;
  content: unknown;
  isSidechain?: boolean;
  agentId?: string;
  isError?: boolean;
  toolUseResult?: unknown;
  timestamp?: string;
}): ClaudeFixtureRecord {
  return claudeRecord({
    type: "user",
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sourceToolAssistantUUID: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    isSidechain: input.isSidechain ?? false,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: input.toolUseId,
        content: input.content,
        ...(input.isError !== undefined ? { is_error: input.isError } : {}),
      }],
    },
    ...(input.toolUseResult !== undefined ? { toolUseResult: input.toolUseResult } : {}),
  });
}

export function taskNotification(input: {
  sessionId: string;
  cwd: string;
  uuid: string;
  parentUuid: string;
  toolUseId: string;
  status: string;
  result: string;
  timestamp?: string;
}): ClaudeFixtureRecord {
  return claudeRecord({
    type: "user",
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    isSidechain: false,
    origin: { kind: "task-notification" },
    message: {
      role: "user",
      content: [
        "<task-notification>",
        `<tool-use-id>${input.toolUseId}</tool-use-id>`,
        `<status>${input.status}</status>`,
        `<result>${input.result}</result>`,
        "</task-notification>",
      ].join("\n"),
    },
  });
}

export function jsonl(records: ClaudeFixtureRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
