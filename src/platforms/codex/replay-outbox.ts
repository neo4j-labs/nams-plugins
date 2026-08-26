import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CodexReplayOutbox,
  type CodexReplayOutboxRecord,
  type CodexReplaySession,
  type CodexReplayStatus,
  type CreateCodexReplayOutboxInput,
} from "./replay-model.js";
import {
  ensurePrivateDirectory,
  writePrivateFile,
} from "../../runtime/permissions.js";

export function codexReplayOutboxRecords(
  sessions: CodexReplaySession[],
): CodexReplayOutboxRecord[] {
  const records: CodexReplayOutboxRecord[] = [];
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
      ...session.messages.map((message) => ({ kind: "message" as const, value: message })),
      ...session.steps.map((step) => ({ kind: "step" as const, value: step })),
    ].sort((left, right) =>
      left.value.timestamp.localeCompare(right.value.timestamp)
      || left.value.threadId.localeCompare(right.value.threadId)
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

export async function createCodexReplayOutbox(
  input: CreateCodexReplayOutboxInput,
): Promise<CodexReplayOutbox> {
  const records = codexReplayOutboxRecords(input.sessions);
  const contents = records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(
      input.temporaryRoot ?? tmpdir(),
      "nams-hooks-codex-replay-",
    ));
    await ensurePrivateDirectory(directory);
    const outboxPath = path.join(directory, "outbox.jsonl");
    await writePrivateFile(outboxPath, contents);
    return { directory, path: outboxPath, recordCount: records.length };
  } catch {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new Error("Unable to create Codex replay outbox");
  }
}

export async function readCodexReplayOutbox(
  outboxPath: string,
): Promise<CodexReplayOutboxRecord[]> {
  let contents: string;
  try {
    contents = await readFile(outboxPath, "utf8");
  } catch {
    throw new Error("Unable to read Codex replay outbox");
  }
  const records: CodexReplayOutboxRecord[] = [];
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(lines[index]);
      if (!isCodexReplayOutboxRecord(parsed)) throw new Error("invalid");
      records.push(parsed);
    } catch {
      throw new Error(`Invalid Codex replay outbox record at line ${index + 1}`);
    }
  }
  return records;
}

export async function removeCodexReplayOutbox(
  outbox: CodexReplayOutbox,
): Promise<void> {
  if (
    path.dirname(outbox.path) !== outbox.directory
    || path.basename(outbox.path) !== "outbox.jsonl"
    || !path.basename(outbox.directory).startsWith("nams-hooks-codex-replay-")
  ) {
    throw new Error("Invalid Codex replay outbox cleanup handle");
  }
  try {
    await rm(outbox.directory, { recursive: true, force: true });
  } catch {
    throw new Error("Unable to remove Codex replay outbox");
  }
}

const statuses = new Set<CodexReplayStatus>([
  "pending",
  "success",
  "failure",
  "error",
  "timeout",
  "cancelled",
]);

function isCodexReplayOutboxRecord(value: unknown): value is CodexReplayOutboxRecord {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "conversation.create") {
    return hasStrings(value, [
      "localConversationId",
      "sourceSessionId",
      "projectDirectory",
    ]) && optionalString(value.sourceStartedAt);
  }
  if (value.kind === "message.add") {
    return hasStrings(value, ["localConversationId", "content"])
      && (value.role === "user" || value.role === "assistant");
  }
  if (value.kind === "reasoningStep.create") {
    return hasStrings(value, [
      "localConversationId",
      "localStepId",
      "reasoning",
      "actionTaken",
    ]) && optionalString(value.result);
  }
  if (value.kind === "toolCall.create") {
    return hasStrings(value, ["localStepId", "toolName"])
      && Object.hasOwn(value, "input")
      && optionalString(value.output)
      && (value.status === undefined
        || (typeof value.status === "string" && statuses.has(value.status as CodexReplayStatus)))
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
