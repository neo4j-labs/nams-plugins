import { open } from "node:fs/promises";

export interface AntigravityUserTranscriptEntry {
  kind: "user";
  id?: string;
  content: string;
}

const transcriptTailByteLimit = 64 * 1024;
const transcriptTailLineLimit = 200;

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

function isUserEntry(raw: Record<string, unknown>): boolean {
  return raw.role === "user" || raw.type === "user";
}

function isCompletedEntry(raw: Record<string, unknown>): boolean {
  return (
    raw.status === undefined ||
    raw.status === "completed" ||
    raw.status === "complete" ||
    raw.status === "finished"
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

function isHiddenReasoningLike(raw: Record<string, unknown>): boolean {
  return (
    isHiddenReasoningValue(raw.type) ||
    isHiddenReasoningValue(raw.role) ||
    isHiddenReasoningValue(raw.kind)
  );
}

function isHiddenReasoningValue(value: unknown): boolean {
  return (
    value === "reasoning" ||
    value === "thought" ||
    value === "thinking" ||
    value === "summary" ||
    value === "conversation_summary" ||
    value === "compacted_summary"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
