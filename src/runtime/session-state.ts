import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../interfaces.js";
import { sha256 } from "./hashing.js";

export interface SessionState {
  harness: Platform;
  harnessSessionId?: string;
  sessionKey: string;
  projectDirectory: string;
  conversationId?: string;
  createdAt: string;
  lastMemorySearchAt?: string;
  lastUserMessageHash?: string;
  lastAssistantMessageHash?: string;
  seenTranscriptEntryIds: string[];
  seenReasoningStepHashes: string[];
  seenToolCallIds: string[];
}

export interface ResolveSessionKeyInput {
  platform: Platform;
  sessionId?: string;
  projectDirectory: string;
}

export function resolveSessionKey(input: ResolveSessionKeyInput): string {
  if (input.sessionId !== undefined && input.sessionId.trim() !== "") {
    return input.sessionId;
  }
  return `cwd-${sha256(input.projectDirectory)}`;
}

export async function loadSessionState(
  projectDirectory: string,
  platform: Platform,
  sessionKey: string,
): Promise<SessionState | null> {
  try {
    return JSON.parse(await readFile(sessionStatePath(projectDirectory, platform, sessionKey), "utf8")) as SessionState;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveSessionState(
  projectDirectory: string,
  platform: Platform,
  sessionKey: string,
  state: SessionState,
): Promise<void> {
  const statePath = sessionStatePath(projectDirectory, platform, sessionKey);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function createInitialSessionState(input: ResolveSessionKeyInput, now = new Date()): SessionState {
  const sessionKey = resolveSessionKey(input);
  return {
    harness: input.platform,
    ...(input.sessionId !== undefined && input.sessionId.trim() !== "" ? { harnessSessionId: input.sessionId } : {}),
    sessionKey,
    projectDirectory: input.projectDirectory,
    createdAt: now.toISOString(),
    seenTranscriptEntryIds: [],
    seenReasoningStepHashes: [],
    seenToolCallIds: [],
  };
}

function sessionStatePath(projectDirectory: string, platform: Platform, sessionKey: string): string {
  return path.join(projectDirectory, ".nams", "state", "sessions", platform, `${sha256(sessionKey)}.json`);
}
