import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import type { HookEvent, Platform } from "../interfaces.js";

export interface PlatformLogEntry {
  platform: Platform;
  event: HookEvent;
  payload: Record<string, unknown>;
  projectDirectory: string;
}

export async function appendPlatformLog(entry: PlatformLogEntry): Promise<void> {
  const logDir = path.join(entry.projectDirectory, ".nams", "logs");
  const logPath = path.join(logDir, `${entry.platform}-${toKebabCase(entry.event)}.jsonl`);
  const logEntry = {
    timestamp: new Date().toISOString(),
    harness: entry.platform,
    event: entry.event,
    payload: entry.payload,
  };

  await mkdir(logDir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify(logEntry)}\n`, "utf8");
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
