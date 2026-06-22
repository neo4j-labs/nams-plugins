import { open } from "node:fs/promises";

export interface AntigravityUserTranscriptEntry {
  kind: "user";
  id?: string;
  content: string;
}

export interface AntigravityAssistantTranscriptEntry {
  kind: "assistant";
  id?: string;
  content: string;
}

export interface AntigravityToolTranscriptEntry {
  kind: "toolCall";
  id?: string;
  name: string;
  input: unknown;
  output?: string;
  status?: string;
  durationMs?: number;
  stepIdx?: number;
  timestamp?: string;
}

export type AntigravityTranscriptEntry =
  | AntigravityUserTranscriptEntry
  | AntigravityAssistantTranscriptEntry
  | AntigravityToolTranscriptEntry;

const transcriptTailByteLimit = 64 * 1024;
const transcriptTailLineLimit = 200;
const hiddenReasoningTokens = new Set([
  "reasoning",
  "thought",
  "thinking",
  "internal",
  "internaltrace",
  "trace",
  "summary",
  "conversationsummary",
  "compactedsummary",
]);

export async function readLatestAntigravityUserPrompt(transcriptPath: string): Promise<string | undefined> {
  let lines: string[];
  try {
    lines = await readBoundedTranscriptTailLines(transcriptPath);
  } catch {
    return undefined;
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.trim() === "") {
      continue;
    }

    const entry = toUserEntry(parseJsonLine(line));
    if (entry !== undefined) {
      return entry.content;
    }
  }
  return undefined;
}

export async function readAntigravityTranscript(transcriptPath: string): Promise<AntigravityTranscriptEntry[]> {
  const lines = await readBoundedTranscriptTailLines(transcriptPath);
  return lines.flatMap((line) => {
    if (line.trim() === "") {
      return [];
    }
    const entry = toTranscriptEntry(parseJsonLine(line));
    return entry === undefined ? [] : [entry];
  });
}

export async function readLatestAntigravityToolCall(
  transcriptPath: string,
  stepIdx?: number,
): Promise<AntigravityToolTranscriptEntry | undefined> {
  const lines = await readBoundedTranscriptTailLines(transcriptPath);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.trim() === "") {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseJsonLineStrict(line);
    } catch (error) {
      if (isToolMetadataLine(line)) {
        throw error;
      }
      continue;
    }

    const entry = toToolEntry(parsed);
    if (entry === undefined) {
      continue;
    }
    if (stepIdx !== undefined && entry.stepIdx !== stepIdx) {
      continue;
    }

    return entry;
  }
  return undefined;
}

