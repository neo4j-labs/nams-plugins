import path from "node:path";
import { collectClaudeReplaySessions } from "./replay-collector.js";
import { createClaudeReplayOutbox, removeClaudeReplayOutbox, } from "./replay-outbox.js";
import { sendClaudeReplayOutbox } from "./replay-sender.js";
export async function runClaudeReplay(input) {
    const collection = await collectClaudeReplaySessions({
        importRoot: input.importRoot,
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.onProgress !== undefined
            ? {
                onFileProcessed: (event) => {
                    input.onProgress?.(`Claude replay file ${event.status}: ${event.path}`);
                },
            }
            : {}),
    });
    const outbox = await createClaudeReplayOutbox({
        sessions: collection.sessions,
        ...(input.temporaryRoot !== undefined
            ? { temporaryRoot: path.resolve(input.temporaryRoot) }
            : {}),
    });
    try {
        input.onProgress?.(`Claude replay outbox: ${outbox.path}`);
        const sent = collection.sessions.length === 0
            ? { conversations: 0, messages: 0, reasoningSteps: 0, toolCalls: 0 }
            : await sendClaudeReplayOutbox({
                outboxPath: outbox.path,
                importRoot: input.importRoot,
                ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
                ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
            });
        return {
            discoveredFiles: collection.discoveredFiles,
            matchedFiles: collection.matchedFiles,
            skippedFiles: collection.skippedFiles,
            sessions: collection.sessions.length,
            ...sent,
            malformedLines: collection.malformedLines,
            unsupportedRecords: collection.unsupportedRecords,
        };
    }
    finally {
        await removeClaudeReplayOutbox(outbox);
    }
}
export function formatClaudeReplaySummary(summary) {
    return [
        `Replay claude: discovered files ${summary.discoveredFiles}, matched files ${summary.matchedFiles}, skipped files ${summary.skippedFiles}, sessions ${summary.sessions};`,
        `conversations ${summary.conversations}, messages ${summary.messages}, steps ${summary.reasoningSteps}, tools ${summary.toolCalls}, malformed lines ${summary.malformedLines}, unsupported records ${summary.unsupportedRecords}.`,
    ].join(" ");
}
