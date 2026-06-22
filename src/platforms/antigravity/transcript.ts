import { readFile } from "node:fs/promises";

export interface AntigravityUserTranscriptEntry {
  kind: "user";
  id?: string;
  content: string;
}

export async function readLatestAntigravityUserPrompt(transcriptPath: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(transcriptPath, "utf8");
  } catch {
    return undefined;
  }

  let latestPrompt: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }

    const entry = toUserEntry(parseJsonLine(line));
    if (entry !== undefined) {
      latestPrompt = entry.content;
    }
  }
  return latestPrompt;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function toUserEntry(raw: unknown): AntigravityUserTranscriptEntry | undefined {
  if (!isRecord(raw) || !isUserEntry(raw) || !isCompletedEntry(raw)) {
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
      if (!isRecord(part)) {
        return "";
      }
      return typeof part.text === "string" ? part.text : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
