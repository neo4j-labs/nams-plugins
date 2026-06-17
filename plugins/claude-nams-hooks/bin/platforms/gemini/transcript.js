import { readFile } from "node:fs/promises";
export async function readGeminiTranscript(transcriptPath) {
    const content = await readFile(transcriptPath, "utf8");
    const entries = [];
    let rawEntryIndex = 0;
    for (const line of content.split(/\r?\n/)) {
        if (line.trim() === "") {
            continue;
        }
        const raw = JSON.parse(line);
        entries.push(...toEntries(raw, rawEntryIndex));
        rawEntryIndex += 1;
    }
    return entries;
}
function toEntries(raw, rawEntryIndex) {
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
        return [...assistantEntry(raw), ...thoughtEntries(raw, rawEntryIndex), ...toolCallEntries(raw, rawEntryIndex)];
    }
    return [];
}
function assistantEntry(raw) {
    if (typeof raw.content !== "string" || raw.content.trim() === "") {
        return [];
    }
    return [{ kind: "assistant", ...idAndTimestamp(raw), content: raw.content }];
}
function thoughtEntries(raw, rawEntryIndex) {
    if (!Array.isArray(raw.thoughts)) {
        return [];
    }
    return raw.thoughts.flatMap((thought, index) => {
        if (typeof thought !== "object" || thought === null) {
            return [];
        }
        const candidate = thought;
        if (typeof candidate.subject !== "string" || typeof candidate.description !== "string") {
            return [];
        }
        return [
            {
                kind: "thought",
                ...(typeof raw.id === "string" && raw.id.trim() !== "" ? { id: `${raw.id}:thought:${index}` } : {}),
                ...parentTranscriptEntry(raw, rawEntryIndex),
                subject: candidate.subject,
                description: candidate.description,
                ...(typeof candidate.timestamp === "string" ? { timestamp: candidate.timestamp } : {}),
            },
        ];
    });
}
function toolCallEntries(raw, rawEntryIndex) {
    if (!Array.isArray(raw.toolCalls)) {
        return [];
    }
    return raw.toolCalls.flatMap((toolCall) => {
        if (typeof toolCall !== "object" || toolCall === null) {
            return [];
        }
        const candidate = toolCall;
        if (typeof candidate.name !== "string") {
            return [];
        }
        return [
            {
                kind: "toolCall",
                ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
                ...parentTranscriptEntry(raw, rawEntryIndex),
                name: candidate.name,
                args: candidate.args,
                ...(typeof candidate.status === "string" ? { status: candidate.status } : {}),
                ...(typeof candidate.timestamp === "string" ? { timestamp: candidate.timestamp } : {}),
            },
        ];
    });
}
function extractUserText(content) {
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
        const candidate = part;
        return typeof candidate.text === "string" ? candidate.text : "";
    })
        .filter((text) => text !== "")
        .join("\n");
}
function idAndTimestamp(raw) {
    return {
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        ...(typeof raw.timestamp === "string" ? { timestamp: raw.timestamp } : {}),
    };
}
function parentTranscriptEntry(raw, rawEntryIndex) {
    return {
        ...(typeof raw.id === "string" && raw.id.trim() !== "" ? { parentTranscriptEntryId: raw.id } : {}),
        parentTranscriptEntryIndex: rawEntryIndex,
    };
}
