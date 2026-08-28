import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CodexReplayCollection,
  CodexReplayMessage,
  CodexReplaySession,
  CodexReplayStatus,
  CodexReplayStep,
  CodexReplayToolCall,
  CollectCodexReplayInput,
} from "./replay-model.js";
import {
  discoverRegularJsonlFiles,
  isDirectoryWithinImportRoot,
  normalizeAbsolutePath,
} from "../../runtime/replay-files.js";
import { homeDirectory } from "../../runtime/paths.js";
import { firstString, isPlainObject } from "../../runtime/util.js";

interface ParsedRollout {
  records: Record<string, unknown>[];
  malformedLines: number;
  unsupportedRecords: number;
}

interface SessionMetadata {
  sourceSessionId: string;
  sourceThreadId?: string;
  sourceStartedAt?: string;
  projectDirectory: string;
  threadSource?: string;
}

interface SessionBuilder {
  sourceSessionId: string;
  projectDirectory: string;
  sourceStartedAt?: string;
  messages: CodexReplayMessage[];
  steps: CodexReplayStep[];
}

type StepBuilder = Omit<CodexReplayStep, "toolCalls"> & {
  toolCalls: CallBuilder[];
  commentary: string[];
};

interface CallBuilder extends CodexReplayToolCall {
  step: StepBuilder;
  outputParts: string[];
  callTimestampMs?: number;
  lastOutputTimestampMs?: number;
}

interface StreamResult {
  messages: CodexReplayMessage[];
  steps: CodexReplayStep[];
  unsupportedRecords: number;
}

export async function discoverCodexRolloutPaths(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const configured = firstString(env.CODEX_HOME);
  const home = homeDirectory(env);
  if (configured === undefined && home === undefined) return [];
  const codexRoot = path.resolve(configured ?? path.join(home as string, ".codex"));
  return discoverRegularJsonlFiles([
    path.join(codexRoot, "sessions"),
    path.join(codexRoot, "archived_sessions"),
  ]);
}

export async function collectCodexReplaySessions(
  input: CollectCodexReplayInput,
): Promise<CodexReplayCollection> {
  const importRoot = path.resolve(input.importRoot);
  let transcriptPaths: string[];
  try {
    transcriptPaths = [...(
      input.transcriptPaths ?? await discoverCodexRolloutPaths(input.env)
    )].map((transcriptPath) => path.resolve(transcriptPath)).sort();
  } catch {
    throw new Error("Unable to discover Codex rollouts");
  }
  const groups = new Map<string, SessionBuilder>();
  let matchedFiles = 0;
  let skippedFiles = 0;
  let malformedLines = 0;
  let unsupportedRecords = 0;

  for (const transcriptPath of transcriptPaths) {
    const parsed = await parseRollout(transcriptPath);
    malformedLines += parsed.malformedLines;
    unsupportedRecords += parsed.unsupportedRecords;
    const metadata = rolloutMetadata(parsed.records);
    if (
      metadata === undefined ||
      !isDirectoryWithinImportRoot(importRoot, metadata.projectDirectory)
    ) {
      skippedFiles += 1;
      input.onFileProcessed?.({ path: transcriptPath, status: "skipped" });
      continue;
    }

    matchedFiles += 1;
    let session = groups.get(metadata.sourceSessionId);
    if (session === undefined) {
      session = {
        sourceSessionId: metadata.sourceSessionId,
        projectDirectory: metadata.projectDirectory,
        ...(metadata.sourceStartedAt !== undefined
          ? { sourceStartedAt: metadata.sourceStartedAt }
          : {}),
        messages: [],
        steps: [],
      };
      groups.set(metadata.sourceSessionId, session);
    } else if (session.projectDirectory !== metadata.projectDirectory) {
      throw new Error(
        `Codex session ${metadata.sourceSessionId} has conflicting project directories`,
      );
    } else if (
      metadata.sourceStartedAt !== undefined &&
      (session.sourceStartedAt === undefined || metadata.sourceStartedAt < session.sourceStartedAt)
    ) {
      session.sourceStartedAt = metadata.sourceStartedAt;
    }

    const threadId = rolloutThreadId(parsed.records)
      ?? metadata.sourceThreadId
      ?? path.basename(transcriptPath, ".jsonl");
    const stream = collectRolloutStream(parsed.records, {
      sessionId: metadata.sourceSessionId,
      threadId,
      isRoot: metadata.threadSource === "user"
        || (metadata.threadSource === undefined && threadId === metadata.sourceSessionId),
    });
    session.messages.push(...stream.messages);
    session.steps.push(...stream.steps);
    unsupportedRecords += stream.unsupportedRecords;
    input.onFileProcessed?.({ path: transcriptPath, status: "imported" });
  }

  const sessions: CodexReplaySession[] = [...groups.values()]
    .map((session) => ({
      ...session,
      messages: session.messages.sort(compareTimelineEntry),
      steps: session.steps.sort(compareTimelineEntry),
    }))
    .sort((left, right) =>
      (left.sourceStartedAt ?? "").localeCompare(right.sourceStartedAt ?? "")
      || left.sourceSessionId.localeCompare(right.sourceSessionId)
    );

  return {
    sessions,
    discoveredFiles: transcriptPaths.length,
    matchedFiles,
    skippedFiles,
    malformedLines,
    unsupportedRecords,
  };
}

