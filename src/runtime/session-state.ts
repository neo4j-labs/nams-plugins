import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../interfaces.js";
import { sha256 } from "./hashing.js";
import { writePrivateFile } from "./permissions.js";
import { RuntimeEnvironment } from "./paths.js";

export type SessionWorkspaceSource =
  | "config"
  | "runtime-single-workspace"
  | "install-selection"
  | "session-selection";

export interface SessionWorkspaceState {
  id: string;
  source: SessionWorkspaceSource;
  selectedAt: string;
}

export interface SessionState {
  harness: Platform;
  harnessSessionId?: string;
  sessionKey: string;
  projectDirectory: string;
  conversationId?: string;
  workspace?: SessionWorkspaceState;
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
  platform: Platform,
  sessionKey: string,
): Promise<SessionState | null> {
  const statePath = await findSessionStatePath(RuntimeEnvironment.fromProcess(), platform, sessionKey);
  if (statePath === undefined) {
    return null;
  }
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as SessionState & {
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
  platform: Platform,
  sessionKey: string,
  state: SessionState,
): Promise<void> {
  const statePath = RuntimeEnvironment.fromProcess().sessionStatePath(platform, sessionKey, state.createdAt);
  await writePrivateFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
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

async function findSessionStatePath(
  environment: RuntimeEnvironment,
  platform: Platform,
  sessionKey: string,
): Promise<string | undefined> {
  const stateDirectory = environment.sessionStateDirectory(platform);
  const suffix = `--${sha256(sessionKey)}.json`;
  let filenames: string[];
  try {
    filenames = await readdir(stateDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const matchingFilename = filenames
    .filter((filename) => filename.startsWith("session-") && filename.endsWith(suffix))
    .sort()
    .at(-1);
  return matchingFilename === undefined ? undefined : path.join(stateDirectory, matchingFilename);
}
