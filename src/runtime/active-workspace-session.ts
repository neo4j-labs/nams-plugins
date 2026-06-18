import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../interfaces.js";
import { sessionStateDirectory } from "./paths.js";
import { ensurePrivateDirectory, writePrivateFile } from "./permissions.js";

export const ACTIVE_WORKSPACE_SESSION_TTL_MS = 60_000;
export const ACTIVE_WORKSPACE_SESSION_WINNER_GAP_MS = 15_000;

const ACTIVE_WORKSPACE_SESSION_LOCK_RETRY_DELAY_MS = 10;
const ACTIVE_WORKSPACE_SESSION_LOCK_MAX_WAIT_MS = 5_000;

export interface ActiveWorkspaceSessionRecord {
  sessionId: string;
  sessionKey: string;
  projectDirectory: string;
  statePath?: string;
  touchedAt: string;
}

export interface RecordActiveWorkspaceSessionInput {
  platform: Platform;
  sessionId?: string;
  sessionKey: string;
  projectDirectory: string;
  statePath?: string;
  touchedAt?: Date;
  environment?: NodeJS.ProcessEnv;
}

export interface ResolveActiveWorkspaceSessionInput {
  platform: Platform;
  projectDirectory: string;
  now?: Date;
  ttlMs?: number;
  winnerGapMs?: number;
  environment?: NodeJS.ProcessEnv;
}

export type ActiveWorkspaceSessionResolution =
  | { status: "resolved"; sessionId: string; sessionKey: string; projectDirectory: string; statePath?: string }
  | { status: "missing" }
  | { status: "ambiguous"; candidates: ActiveWorkspaceSessionRecord[] };

interface ActiveWorkspaceSessionMarker {
  sessions: ActiveWorkspaceSessionRecord[];
}

export function activeWorkspaceSessionsPath(
  platform: Platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(sessionStateDirectory(platform, environment), "active-workspace-sessions.json");
}

export async function recordActiveWorkspaceSession(input: RecordActiveWorkspaceSessionInput): Promise<void> {
  const sessionId = input.sessionId?.trim() ?? "";
  const sessionKey = input.sessionKey.trim();
  if (sessionId === "" || sessionKey === "") {
    return;
  }

  const now = input.touchedAt ?? new Date();
  const markerPath = activeWorkspaceSessionsPath(input.platform, input.environment);
  await withMarkerLock(markerPath, async () => {
    const existing = await readMarker(markerPath);
    const cutoff = now.getTime() - ACTIVE_WORKSPACE_SESSION_TTL_MS;
    const projectDirectory = normalizeProjectDirectory(input.projectDirectory);
    const record: ActiveWorkspaceSessionRecord = {
      sessionId,
      sessionKey,
      projectDirectory,
      ...(input.statePath !== undefined && input.statePath.trim() !== "" ? { statePath: input.statePath } : {}),
      touchedAt: now.toISOString(),
    };

    const sessions = existing.sessions.filter((session) => {
      const touchedAt = Date.parse(session.touchedAt);
      if (!Number.isFinite(touchedAt) || touchedAt < cutoff) {
        return false;
      }
      return !(session.sessionKey === sessionKey && session.projectDirectory === projectDirectory);
    });
    sessions.push(record);

    await writeMarker(markerPath, { sessions });
  });
}