async function parseRollout(transcriptPath: string): Promise<ParsedRollout> {
  const records: Record<string, unknown>[] = [];
  let malformedLines = 0;
  let unsupportedRecords = 0;
  let contents: string;
  try {
    contents = await readFile(transcriptPath, "utf8");
  } catch {
    throw new Error("Unable to read Codex rollout");
  }
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isPlainObject(parsed)) records.push(parsed);
      else unsupportedRecords += 1;
    } catch {
      malformedLines += 1;
    }
  }
  return { records, malformedLines, unsupportedRecords };
}

function rolloutMetadata(records: Record<string, unknown>[]): SessionMetadata | undefined {
  let sourceSessionId: string | undefined;
  let fallbackSessionId: string | undefined;
  let sourceThreadId: string | undefined;
  let sourceStartedAt: string | undefined;
  let projectDirectory: string | undefined;
  let threadSource: string | undefined;
  for (const raw of records) {
    if (raw.type !== "session_meta" || !isPlainObject(raw.payload)) continue;
    projectDirectory ??= normalizeAbsolutePath(raw.payload.cwd);
    sourceSessionId ??= firstString(raw.payload.session_id);
    fallbackSessionId ??= firstString(raw.payload.id);
    sourceThreadId ??= firstString(raw.payload.id);
    sourceStartedAt ??= firstString(raw.payload.timestamp, raw.timestamp);
    threadSource ??= firstString(raw.payload.thread_source);
  }
  const resolvedSessionId = sourceSessionId ?? fallbackSessionId;
  if (resolvedSessionId === undefined || projectDirectory === undefined) return undefined;
  return {
    sourceSessionId: resolvedSessionId,
    projectDirectory,
    ...(sourceThreadId !== undefined ? { sourceThreadId } : {}),
    ...(sourceStartedAt !== undefined ? { sourceStartedAt } : {}),
    ...(threadSource !== undefined ? { threadSource } : {}),
  };
}

function rolloutThreadId(records: Record<string, unknown>[]): string | undefined {
  for (const raw of records) {
    if (raw.type !== "event_msg" || !isPlainObject(raw.payload)) continue;
    const threadId = firstString(raw.payload.thread_id);
    if (threadId !== undefined) return threadId;
  }
  return undefined;
}

