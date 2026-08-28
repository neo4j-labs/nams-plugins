import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePrivateDirectory, writePrivateFile, } from "../../runtime/permissions.js";
export function codexReplayOutboxRecords(sessions) {
    const records = [];
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
            ...session.messages.map((message) => ({ kind: "message", value: message })),
            ...session.steps.map((step) => ({ kind: "step", value: step })),
        ].sort((left, right) => left.value.timestamp.localeCompare(right.value.timestamp)
            || left.value.threadId.localeCompare(right.value.threadId)
            || left.value.ordinal - right.value.ordinal);
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
export async function createCodexReplayOutbox(input) {
    const records = codexReplayOutboxRecords(input.sessions);
    const contents = records.length === 0
        ? ""
        : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    let directory;
    try {
        directory = await mkdtemp(path.join(input.temporaryRoot ?? tmpdir(), "nams-hooks-codex-replay-"));
        await ensurePrivateDirectory(directory);
        const outboxPath = path.join(directory, "outbox.jsonl");
        await writePrivateFile(outboxPath, contents);
        return { directory, path: outboxPath, recordCount: records.length };
    }
    catch {
        if (directory !== undefined) {
            await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
        throw new Error("Unable to create Codex replay outbox");
    }
}
export async function readCodexReplayOutbox(outboxPath) {
    let contents;
    try {
        contents = await readFile(outboxPath, "utf8");
    }
    catch {
        throw new Error("Unable to read Codex replay outbox");
    }
    const records = [];
    const recordLines = [];
    const lines = contents.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].trim() === "")
            continue;
        try {
            const parsed = JSON.parse(lines[index]);
            if (!isCodexReplayOutboxRecord(parsed))
                throw new Error("invalid");
            records.push(parsed);
            recordLines.push(index + 1);
        }
        catch {
            throw new Error(`Invalid Codex replay outbox record at line ${index + 1}`);
        }
    }
    validateCodexReplayOutboxReferences(records, recordLines);
    return records;
}
function validateCodexReplayOutboxReferences(records, recordLines) {
    const conversationIds = new Set();
    const stepIds = new Set();
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        const line = recordLines[index];
        if (record.kind === "conversation.create") {
            if (conversationIds.has(record.localConversationId)) {
                throw new Error(`Invalid Codex replay outbox conversation definition at line ${line}`);
            }
            conversationIds.add(record.localConversationId);
            continue;
        }
        if (record.kind === "message.add") {
            if (!conversationIds.has(record.localConversationId)) {
                throw new Error(`Invalid Codex replay outbox conversation reference at line ${line}`);
            }
            continue;
        }
        if (record.kind === "reasoningStep.create") {
            if (!conversationIds.has(record.localConversationId)) {
                throw new Error(`Invalid Codex replay outbox conversation reference at line ${line}`);
            }
            if (stepIds.has(record.localStepId)) {
                throw new Error(`Invalid Codex replay outbox reasoning step definition at line ${line}`);
            }
            stepIds.add(record.localStepId);
            continue;
        }
        if (!stepIds.has(record.localStepId)) {
            throw new Error(`Invalid Codex replay outbox reasoning step reference at line ${line}`);
        }
    }
}
export async function removeCodexReplayOutbox(outbox) {
    if (path.dirname(outbox.path) !== outbox.directory
        || path.basename(outbox.path) !== "outbox.jsonl"
        || !path.basename(outbox.directory).startsWith("nams-hooks-codex-replay-")) {
        throw new Error("Invalid Codex replay outbox cleanup handle");
    }
    try {
        await rm(outbox.directory, { recursive: true, force: true });
    }
    catch {
        throw new Error("Unable to remove Codex replay outbox");
    }
}
const statuses = new Set([
    "pending",
    "success",
    "failure",
    "error",
    "timeout",
    "cancelled",
]);
function isCodexReplayOutboxRecord(value) {
    if (!isPlainObject(value) || typeof value.kind !== "string")
        return false;
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
                || (typeof value.status === "string" && statuses.has(value.status)))
            && (value.durationMs === undefined
                || (typeof value.durationMs === "number" && Number.isFinite(value.durationMs)));
    }
    return false;
}
function hasStrings(value, keys) {
    return keys.every((key) => typeof value[key] === "string" && value[key].trim() !== "");
}
function optionalString(value) {
    return value === undefined || typeof value === "string";
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