export async function resolveActiveWorkspaceSession(
  input: ResolveActiveWorkspaceSessionInput,
): Promise<ActiveWorkspaceSessionResolution> {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? ACTIVE_WORKSPACE_SESSION_TTL_MS;
  const winnerGapMs = input.winnerGapMs ?? ACTIVE_WORKSPACE_SESSION_WINNER_GAP_MS;
  const markerPath = activeWorkspaceSessionsPath(input.platform, input.environment);
  return await withMarkerLock(markerPath, async () => {
    const marker = await readMarker(markerPath);
    const projectDirectory = normalizeProjectDirectory(input.projectDirectory);
    const cutoff = now.getTime() - ttlMs;
    const retained = marker.sessions.filter((session) => {
      const touchedAt = Date.parse(session.touchedAt);
      return Number.isFinite(touchedAt) && touchedAt >= cutoff;
    });
    const fresh = retained
      .filter((session) => {
        const touchedAt = Date.parse(session.touchedAt);
        return Number.isFinite(touchedAt) && touchedAt >= cutoff && session.projectDirectory === projectDirectory;
      })
      .sort((left, right) => Date.parse(right.touchedAt) - Date.parse(left.touchedAt));

    if (retained.length !== marker.sessions.length) {
      await writeMarker(markerPath, { sessions: retained }).catch(() => {});
    }

    if (fresh.length === 0) {
      return { status: "missing" };
    }
    if (fresh.length === 1) {
      return resolvedSession(fresh[0]);
    }

    const newest = fresh[0];
    const runnerUp = fresh[1];
    if (Date.parse(newest.touchedAt) - Date.parse(runnerUp.touchedAt) >= winnerGapMs) {
      return resolvedSession(newest);
    }

    return { status: "ambiguous", candidates: fresh };
  });
}

async function withMarkerLock<T>(markerPath: string, callback: () => Promise<T>): Promise<T> {
  const lockPath = `${markerPath}.lock`;
  await acquireMarkerLock(lockPath);
  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function acquireMarkerLock(lockPath: string): Promise<void> {
  await ensurePrivateDirectory(path.dirname(lockPath));
  const startedAt = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (Date.now() - startedAt >= ACTIVE_WORKSPACE_SESSION_LOCK_MAX_WAIT_MS) {
        throw new Error(`Timed out acquiring active workspace session marker lock: ${lockPath}`);
      }
      await delay(ACTIVE_WORKSPACE_SESSION_LOCK_RETRY_DELAY_MS);
    }
  }
}

async function readMarker(markerPath: string): Promise<ActiveWorkspaceSessionMarker> {
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
    if (!isMarkerObject(parsed)) {
      return { sessions: [] };
    }
    if (!Array.isArray(parsed.sessions)) {
      return { sessions: [] };
    }
    const sessions: ActiveWorkspaceSessionRecord[] = [];
    for (const value of parsed.sessions) {
      const record = validRecord(value);
      if (record === undefined) {
        return { sessions: [] };
      }
      sessions.push(record);
    }
    return { sessions };
  } catch {
    return { sessions: [] };
  }
}

function isMarkerObject(value: unknown): value is { sessions: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "sessions" in value
  );
}

async function writeMarker(markerPath: string, marker: ActiveWorkspaceSessionMarker): Promise<void> {
  await writePrivateFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}

async function delay(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function validRecord(value: unknown): ActiveWorkspaceSessionRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim() === "" ||
    typeof record.sessionKey !== "string" ||
    record.sessionKey.trim() === "" ||
    typeof record.projectDirectory !== "string" ||
    record.projectDirectory.trim() === "" ||
    typeof record.touchedAt !== "string" ||
    !Number.isFinite(Date.parse(record.touchedAt))
  ) {
    return undefined;
  }
  return {
    sessionId: record.sessionId.trim(),
    sessionKey: record.sessionKey.trim(),
    projectDirectory: normalizeProjectDirectory(record.projectDirectory),
    ...(typeof record.statePath === "string" && record.statePath.trim() !== "" ? { statePath: record.statePath } : {}),
    touchedAt: new Date(record.touchedAt).toISOString(),
  };
}

function resolvedSession(record: ActiveWorkspaceSessionRecord): ActiveWorkspaceSessionResolution {
  return {
    status: "resolved",
    sessionId: record.sessionId,
    sessionKey: record.sessionKey,
    projectDirectory: record.projectDirectory,
    ...(record.statePath !== undefined ? { statePath: record.statePath } : {}),
  };
}

function normalizeProjectDirectory(projectDirectory: string): string {
  return path.resolve(projectDirectory);
}