function collectRolloutStream(
  records: Record<string, unknown>[],
  identity: { sessionId: string; threadId: string; isRoot: boolean },
): StreamResult {
  const activeSteps = new Map<string, StepBuilder>();
  const closedSteps: StepBuilder[] = [];
  const calls = new Map<string, CallBuilder>();
  const messages: CodexReplayMessage[] = [];
  let currentTurnId: string | undefined;
  let unsupportedRecords = 0;

  const closeTurn = (turnId: string): void => {
    const step = activeSteps.get(turnId);
    if (step === undefined) return;
    activeSteps.delete(turnId);
    closedSteps.push(step);
  };

  for (let lineIndex = 0; lineIndex < records.length; lineIndex += 1) {
    const raw = records[lineIndex];
    const timestamp = firstString(raw.timestamp) ?? "";
    const ordinal = finiteNumber(raw.ordinal) ?? lineIndex;
    if (raw.type === "session_meta") continue;

    if (raw.type === "event_msg" && isPlainObject(raw.payload)) {
      const eventType = firstString(raw.payload.type);
      const eventTurnId = firstString(raw.payload.turn_id);
      if (eventType === "task_started") {
        currentTurnId = eventTurnId;
        continue;
      }
      if (eventType === "task_complete") {
        const turnId = eventTurnId ?? currentTurnId;
        if (turnId !== undefined) closeTurn(turnId);
        if (turnId === currentTurnId) currentTurnId = undefined;
        continue;
      }
      if (eventType === "user_message" || eventType === "agent_message") {
        const message = legacyEventMessage(raw.payload, {
          isRoot: identity.isRoot,
          threadId: identity.threadId,
          timestamp,
          ordinal,
        });
        if (message !== undefined) messages.push(message);
        continue;
      }
      if (eventType === "item_completed") {
        const message = completedMessage(raw.payload, {
          isRoot: identity.isRoot,
          threadId: identity.threadId,
          timestamp,
          ordinal,
        });
        if (message !== undefined) messages.push(message);
        continue;
      }
      unsupportedRecords += 1;
      continue;
    }

    if (raw.type !== "response_item" || !isPlainObject(raw.payload)) {
      unsupportedRecords += 1;
      continue;
    }

    const item = raw.payload;
    const turnId = responseTurnId(item) ?? currentTurnId ?? `turn:${ordinal}`;
    if (item.type === "reasoning") {
      closeTurn(turnId);
      const reasoningId = firstString(item.id) ?? `reasoning:${ordinal}`;
      activeSteps.set(turnId, newStep({
        sessionId: identity.sessionId,
        threadId: identity.threadId,
        turnId,
        reasoningId,
        timestamp,
        ordinal,
      }));
      continue;
    }

    if (item.type === "message") {
      if (item.role === "assistant" && item.phase === "commentary") {
        const commentary = responseMessageText(item.content).trim();
        const step = activeSteps.get(turnId);
        if (step !== undefined && commentary !== "") step.commentary.push(commentary);
      }
      continue;
    }

    if (item.type === "custom_tool_call" || item.type === "function_call") {
      const sourceCallId = firstString(item.call_id, item.id);
      const toolName = firstString(item.name);
      if (sourceCallId === undefined || toolName === undefined) {
        unsupportedRecords += 1;
        continue;
      }
      let step = activeSteps.get(turnId);
      if (step === undefined) {
        step = newStep({
          sessionId: identity.sessionId,
          threadId: identity.threadId,
          turnId,
          reasoningId: "fallback",
          timestamp,
          ordinal,
        });
        activeSteps.set(turnId, step);
      }
      const decodedInput = item.type === "function_call"
        ? decodeJson(item.arguments) ?? {}
        : item.input ?? {};
      const namespace = item.type === "function_call" ? firstString(item.namespace) : undefined;
      const call: CallBuilder = {
        sourceCallId,
        toolName,
        input: namespace === undefined
          ? decodedInput
          : { namespace, input: decodedInput },
        timestamp,
        ordinal,
        ...(finiteNumber(item.duration_ms, item.durationMs) !== undefined
          ? { durationMs: finiteNumber(item.duration_ms, item.durationMs) }
          : {}),
        step,
        outputParts: [],
        callTimestampMs: timestampMilliseconds(timestamp),
      };
      step.toolCalls.push(call);
      calls.set(callKey(identity.sessionId, identity.threadId, turnId, sourceCallId), call);
      continue;
    }

    if (item.type === "custom_tool_call_output" || item.type === "function_call_output") {
      const sourceCallId = firstString(item.call_id);
      const call = sourceCallId === undefined
        ? undefined
        : calls.get(callKey(identity.sessionId, identity.threadId, turnId, sourceCallId));
      if (call === undefined) {
        unsupportedRecords += 1;
        continue;
      }
      const parts = item.type === "custom_tool_call_output"
        ? customOutputParts(item.output)
        : [serializedOutput(item.output)];
      call.outputParts.push(...parts);
      call.durationMs ??= finiteNumber(item.duration_ms, item.durationMs);
      call.lastOutputTimestampMs = timestampMilliseconds(timestamp)
        ?? call.lastOutputTimestampMs;
      continue;
    }

    unsupportedRecords += 1;
  }

  for (const turnId of [...activeSteps.keys()]) closeTurn(turnId);
  for (const call of calls.values()) {
    if (call.outputParts.length > 0) call.output = call.outputParts.join("");
    call.status = normalizeStatus(call.toolName, call.output);
    call.durationMs ??= elapsedMilliseconds(
      call.callTimestampMs,
      call.lastOutputTimestampMs,
    );
  }

  const steps = closedSteps
    .filter((step) => step.toolCalls.length > 0)
    .map((step): CodexReplayStep => {
      step.toolCalls.sort(compareTimelineEntry);
      step.reasoning = step.commentary.join("\n").trim()
        || "Codex exposed a tool-use step in the persisted rollout.";
      step.actionTaken = `Ran ${step.toolCalls.length} tool ${
        step.toolCalls.length === 1 ? "call" : "calls"
      }: ${step.toolCalls.map((call) => call.toolName).join(", ")}`;
      const hasStatus = step.toolCalls.some((call) => call.status !== undefined);
      return {
        localStepId: step.localStepId,
        sourceReasoningId: step.sourceReasoningId,
        threadId: step.threadId,
        turnId: step.turnId,
        timestamp: step.timestamp,
        ordinal: step.ordinal,
        reasoning: step.reasoning,
        actionTaken: step.actionTaken,
        ...(hasStatus
          ? { result: `Tool statuses: ${step.toolCalls.map((call) => call.status ?? "unknown").join(", ")}` }
          : {}),
        toolCalls: step.toolCalls.map(({ step: _step, outputParts: _parts, callTimestampMs: _start, lastOutputTimestampMs: _end, ...call }) => call),
      };
    });

  return { messages, steps, unsupportedRecords };
}

