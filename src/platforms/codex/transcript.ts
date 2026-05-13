import { readFile } from "node:fs/promises";

export type CodexTranscriptEntry =
  | { kind: "user"; id?: string; content: string }
  | { kind: "assistant"; id?: string; content: string };

export async function readCodexTranscript(transcriptPath: string): Promise<CodexTranscriptEntry[]> {
  const content = await readFile(transcriptPath, "utf8");
  const entries: CodexTranscriptEntry[] = [];

  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }

    const raw = JSON.parse(line) as unknown;
    const entry = toEntry(raw);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }

  return entries;
}

function toEntry(raw: unknown): CodexTranscriptEntry | undefined {
  if (!isRecord(raw) || isCompactedSummary(raw)) {
    return undefined;
  }

  const message = responseItemMessage(raw);
  if (message === undefined) {
    return undefined;
  }

  const kind = message.role;
  if (kind !== "user" && kind !== "assistant") {
    return undefined;
  }

  const content = extractText(message.content).trim();
  if (content === "") {
    return undefined;
  }

  return {
    kind,
    ...id(message),
    content,
  };
}

function responseItemMessage(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (raw.type === "response_item" && isRecord(raw.item) && raw.item.type === "message") {
    return raw.item;
  }

  if (isRecord(raw.item) && raw.item.type === "response_item" && isRecord(raw.item.item) && raw.item.item.type === "message") {
    return raw.item.item;
  }

  return undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      return typeof part.text === "string" ? part.text : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

function id(raw: Record<string, unknown>): { id?: string } {
  return typeof raw.id === "string" && raw.id.trim() !== "" ? { id: raw.id } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCompactedSummary(raw: Record<string, unknown>): boolean {
  return (
    raw.type === "compact" ||
    raw.type === "compacted_summary" ||
    raw.type === "conversation_summary" ||
    typeof raw.summary === "string"
  );
}
