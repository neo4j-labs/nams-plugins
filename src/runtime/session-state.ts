import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../interfaces.js";
import { sha256 } from "./hashing.js";
import { sessionStatePath } from "./paths.js";

export interface SessionState {
  harness: Platform;
  harnessSessionId?: string;
  sessionKey: string;
  projectDirectory: string;
  conversationId?: string;
  createdAt: string;
  lastRecallAt?: string;
  pendingMemoryContext?: {
    messageId?: string;
    content: string;
    createdAt: string;
  };
  lastUserMessageHash?: string;
  lastAssistantMessageHash?: string;
  seenUserMessageIds?: string[];
  seenAssistantPartIds?: string[];
  seenAssistantMessageHashes: string[];
  seenTranscriptEntryIds: string[];
  seenReasoningStepHashes: string[];
  seenToolCallIds: string[];
  reasoningStepIdsByHash: Record<string, string>;
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
  env: Record<string, string | undefined> = process.env,
): Promise<SessionState | null> {
  void projectDirectory;
  try {
    const state = JSON.parse(await readFile(sessionStatePath(platform, sessionKey, env), "utf8")) as SessionState & {
      lastMemorySearchAt?: string;
    };
    if (state.lastRecallAt === undefined && typeof state.lastMemorySearchAt === "string") {
      state.lastRecallAt = state.lastMemorySearchAt;
    }
    delete state.lastMemorySearchAt;
    return state;
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
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  void projectDirectory;
  const statePath = sessionStatePath(platform, sessionKey, env);
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
    seenAssistantMessageHashes: [],
    seenTranscriptEntryIds: [],
    seenReasoningStepHashes: [],
    seenToolCallIds: [],
    reasoningStepIdsByHash: {},
  };
}
