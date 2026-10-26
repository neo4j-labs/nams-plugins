import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./hashing.js";
import { writePrivateFile } from "./permissions.js";
import { sessionStateDirectory, sessionStatePath as sessionStatePathFn } from "./paths.js";
export function resolveSessionKey(input) {
    if (input.sessionId !== undefined && input.sessionId.trim() !== "") {
        return input.sessionId;
    }
    return `cwd-${sha256(input.projectDirectory)}`;
}
export async function loadSessionState(platform, sessionKey) {
    const statePath = await findSessionStatePath(process.env, platform, sessionKey);
    if (statePath === undefined) {
        return null;
    }
    try {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        if (state.lastRecallAt === undefined && typeof state.lastMemorySearchAt === "string") {
            state.lastRecallAt = state.lastMemorySearchAt;
        }
        delete state.lastMemorySearchAt;
        state.seenAssistantMessageHashes ??= [];
        state.seenTranscriptEntryIds ??= [];
        state.seenReasoningStepHashes ??= [];
        state.seenToolCallIds ??= [];
        state.reasoningStepIdsByHash ??= {};
        return state;
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}
export async function saveSessionState(platform, sessionKey, state) {
    const statePath = sessionStatePathFn(platform, sessionKey, state.createdAt);
    await writePrivateFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}
export function createInitialSessionState(input, now = new Date()) {
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
async function findSessionStatePath(env, platform, sessionKey) {
    const stateDirectory = sessionStateDirectory(platform, env);
    const suffix = `--${sha256(sessionKey)}.json`;
    let filenames;
    try {
        filenames = await readdir(stateDirectory);
    }
    catch (error) {
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
