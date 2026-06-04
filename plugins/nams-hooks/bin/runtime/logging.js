import path from "node:path";
import { configDiagnosticPayload } from "./config.js";
import { sha256 } from "./hashing.js";
import { appendPrivateFile } from "./permissions.js";
import { RuntimeEnvironment } from "./paths.js";
export async function appendPlatformLog(entry) {
    const logDir = RuntimeEnvironment.fromProcess().platformLogDirectory(entry.platform);
    const logPath = path.join(logDir, logFileName(entry));
    const logEntry = {
        timestamp: new Date().toISOString(),
        harness: entry.platform,
        event: entry.event,
        kind: entry.kind ?? "hook.event",
        payload: entry.payload,
    };
    await appendPrivateFile(logPath, `${JSON.stringify(logEntry)}\n`);
}
export async function appendNamsConfigDiagnostic(invocation, state, result) {
    await appendPlatformDiagnosticLog(invocation, state, configDiagnosticPayload(result));
}
export async function appendNamsFailureDiagnostic(invocation, state) {
    await appendPlatformDiagnosticLog(invocation, state, { message: "NAMS request failed" });
}
export async function appendNamsRequestLog(invocation, state, payload) {
    await appendPlatformLogBestEffort({
        platform: invocation.platform,
        event: invocation.event,
        kind: "nams.request",
        payload: { ...payload },
        sessionCreatedAt: state.createdAt,
        sessionKey: state.sessionKey,
    });
}
export async function appendRawPlatformLog(invocation, state) {
    await appendPlatformLogBestEffort({
        platform: invocation.platform,
        event: invocation.event,
        kind: "hook.event",
        payload: invocation.rawPayload,
        sessionCreatedAt: state?.createdAt,
        sessionKey: state?.sessionKey,
    });
}
export async function appendPlatformDiagnosticLog(invocation, state, payload) {
    await appendPlatformLogBestEffort({
        platform: invocation.platform,
        event: invocation.event,
        kind: "diagnostic",
        payload,
        sessionCreatedAt: state.createdAt,
        sessionKey: state.sessionKey,
    });
}
async function appendPlatformLogBestEffort(entry) {
    try {
        await appendPlatformLog(entry);
    }
    catch {
        // Observability writes must never block hook responses.
    }
}
function logFileName(entry) {
    if (entry.sessionCreatedAt !== undefined && entry.sessionKey !== undefined) {
        return `session-${formatSessionTimestamp(entry.sessionCreatedAt)}-${sessionKeyPart(entry.sessionKey)}.jsonl`;
    }
    return `${entry.platform}-${toKebabCase(entry.event)}.jsonl`;
}
function formatSessionTimestamp(value) {
    const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(value);
    const timestamp = match?.[0] ?? new Date().toISOString().slice(0, 16);
    return timestamp.replace(":", "-");
}
function sessionKeyPart(sessionKey) {
    const compact = sessionKey.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    return /^[a-f0-9]{8,}/.test(compact) ? compact.slice(0, 8) : sha256(sessionKey).slice(0, 8);
}
function toKebabCase(value) {
    return value
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
}
