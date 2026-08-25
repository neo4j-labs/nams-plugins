import path from "node:path";
import { NamsClient, NamsClientError, NamsWorkspaceClient, } from "../generated/nams-client.js";
import { loadNamsConnectionConfig, } from "./config.js";
import { serializeToolInput, serializeToolOutput, } from "./memory-service.js";
import { namsReplayProvenanceHeaders } from "./provenance.js";
import { isDirectoryWithinImportRoot } from "./replay-files.js";
import { validWorkspaces } from "./workspace-configuration.js";
const retryDelayMs = 500;
const maxReplayRetries = 2;
const namsCredentialFields = new Set([
    "authorization",
    "apikey",
    "xapikey",
    "token",
    "accesstoken",
    "refreshtoken",
    "secret",
    "password",
    "passphrase",
    "cookie",
    "setcookie",
]);
class ReplayWriteFailure extends Error {
    attempts;
    constructor(attempts) {
        super("NAMS write failed");
        this.attempts = attempts;
        this.name = "ReplayWriteFailure";
    }
}
export async function runReplay(input) {
    const sleep = input.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    const importRoot = path.resolve(input.importRoot);
    const platform = input.adapter.platform;
    const resolvedConfig = await resolveReplayConfig(importRoot, input.adapter, input.fetch, sleep);
    const config = resolvedConfig.config;
    input.onProgress?.(`Replay ${platform}: starting; ${JSON.stringify({ configSources: resolvedConfig.sources })}`);
    const httpAttempts = [];
    const client = new NamsClient({
        apiKey: config.apiKey,
        workspaceId: config.workspaceId,
        baseUrl: config.baseUrl,
        defaultHeaders: namsReplayProvenanceHeaders(platform),
        ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
        onRequest: (event) => {
            input.onProgress?.(`  - ${event.method} ${event.path}`);
            httpAttempts.push({
                operation: event.operation,
                method: event.method,
                path: event.path,
                ok: event.ok,
                ...(event.status !== undefined ? { status: event.status } : {}),
                requestBodyPresent: event.request.body !== undefined,
                ...(event.request.body !== undefined ? { requestBody: event.request.body } : {}),
                responseReceived: event.response !== undefined,
                ...(event.response?.body !== undefined ? { responseBody: event.response.body } : {}),
            });
        },
    });
    let transcriptPaths;
    try {
        transcriptPaths = [...await input.adapter.discoverTranscripts()].sort();
    }
    catch {
        throw new Error(`Unable to discover ${platform} replay transcripts`);
    }
    const summary = emptySummary(transcriptPaths.length);
    for (let index = 0; index < transcriptPaths.length; index += 1) {
        const transcriptPath = transcriptPaths[index];
        let transcript;
        try {
            transcript = await input.adapter.readTranscript(transcriptPath);
        }
        catch {
            summary.failed += 1;
            input.onProgress?.(progressLine(index, transcriptPaths.length, platform, path.basename(transcriptPath, ".jsonl"), "failed", "unreadable transcript"));
            continue;
        }
        summary.malformedLines += transcript.malformedLineCount;
        summary.unsupportedRecords += transcript.unsupportedRecordCount;
        if (transcript.projectDirectory === undefined || !isDirectoryWithinImportRoot(importRoot, transcript.projectDirectory)) {
            summary.skipped += 1;
            input.onProgress?.(progressLine(index, transcriptPaths.length, platform, transcript.sourceSessionId, "skipped", "cwd outside import root or unusable"));
            continue;
        }
        summary.matched += 1;
        if (transcript.records.length === 0) {
            summary.skipped += 1;
            input.onProgress?.(progressLine(index, transcriptPaths.length, platform, transcript.sourceSessionId, "skipped", "zero eligible records"));
            continue;
        }
        input.onProgress?.(`[${index + 1}/${transcriptPaths.length}] ${platform} ${transcript.sourceSessionId}: processing...`);
        try {
            const conversationId = await withReplayWrite(async () => {
                const response = await client.createConversation({
                    metadata: {
                        harness: platform,
                        projectDirectory: transcript.projectDirectory,
                        sourceSessionId: transcript.sourceSessionId,
                        importSource: "nams-hooks-replay",
                        ...(transcript.sourceStartedAt !== undefined ? { sourceStartedAt: transcript.sourceStartedAt } : {}),
                    },
                });
                if (response.id === undefined || response.id.trim() === "") {
                    throw new Error("NAMS conversation response did not include id");
                }
                return response.id;
            }, sleep, httpAttempts);
            const counts = await importTimeline(client, conversationId, transcript.records, sleep, summary, httpAttempts);
            summary.imported += 1;
            input.onProgress?.(progressLine(index, transcriptPaths.length, platform, transcript.sourceSessionId, "imported", `${counts.messages} messages, ${counts.toolCalls} tools`));
        }
        catch (error) {
            summary.failed += 1;
            input.onProgress?.(progressLine(index, transcriptPaths.length, platform, transcript.sourceSessionId, "failed", formatReplayWriteFailure(error, config.apiKey)));
        }
    }
    return summary;
}
async function importTimeline(client, conversationId, records, sleep, summary, httpAttempts) {
    let messages = 0;
    let toolCalls = 0;
    let pending = [];
    const flush = async () => {
        if (pending.length === 0)
            return;
        const batch = pending;
        pending = [];
        await withReplayWrite(() => client.addMessagesBulk(conversationId, { messages: batch }), sleep, httpAttempts);
        messages += batch.length;
        summary.messages += batch.length;
    };
    for (const record of records) {
        if (record.kind !== "message")
            continue;
        pending.push({ role: record.role, content: record.content });
        if (pending.length === 100)
            await flush();
    }
    await flush();
    for (const record of records) {
        if (record.kind === "message")
            continue;
        const stepId = await withReplayWrite(async () => {
            const response = await client.recordReasoningStep({ conversationId, ...record.reasoningStep });
            if (response.id === undefined || response.id.trim() === "") {
                throw new Error("NAMS reasoning response did not include id");
            }
            return response.id;
        }, sleep, httpAttempts);
        const toolRequest = {
            stepId,
            toolName: record.toolName,
            input: serializeToolInput(record.input),
            ...(record.output !== undefined ? { output: serializeToolOutput(record.output) } : {}),
            ...(record.status !== undefined ? { status: record.status } : {}),
            ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
        };
        await withReplayWrite(() => client.recordToolCall(toolRequest), sleep, httpAttempts);
        toolCalls += 1;
        summary.toolCalls += 1;
    }
    return { messages, toolCalls };
}
async function withReplayWrite(operation, sleep, httpAttempts) {
    const firstAttempt = httpAttempts.length;
    try {
        const result = await withReplayRetry(operation, sleep);
        httpAttempts.splice(firstAttempt);
        return result;
    }
    catch {
        throw new ReplayWriteFailure(httpAttempts.splice(firstAttempt));
    }
}
async function withReplayRetry(operation, sleep) {
    let retries = 0;
    while (true) {
        try {
            return await operation();
        }
        catch (error) {
            if (!isRecoverableReplayError(error) || retries === maxReplayRetries)
                throw error;
            retries += 1;
            await sleep(retryDelayMs);
        }
    }
}
function formatReplayWriteFailure(error, apiKey) {
    const detail = "NAMS write failed";
    if (!(error instanceof ReplayWriteFailure) || error.attempts.length === 0)
        return detail;
    const request = error.attempts.at(-1);
    const responses = error.attempts.map((attempt) => attempt.status === undefined ? "no HTTP response" : `HTTP ${attempt.status}`);
    const responseLabel = responses.length === 1 ? "NAMS response" : "NAMS responses";
    const parts = [
        detail,
        `HTTP request ${request.operation} ${request.method} ${request.path}`,
    ];
    if (request.requestBodyPresent) {
        parts.push(`request body ${formatNamsBody(request.requestBody, apiKey)}`);
    }
    parts.push(`attempts ${error.attempts.length}`, `${responseLabel} ${responses.join(", ")}`);
    if (request.responseReceived) {
        parts.push(`NAMS response body ${formatNamsBody(request.responseBody, apiKey)}`);
    }
    if (request.ok)
        parts.push("response validation failed");
    return parts.join("; ");
}
function formatNamsBody(body, apiKey) {
    if (body === undefined)
        return "<empty>";
    try {
        return JSON.stringify(redactNamsCredentials(body, apiKey, new WeakSet())) ?? "<empty>";
    }
    catch {
        return JSON.stringify(redactCredentialText(String(body), apiKey));
    }
}
function redactNamsCredentials(value, apiKey, seen) {
    if (typeof value === "string")
        return redactCredentialText(value, apiKey);
    if (value === null || typeof value !== "object")
        return value;
    if (seen.has(value))
        return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map((entry) => redactNamsCredentials(entry, apiKey, seen));
    }
    const result = Object.create(null);
    for (const [key, nestedValue] of Object.entries(value)) {
        result[key] = isCredentialField(key)
            ? "[REDACTED]"
            : redactNamsCredentials(nestedValue, apiKey, seen);
    }
    return result;
}
function redactCredentialText(value, apiKey) {
    const withoutConfiguredKey = apiKey === "" ? value : value.split(apiKey).join("[REDACTED]");
    return withoutConfiguredKey.replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]");
}
function isCredentialField(key) {
    return namsCredentialFields.has(key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase());
}
function isRecoverableReplayError(error) {
    if (error instanceof NamsClientError) {
        return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599);
    }
    if (error instanceof TypeError)
        return true;
    if (!(error instanceof Error) || !("code" in error))
        return false;
    return new Set(["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN"]).has(String(error.code));
}
async function resolveReplayConfig(importRoot, adapter, fetchImpl, sleep) {
    const connection = await loadNamsConnectionConfig(importRoot, adapter.discoverConfig);
    if (!connection.ok) {
        throw new Error(`NAMS replay configuration unavailable: ${connection.reason}`);
    }
    if (connection.config.workspaceId !== undefined) {
        return {
            config: {
                apiKey: connection.config.apiKey,
                workspaceId: connection.config.workspaceId,
                baseUrl: connection.config.baseUrl,
            },
            sources: connection.sources,
        };
    }
    const client = new NamsWorkspaceClient({
        apiKey: connection.config.apiKey,
        baseUrl: connection.config.baseUrl,
        defaultHeaders: namsReplayProvenanceHeaders(adapter.platform),
        ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
    });
    let response;
    try {
        response = await withReplayRetry(() => client.listMyWorkspaces(), sleep);
    }
    catch {
        throw new Error("NAMS workspace resolution failed for replay");
    }
    const workspaces = validWorkspaces(response.workspaces);
    if (workspaces.length === 0) {
        throw new Error("No NAMS workspace is available for replay");
    }
    if (workspaces.length !== 1) {
        throw new Error("NAMS workspace selection is required before replay");
    }
    return {
        config: {
            apiKey: connection.config.apiKey,
            workspaceId: workspaces[0].id,
            baseUrl: connection.config.baseUrl,
        },
        sources: {
            ...connection.sources,
            workspaceId: "nams:auto-selected-workspace",
        },
    };
}
function emptySummary(discovered) {
    return {
        discovered,
        matched: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
        messages: 0,
        toolCalls: 0,
        malformedLines: 0,
        unsupportedRecords: 0,
    };
}
function progressLine(index, total, platform, sourceSessionId, status, detail) {
    return `[${index + 1}/${total}] ${platform} ${sourceSessionId}: ${status} ${detail}`;
}
export function formatReplaySummary(platform, summary) {
    return [
        `Replay ${platform}: discovered ${summary.discovered}, matched ${summary.matched}, imported ${summary.imported}, skipped ${summary.skipped}, failed ${summary.failed};`,
        `messages ${summary.messages}, tools ${summary.toolCalls}, malformed lines ${summary.malformedLines}, unsupported records ${summary.unsupportedRecords}.`,
    ].join(" ");
}