async function readBoundedTranscriptTailLines(transcriptPath: string): Promise<string[]> {
  const file = await open(transcriptPath, "r");
  try {
    const stats = await file.stat();
    if (stats.size === 0) {
      return [];
    }

    const bytesToRead = Math.min(stats.size, transcriptTailByteLimit);
    const position = stats.size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
    let tailText = buffer.subarray(0, bytesRead).toString("utf8");
    if (position > 0) {
      const firstCompleteLineStart = tailText.indexOf("\n");
      tailText = firstCompleteLineStart === -1 ? "" : tailText.slice(firstCompleteLineStart + 1);
    }

    return tailText.split(/\r?\n/).slice(-transcriptTailLineLimit);
  } finally {
    await file.close();
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonLineStrict(line: string): unknown {
  return JSON.parse(line) as unknown;
}

function toTranscriptEntry(raw: unknown): AntigravityTranscriptEntry | undefined {
  return toUserEntry(raw) ?? toAssistantEntry(raw) ?? toToolEntry(raw);
}

function toUserEntry(raw: unknown): AntigravityUserTranscriptEntry | undefined {
  if (!isRecord(raw) || isHiddenReasoningLike(raw) || !isUserEntry(raw) || !isCompletedEntry(raw)) {
    return undefined;
  }

  const content = extractText(raw).trim();
  if (content === "") {
    return undefined;
  }

  return {
    kind: "user",
    ...(typeof raw.id === "string" && raw.id.trim() !== "" ? { id: raw.id } : {}),
    content,
  };
}

function toAssistantEntry(raw: unknown): AntigravityAssistantTranscriptEntry | undefined {
  if (!isRecord(raw) || isHiddenReasoningLike(raw) || !isAssistantEntry(raw) || !isCompletedEntry(raw)) {
    return undefined;
  }

  const content = extractText(raw).trim();
  if (content === "") {
    return undefined;
  }

  return {
    kind: "assistant",
    ...(typeof raw.id === "string" && raw.id.trim() !== "" ? { id: raw.id } : {}),
    content,
  };
}

function toToolEntry(raw: unknown): AntigravityToolTranscriptEntry | undefined {
  if (!isRecord(raw) || isHiddenReasoningLike(raw) || !isToolEntry(raw) || !isCompletedToolEntry(raw)) {
    return undefined;
  }

  const name = firstText(raw.name, raw.toolName, raw.tool_name, raw.tool);
  if (name === undefined) {
    return undefined;
  }

  const output = safeOutputText(raw.output) ?? safeOutputText(raw.result);
  const id = firstText(raw.id, raw.toolCallId, raw.tool_call_id, raw.callId, raw.call_id);
  const status = firstText(raw.status);
  const durationMs = numberValue(raw.durationMs, raw.duration_ms, raw.elapsedMs, raw.elapsed_ms);
  const stepIdx = numberValue(raw.stepIdx, raw.step_idx);
  const timestamp = firstText(raw.timestamp, raw.createdAt, raw.created_at);
  return {
    kind: "toolCall",
    ...(id !== undefined ? { id } : {}),
    name,
    input: sanitizeToolInput(firstDefined(raw.input, raw.args, raw.arguments, raw.toolInput, raw.tool_input)) ?? {},
    ...(output !== undefined ? { output } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(stepIdx !== undefined ? { stepIdx } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

function isUserEntry(raw: Record<string, unknown>): boolean {
  return raw.role === "user" || raw.type === "user";
}

function isAssistantEntry(raw: Record<string, unknown>): boolean {
  return raw.role === "assistant" || raw.type === "assistant";
}

function isToolEntry(raw: Record<string, unknown>): boolean {
  return (
    raw.kind === "toolCall" ||
    raw.kind === "tool_call" ||
    raw.kind === "tool" ||
    raw.type === "toolCall" ||
    raw.type === "tool_call" ||
    raw.type === "tool" ||
    raw.role === "tool"
  );
}

function isCompletedEntry(raw: Record<string, unknown>): boolean {
  return (
    raw.status === undefined ||
    raw.status === "completed" ||
    raw.status === "complete" ||
    raw.status === "finished"
  );
}

function isCompletedToolEntry(raw: Record<string, unknown>): boolean {
  return (
    raw.status === undefined ||
    raw.status === "completed" ||
    raw.status === "complete" ||
    raw.status === "finished" ||
    raw.status === "success" ||
    raw.status === "succeeded" ||
    raw.status === "failed" ||
    raw.status === "error"
  );
}

function extractText(raw: Record<string, unknown>): string {
  for (const fieldName of ["text", "content", "message"]) {
    const text = textFromValue(raw[fieldName]);
    if (text !== "") {
      return text;
    }
  }
  return "";
}

function textFromValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((part) => {
      if (!isRecord(part) || isHiddenReasoningLike(part)) {
        return "";
      }
      return typeof part.text === "string" ? part.text : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

function safeOutputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const text = textFromValue(value).trim();
  return text === "" ? undefined : text;
}

function sanitizeToolInput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeToolInput(entry))
      .filter((entry) => entry !== undefined);
  }

  if (!isRecord(value)) {
    return value;
  }

  if (isHiddenReasoningLike(value)) {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isHiddenReasoningValue(key)) {
      continue;
    }

    const sanitizedValue = sanitizeToolInput(nestedValue);
    if (sanitizedValue !== undefined) {
      sanitized[key] = sanitizedValue;
    }
  }
  return sanitized;
}

function isHiddenReasoningLike(raw: Record<string, unknown>): boolean {
  return (
    isHiddenReasoningValue(raw.type) ||
    isHiddenReasoningValue(raw.role) ||
    isHiddenReasoningValue(raw.kind)
  );
}

function isHiddenReasoningValue(value: unknown): boolean {
  return typeof value === "string" && hiddenReasoningTokens.has(normalizeHiddenReasoningToken(value));
}

function normalizeHiddenReasoningToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function isToolMetadataLine(line: string): boolean {
  return /"?(kind|type|role|name|toolName|tool_name|tool|input|args|arguments|toolInput|tool_input|stepIdx|step_idx)"?\s*:/.test(
    line,
  ) && /tool|toolCall|tool_call|toolName|tool_name|toolInput|tool_input|stepIdx|step_idx/.test(line);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
