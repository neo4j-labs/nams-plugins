import { readFile } from "node:fs/promises";

export type GeminiTranscriptEntry =
  | { kind: "header"; sessionId?: string }
  | { kind: "user"; id?: string; content: string; timestamp?: string }
  | { kind: "assistant"; id?: string; content: string; timestamp?: string }
  | { kind: "thought"; id?: string; subject: string; description: string; timestamp?: string }
  | { kind: "toolCall"; id?: string; name: string; args: unknown; status?: string; timestamp?: string };

export async function readGeminiTranscript(transcriptPath: string): Promise<GeminiTranscriptEntry[]> {
  const content = await readFile(transcriptPath, "utf8");
  const entries: GeminiTranscriptEntry[] = [];

  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }

    const raw = JSON.parse(line) as Record<string, unknown>;
    entries.push(...toEntries(raw));
  }

  return entries;
}

function toEntries(raw: Record<string, unknown>): GeminiTranscriptEntry[] {
  if ("$set" in raw) {
    return [];
  }

  if (typeof raw.sessionId === "string" && raw.type === undefined) {
    return [{ kind: "header", sessionId: raw.sessionId }];
  }

  if (raw.type === "user") {
    const content = extractUserText(raw.content);
    if (content.trim() === "") {
      return [];
    }
    return [{ kind: "user", ...idAndTimestamp(raw), content }];
  }

  if (raw.type === "gemini") {
    return [...assistantEntry(raw), ...thoughtEntries(raw), ...toolCallEntries(raw)];
  }

  return [];
}

function assistantEntry(raw: Record<string, unknown>): GeminiTranscriptEntry[] {
  if (typeof raw.content !== "string" || raw.content.trim() === "") {
    return [];
  }
  return [{ kind: "assistant", ...idAndTimestamp(raw), content: raw.content }];
}

function thoughtEntries(raw: Record<string, unknown>): GeminiTranscriptEntry[] {
  if (!Array.isArray(raw.thoughts)) {
    return [];
  }

  return raw.thoughts.flatMap((thought, index) => {
    if (typeof thought !== "object" || thought === null) {
      return [];
    }

    const candidate = thought as Record<string, unknown>;
    if (typeof candidate.subject !== "string" || typeof candidate.description !== "string") {
      return [];
    }

    return [
      {
        kind: "thought" as const,
        ...(typeof raw.id === "string" && raw.id.trim() !== "" ? { id: `${raw.id}:thought:${index}` } : {}),
        subject: candidate.subject,
        description: candidate.description,
        ...(typeof candidate.timestamp === "string" ? { timestamp: candidate.timestamp } : {}),
      },
    ];
  });
}

function toolCallEntries(raw: Record<string, unknown>): GeminiTranscriptEntry[] {
  if (!Array.isArray(raw.toolCalls)) {
    return [];
  }

  return raw.toolCalls.flatMap((toolCall) => {
    if (typeof toolCall !== "object" || toolCall === null) {
      return [];
    }

    const candidate = toolCall as Record<string, unknown>;
    if (typeof candidate.name !== "string") {
      return [];
    }

    return [
      {
        kind: "toolCall" as const,
        ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
        name: candidate.name,
        args: candidate.args,
        ...(typeof candidate.status === "string" ? { status: candidate.status } : {}),
        ...(typeof candidate.timestamp === "string" ? { timestamp: candidate.timestamp } : {}),
      },
    ];
  });
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) {
        return "";
      }
      const candidate = part as Record<string, unknown>;
      return typeof candidate.text === "string" ? candidate.text : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

function idAndTimestamp(raw: Record<string, unknown>): { id?: string; timestamp?: string } {
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw.timestamp === "string" ? { timestamp: raw.timestamp } : {}),
  };
}
