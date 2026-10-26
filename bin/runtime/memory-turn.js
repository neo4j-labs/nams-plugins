import { hasSeenAny, hasSeenAssistantMessage, markSeen, markAssistantMessageSeen, } from "./dedupe.js";
import { sha256 } from "./hashing.js";
import { appendNamsFailureDiagnostic, appendRawPlatformLog } from "./logging.js";
import { combineMemoryContexts, } from "./memory-service.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "./session-state.js";
export async function loadHookSessionState(invocation, payload) {
    const initialState = createInitialSessionState({
        platform: invocation.platform,
        ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
        projectDirectory: payload.projectDirectory,
    });
    const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ?? initialState;
    await appendRawPlatformLog(invocation, state);
    return state;
}
export async function withHookSessionState(invocation, payload, run) {
    const state = await loadHookSessionState(invocation, payload);
    try {
        return await run(state);
    }
    finally {
        await saveSessionState(invocation.platform, state.sessionKey, state);
    }
}
export async function ensureConversation(memory, invocation, state, projectDirectory) {
    if (state.conversationId === undefined) {
        state.conversationId = await memory.createConversation({
            harness: invocation.platform,
            projectDirectory,
        });
    }
    return state.conversationId;
}
export async function recallMemoryContextOnce(memory, invocation, state, conversationId, prompt) {
    if (state.lastRecallAt !== undefined) {
        return undefined;
    }
    const recallContexts = [];
    try {
        recallContexts.push(await memory.recall(conversationId));
    }
    catch {
        await appendNamsFailureDiagnostic(invocation, state);
    }
    try {
        recallContexts.push(await memory.searchEntities(prompt));
    }
    catch {
        await appendNamsFailureDiagnostic(invocation, state);
    }
    state.lastRecallAt = new Date().toISOString();
    const recalledContext = combineMemoryContexts(recallContexts);
    return recalledContext.trim() === "" ? undefined : recalledContext;
}
export async function storeUserPromptOnce(memory, invocation, state, conversationId, prompt) {
    const promptHash = sha256([invocation.platform, state.sessionKey, "user", prompt.trim()].join("\n"));
    if (state.lastUserMessageHash !== promptHash) {
        await memory.storeUserMessage(conversationId, prompt);
        state.lastUserMessageHash = promptHash;
    }
}
export function assistantContentHash(platform, sessionKey, content) {
    return sha256([platform, sessionKey, "assistant", content].join("\n"));
}
export async function storeAssistantMessageOnce(memory, state, conversationId, content, keys) {
    if (!hasSeenAssistantMessage(state, keys.lookupHash)) {
        await memory.storeAssistantMessage(conversationId, content);
    }
    markAssistantMessageSeen(state, keys.markHashes);
}
export async function recordToolCallOnce(memory, state, keys, reasoningStep, reasoningStepHash, toolCall) {
    if (hasSeenAny(state.seenToolCallIds, keys.lookupKeys)) {
        return;
    }
    let stepId = state.reasoningStepIdsByHash[reasoningStepHash];
    if (!state.seenReasoningStepHashes.includes(reasoningStepHash)) {
        stepId = await memory.recordReasoningStep(reasoningStep);
        state.seenReasoningStepHashes.push(reasoningStepHash);
        if (stepId !== undefined) {
            state.reasoningStepIdsByHash[reasoningStepHash] = stepId;
        }
    }
    await memory.recordToolCall({
        ...(stepId !== undefined ? { stepId } : {}),
        ...toolCall,
    });
    markSeen(state.seenToolCallIds, keys.markKeys);
}
