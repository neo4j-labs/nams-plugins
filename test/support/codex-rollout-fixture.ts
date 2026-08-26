export interface RolloutRecord {
  timestamp: string;
  ordinal: number;
  type: string;
  payload: Record<string, unknown>;
}

export function sessionMeta(input: {
  sessionId: string;
  threadId?: string;
  cwd: string;
  threadSource: "user" | "subagent";
  timestamp?: string;
}): RolloutRecord {
  const timestamp = input.timestamp ?? "2026-08-26T12:00:00.000Z";
  return {
    timestamp,
    ordinal: 0,
    type: "session_meta",
    payload: {
      session_id: input.sessionId,
      id: input.threadId ?? input.sessionId,
      timestamp,
      cwd: input.cwd,
      thread_source: input.threadSource,
    },
  };
}

export function responseItem(
  ordinal: number,
  turnId: string,
  payload: Record<string, unknown>,
  timestamp = `2026-08-26T12:00:${String(ordinal).padStart(2, "0")}.000Z`,
): RolloutRecord {
  return {
    timestamp,
    ordinal,
    type: "response_item",
    payload: {
      ...payload,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  };
}

export function completedItem(
  ordinal: number,
  threadId: string,
  turnId: string,
  item: Record<string, unknown>,
  timestamp = `2026-08-26T12:00:${String(ordinal).padStart(2, "0")}.000Z`,
): RolloutRecord {
  return {
    timestamp,
    ordinal,
    type: "event_msg",
    payload: { type: "item_completed", thread_id: threadId, turn_id: turnId, item },
  };
}

export function taskComplete(ordinal: number, threadId: string, turnId: string): RolloutRecord {
  return {
    timestamp: `2026-08-26T12:00:${String(ordinal).padStart(2, "0")}.000Z`,
    ordinal,
    type: "event_msg",
    payload: { type: "task_complete", thread_id: threadId, turn_id: turnId },
  };
}

export function jsonl(records: RolloutRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
