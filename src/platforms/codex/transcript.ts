import { readFile } from "node:fs/promises";

export type CodexTranscriptEntry =
  | { kind: "user"; id?: string; content: string }
  | { kind: "assistant"; id?: string; content: string }
  | {
      kind: "toolCall";
      id?: string;
      transcriptEntryIndex: number;
      name: string;
      args: unknown;
      status?: string;
    };

export async function readCodexTranscript(transcriptPath: string): Promise<CodexTranscriptEntry[]> {
  const content = await readFile(transcriptPath, "utf8");
  const entries: CodexTranscriptEntry[] = [];

  let rawEntryIndex = 0;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }

    const raw = JSON.parse(line) as unknown;
    entries.push(...toEntries(raw, rawEntryIndex));
    rawEntryIndex += 1;
  }

  return entries;
}

function toEntries(raw: unknown, rawEntryIndex: number): CodexTranscriptEntry[] {
  if (!isRecord(raw) || isCompactedSummary(raw)) {
    return [];
  }

  const item = responseItem(raw);
  if (item === undefined) {
    return [];
  }

  if (item.type === "web_search_call") {
    return webSearchToolCallEntry(item, rawEntryIndex);
  }

  if (item.type !== "message") {
    return [];
  }

  const kind = item.role;
  if (kind !== "user" && kind !== "assistant") {
    return [];
  }

  const content = extractText(item.content).trim();
  if (content === "") {
    return [];
  }

  return [
    {
      kind,
      ...id(item),
      content,
    },
  ];
}

function responseItem(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (raw.type === "response_item") {
    if (isRecord(raw.item)) {
      return raw.item;
    }
    if (isRecord(raw.payload)) {
      return raw.payload;
    }
  }

  if (isRecord(raw.item) && raw.item.type === "response_item") {
    if (isRecord(raw.item.item)) {
      return raw.item.item;
    }
    if (isRecord(raw.item.payload)) {
      return raw.item.payload;
    }
  }

  return undefined;
}

function webSearchToolCallEntry(
  item: Record<string, unknown>,
  rawEntryIndex: number,
): Array<Extract<CodexTranscriptEntry, { kind: "toolCall" }>> {
  if (!isRecord(item.action) || typeof item.action.type !== "string") {
    return [];
  }

  return [
    {
      kind: "toolCall",
      ...id(item),
      transcriptEntryIndex: rawEntryIndex,
      name: "web_search",
      args: item.action,
      ...(typeof item.status === "string" ? { status: item.status } : {}),
    },
  ];
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
