import path from "node:path";
import type { NamsRequestEvent } from "../generated/nams-client.js";
import type { HookEvent, HookInvocation, Platform } from "../interfaces.js";
import { configDiagnosticPayload, type NamsConfigLoadResult } from "./config.js";
import { sha256 } from "./hashing.js";
import { appendPrivateFile } from "./permissions.js";
import { RuntimeEnvironment } from "./paths.js";
import type { SessionState } from "./session-state.js";

export interface PlatformLogEntry {
  platform: Platform;
  event: HookEvent;
  kind?: string;
  payload: Record<string, unknown>;
  sessionCreatedAt?: string;
  sessionKey?: string;
}

export async function appendPlatformLog(entry: PlatformLogEntry): Promise<void> {
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

export async function appendNamsConfigDiagnostic(
  invocation: HookInvocation,
  state: SessionState,
  result: NamsConfigLoadResult,
): Promise<void> {
  await appendPlatformDiagnosticLog(invocation, state, configDiagnosticPayload(result));
}

export async function appendNamsFailureDiagnostic(
  invocation: HookInvocation,
  state: SessionState,
): Promise<void> {
  await appendPlatformDiagnosticLog(invocation, state, { message: "NAMS request failed" });
}

export async function appendNamsRequestLog(
  invocation: HookInvocation,
  state: SessionState,
  payload: NamsRequestEvent,
): Promise<void> {
  await appendPlatformLogBestEffort({
    platform: invocation.platform,
    event: invocation.event,
    kind: "nams.request",
    payload: { ...payload },
    sessionCreatedAt: state.createdAt,
    sessionKey: state.sessionKey,
  });
}

export const workspaceDiagnosticMessages = {
  loadedFromConfig: "NAMS workspace loaded from config",
  loadedFromSessionState: "NAMS workspace loaded from session state",
  autoSelected: "NAMS workspace auto-selected",
  selectionRequired: "NAMS workspace selection required",
  listEmpty: "NAMS workspace list empty",
  requestFailed: "NAMS workspace request failed",
} as const;

export async function appendWorkspaceDiagnostic(
  invocation: HookInvocation,
  state: SessionState,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendPlatformDiagnosticLog(invocation, state, payload);
}

export async function appendRawPlatformLog(
  invocation: HookInvocation,
  state?: SessionState,
): Promise<void> {
  await appendPlatformLogBestEffort({
    platform: invocation.platform,
    event: invocation.event,
    kind: "hook.event",
    payload: invocation.rawPayload,
    sessionCreatedAt: state?.createdAt,
    sessionKey: state?.sessionKey,
  });
}

export async function appendPlatformDiagnosticLog(
  invocation: HookInvocation,
  state: SessionState,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendPlatformLogBestEffort({
    platform: invocation.platform,
    event: invocation.event,
    kind: "diagnostic",
    payload,
    sessionCreatedAt: state.createdAt,
    sessionKey: state.sessionKey,
  });
}

async function appendPlatformLogBestEffort(entry: PlatformLogEntry): Promise<void> {
  try {
    await appendPlatformLog(entry);
  } catch {
    // Observability writes must never block hook responses.
  }
}

function logFileName(entry: PlatformLogEntry): string {
  if (entry.sessionCreatedAt !== undefined && entry.sessionKey !== undefined) {
    return `session-${formatSessionTimestamp(entry.sessionCreatedAt)}-${sessionKeyPart(entry.sessionKey)}.jsonl`;
  }
  return `${entry.platform}-${toKebabCase(entry.event)}.jsonl`;
}

function formatSessionTimestamp(value: string): string {
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(value);
  const timestamp = match?.[0] ?? new Date().toISOString().slice(0, 16);
  return timestamp.replace(":", "-");
}

function sessionKeyPart(sessionKey: string): string {
  const compact = sessionKey.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return /^[a-f0-9]{8,}/.test(compact) ? compact.slice(0, 8) : sha256(sessionKey).slice(0, 8);
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
