import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensurePrivateDirectory,
  writePrivateFile,
} from "../../runtime/permissions.js";
import type {
  ClaudeReplayOutbox,
  ClaudeReplayOutboxRecord,
  ClaudeReplaySession,
  ClaudeReplayStatus,
  CreateClaudeReplayOutboxInput,
} from "./replay-model.js";

export function claudeReplayOutboxRecords(
  sessions: ClaudeReplaySession[],
): ClaudeReplayOutboxRecord[] {
  const records: ClaudeReplayOutboxRecord[] = [];
  for (const session of sessions) {
    const localConversationId = `conversation:${session.sourceSessionId}`;
    records.push({
      kind: "conversation.create",
      localConversationId,
      sourceSessionId: session.sourceSessionId,
      projectDirectory: session.projectDirectory,
      ...(session.sourceStartedAt !== undefined
        ? { sourceStartedAt: session.sourceStartedAt }
        : {}),
    });
    const timeline = [
      ...session.messages.map((value) => ({ kind: "message" as const, value })),
      ...session.steps.map((value) => ({ kind: "step" as const, value })),
    ].sort((left, right) =>
      left.value.timestamp.localeCompare(right.value.timestamp)
      || left.value.streamId.localeCompare(right.value.streamId)
      || left.value.ordinal - right.value.ordinal
    );
    for (const entry of timeline) {
      if (entry.kind === "message") {
        records.push({
          kind: "message.add",
          localConversationId,
          role: entry.value.role,
          content: entry.value.content,
        });
        continue;
      }
      records.push({
        kind: "reasoningStep.create",
        localConversationId,
        localStepId: entry.value.localStepId,
        reasoning: entry.value.reasoning,
        actionTaken: entry.value.actionTaken,
        ...(entry.value.result !== undefined ? { result: entry.value.result } : {}),
      });
      for (const call of entry.value.toolCalls) {
        records.push({
          kind: "toolCall.create",
          localStepId: entry.value.localStepId,
          toolName: call.toolName,
          input: call.input,
          ...(call.output !== undefined ? { output: call.output } : {}),
          ...(call.status !== undefined ? { status: call.status } : {}),
          ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
        });
      }
    }
  }
  return records;
}

export async function createClaudeReplayOutbox(
  input: CreateClaudeReplayOutboxInput,
): Promise<ClaudeReplayOutbox> {
  const records = claudeReplayOutboxRecords(input.sessions);
  const contents = records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(
      input.temporaryRoot ?? tmpdir(),
      "nams-hooks-claude-replay-",
    ));
    await ensurePrivateDirectory(directory);
    const outboxPath = path.join(directory, "outbox.jsonl");
    await writePrivateFile(outboxPath, contents);
    return { directory, path: outboxPath, recordCount: records.length };
  } catch {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new Error("Unable to create Claude replay outbox");
  }
}

export async function readClaudeReplayOutbox(
  outboxPath: string,
): Promise<ClaudeReplayOutboxRecord[]> {
  let contents: string;
  try {
    contents = await readFile(outboxPath, "utf8");
  } catch {
    throw new Error("Unable to read Claude replay outbox");
  }
  const records: ClaudeReplayOutboxRecord[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isClaudeReplayOutboxRecord(parsed)) throw new Error("invalid");
      records.push(parsed);
    } catch {
      throw new Error(`Invalid Claude replay outbox record at line ${index + 1}`);
    }
  }
  return records;
}

export function validateClaudeReplayOutboxReferences(
  records: ClaudeReplayOutboxRecord[],
): void {
  const conversations = new Set<string>();
  const steps = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (record.kind === "conversation.create") {
      conversations.add(record.localConversationId);
    } else if (record.kind === "message.add") {
      if (!conversations.has(record.localConversationId)) {
        throw new Error(`Invalid Claude replay outbox conversation reference at line ${index + 1}`);
      }
    } else if (record.kind === "reasoningStep.create") {
      if (!conversations.has(record.localConversationId)) {
        throw new Error(`Invalid Claude replay outbox conversation reference at line ${index + 1}`);
      }
      steps.add(record.localStepId);
    } else if (!steps.has(record.localStepId)) {
      throw new Error(`Invalid Claude replay outbox reasoning step reference at line ${index + 1}`);
    }
  }
}

export async function removeClaudeReplayOutbox(
  outbox: ClaudeReplayOutbox,
): Promise<void> {
  if (
    path.dirname(outbox.path) !== outbox.directory
    || path.basename(outbox.path) !== "outbox.jsonl"
    || !path.basename(outbox.directory).startsWith("nams-hooks-claude-replay-")
  ) {
    throw new Error("Invalid Claude replay outbox cleanup handle");
  }
  try {
    await rm(outbox.directory, { recursive: true, force: true });
  } catch {
    throw new Error("Unable to remove Claude replay outbox");
  }
}

const statuses = new Set<ClaudeReplayStatus>([
  "pending", "success", "failure", "error", "timeout", "cancelled",
]);

function isClaudeReplayOutboxRecord(value: unknown): value is ClaudeReplayOutboxRecord {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "conversation.create") {
    return hasStrings(value, ["localConversationId", "sourceSessionId", "projectDirectory"])
      && optionalString(value.sourceStartedAt);
  }
  if (value.kind === "message.add") {
    return hasStrings(value, ["localConversationId", "content"])
      && (value.role === "user" || value.role === "assistant");
  }
  if (value.kind === "reasoningStep.create") {
    return hasStrings(value, ["localConversationId", "localStepId", "reasoning", "actionTaken"])
      && optionalString(value.result);
  }
  if (value.kind === "toolCall.create") {
    return hasStrings(value, ["localStepId", "toolName"])
      && Object.hasOwn(value, "input")
      && optionalString(value.output)
      && (value.status === undefined
        || (typeof value.status === "string" && statuses.has(value.status as ClaudeReplayStatus)))
      && (value.durationMs === undefined
        || (typeof value.durationMs === "number" && Number.isFinite(value.durationMs)));
  }
  return false;
}

function hasStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === "string" && value[key].trim() !== "");
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
