import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import type { HookEvent, Platform } from "../interfaces.js";
import { sha256 } from "./hashing.js";

export interface PlatformLogEntry {
  platform: Platform;
  event: HookEvent;
  payload: Record<string, unknown>;
  projectDirectory: string;
  sessionCreatedAt?: string;
  sessionKey?: string;
}

export async function appendPlatformLog(entry: PlatformLogEntry): Promise<void> {
  const logDir = path.join(entry.projectDirectory, ".nams", "logs");
  const logPath = path.join(logDir, logFileName(entry));
  const logEntry = {
    timestamp: new Date().toISOString(),
    harness: entry.platform,
    event: entry.event,
    payload: entry.payload,
  };

  await mkdir(logDir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify(logEntry)}\n`, "utf8");
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