function newStep(input: {
  sessionId: string;
  threadId: string;
  turnId: string;
  reasoningId: string;
  timestamp: string;
  ordinal: number;
}): StepBuilder {
  return {
    localStepId: `${input.sessionId}:${input.threadId}:${input.turnId}:${input.reasoningId}`,
    sourceReasoningId: input.reasoningId,
    threadId: input.threadId,
    turnId: input.turnId,
    timestamp: input.timestamp,
    ordinal: input.ordinal,
    reasoning: "",
    actionTaken: "",
    toolCalls: [],
    commentary: [],
  };
}

function legacyEventMessage(
  payload: Record<string, unknown>,
  stream: { isRoot: boolean; threadId: string; timestamp: string; ordinal: number },
): CodexReplayMessage | undefined {
  if (!stream.isRoot) return undefined;
  const role = payload.type === "user_message"
    ? "user"
    : payload.type === "agent_message"
      ? "assistant"
      : undefined;
  const content = firstString(payload.message);
  if (role === undefined || content === undefined) return undefined;
  return {
    role,
    content,
    timestamp: stream.timestamp,
    ordinal: stream.ordinal,
    threadId: stream.threadId,
  };
}

function completedMessage(
  payload: Record<string, unknown>,
  stream: { isRoot: boolean; threadId: string; timestamp: string; ordinal: number },
): CodexReplayMessage | undefined {
  if (!stream.isRoot || !isPlainObject(payload.item)) return undefined;
  const role = payload.item.type === "UserMessage"
    ? "user"
    : payload.item.type === "AgentMessage"
      ? "assistant"
      : undefined;
  if (role === undefined) return undefined;
  const content = completedItemText(payload.item.content).trim();
  if (content === "") return undefined;
  return {
    role,
    content,
    timestamp: stream.timestamp,
    ordinal: stream.ordinal,
    threadId: stream.threadId,
  };
}

function completedItemText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(isPlainObject)
    .filter((part) => String(part.type).toLowerCase() === "text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter((text) => text !== "")
    .join("\n");
}

function responseMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(isPlainObject)
    .filter((part) => part.type === "output_text" || part.type === "text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter((text) => text !== "")
    .join("\n");
}

function customOutputParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainObject)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter((text) => text !== "");
}

function serializedOutput(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(sortJson(value));
  return serialized ?? String(value ?? "");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function responseTurnId(item: Record<string, unknown>): string | undefined {
  return isPlainObject(item.internal_chat_message_metadata_passthrough)
    ? firstString(item.internal_chat_message_metadata_passthrough.turn_id)
    : undefined;
}

function callKey(
  sessionId: string,
  threadId: string,
  turnId: string,
  sourceCallId: string,
): string {
  return `${sessionId}\n${threadId}\n${turnId}\n${sourceCallId}`;
}

function normalizeStatus(
  toolName: string,
  output: string | undefined,
): CodexReplayStatus | undefined {
  if (output === undefined) return undefined;
  if (toolName === "wait_agent") {
    const decoded = decodeJson(output);
    if (isPlainObject(decoded) && decoded.timed_out === true) return "timeout";
  }
  if (output.startsWith("Script completed\n")) return "success";
  if (output.startsWith("Script failed\n")) return "failure";
  return undefined;
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function elapsedMilliseconds(
  start: number | undefined,
  end: number | undefined,
): number | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

function timestampMilliseconds(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteNumber(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

function compareTimelineEntry(
  left: { timestamp: string; threadId?: string; ordinal: number },
  right: { timestamp: string; threadId?: string; ordinal: number },
): number {
  return left.timestamp.localeCompare(right.timestamp)
    || (left.threadId ?? "").localeCompare(right.threadId ?? "")
    || left.ordinal - right.ordinal;
}
