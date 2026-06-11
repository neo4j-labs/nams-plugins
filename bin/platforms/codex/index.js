import { sha256 } from "../../runtime/hashing.js";
import { appendNamsFailureDiagnostic, appendRawPlatformLog, } from "../../runtime/logging.js";
import { combineMemoryContexts, createNamsMemoryService, serializeToolInput, } from "../../runtime/memory-service.js";
import { createInitialSessionState, loadSessionState, saveSessionState, } from "../../runtime/session-state.js";
import { loadEffectiveNamsConfigForMemory, resolveWorkspaceForMemory, } from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { parseCodexPayload } from "./payload.js";
import { readCodexTranscript } from "./transcript.js";
export class CodexAdapter {
    async startSession(invocation) {
        const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
        const initialState = createInitialSessionState({
            platform: invocation.platform,
            sessionId: payloadInfo.sessionId,
            projectDirectory: payloadInfo.projectDirectory,
        });
        const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
            initialState;
        await appendRawPlatformLog(invocation, state);
        await saveSessionState(invocation.platform, state.sessionKey, state);
        return { stdout: { continue: true, suppressOutput: true } };
    }
    async beforeAgent(invocation) {
        const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
        const initialState = createInitialSessionState({
            platform: invocation.platform,
            sessionId: payloadInfo.sessionId,
            projectDirectory: payloadInfo.projectDirectory,
        });
        const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
            initialState;
        await appendRawPlatformLog(invocation, state);
        if (payloadInfo.prompt === undefined) {
            await saveSessionState(invocation.platform, state.sessionKey, state);
            return allowOutput();
        }
        const workspaceResult = await resolveWorkspaceForMemory({
            invocation,
            state,
            projectDirectory: payloadInfo.projectDirectory,
        });
        if (workspaceResult.status !== "ready") {
            await saveSessionState(invocation.platform, state.sessionKey, state);
            return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
        }
        const config = workspaceResult.config;
        let additionalContext;
        try {
            const memory = createNamsMemoryService(config, invocation, state);
            let conversationId = state.conversationId;
            if (conversationId === undefined) {
                conversationId = await memory.createConversation({
                    harness: invocation.platform,
                    projectDirectory: payloadInfo.projectDirectory,
                });
                state.conversationId = conversationId;
            }
            if (state.lastRecallAt === undefined) {
                const recallContexts = [];
                try {
                    recallContexts.push(await memory.recall(conversationId));
                }
                catch {
                    await appendNamsFailureDiagnostic(invocation, state);
                }
                try {
                    recallContexts.push(await memory.searchEntities(payloadInfo.prompt));
                }
                catch {
                    await appendNamsFailureDiagnostic(invocation, state);
                }
                state.lastRecallAt = new Date().toISOString();
                const recalledContext = combineMemoryContexts(recallContexts);
                if (recalledContext.trim() !== "") {
                    additionalContext = recalledContext;
                }
            }
            const promptHash = sha256([invocation.platform, state.sessionKey, "user", payloadInfo.prompt.trim()].join("\n"));
            if (state.lastUserMessageHash !== promptHash) {
                await memory.storeUserMessage(conversationId, payloadInfo.prompt);
                state.lastUserMessageHash = promptHash;
            }
        }
        catch {
            await appendNamsFailureDiagnostic(invocation, state);
            await saveSessionState(invocation.platform, state.sessionKey, state);
            return allowOutput(additionalContext);
        }
        await saveSessionState(invocation.platform, state.sessionKey, state);
        return allowOutput(additionalContext);
    }
    async afterAgent(invocation) {
        const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
        const initialState = createInitialSessionState({
            platform: invocation.platform,
            sessionId: payloadInfo.sessionId,
            projectDirectory: payloadInfo.projectDirectory,
        });
        const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
            initialState;
        await appendRawPlatformLog(invocation, state);
        state.seenAssistantMessageHashes ??= [];
        state.seenTranscriptEntryIds ??= [];
        state.seenToolCallIds ??= [];
        state.seenReasoningStepHashes ??= [];
        state.reasoningStepIdsByHash ??= {};
        if (state.conversationId === undefined) {
            await saveSessionState(invocation.platform, state.sessionKey, state);
            return allowOutput();
        }
        const conversationId = state.conversationId;
        const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
        if (config === undefined) {
            await saveSessionState(invocation.platform, state.sessionKey, state);
            return allowOutput();
        }
        try {
            const memory = createNamsMemoryService(config, invocation, state);
            const response = payloadInfo.lastAssistantMessage?.trim();
            if (response !== undefined && response !== "") {
                const responseDedupeHash = assistantMessageDedupeHash(invocation.platform, state.sessionKey, response, payloadInfo.turnId);
                if (!hasSeenAssistantMessage(state, responseDedupeHash)) {
                    await memory.storeAssistantMessage(conversationId, response);
                }
                markAssistantMessageSeen(state, assistantMessageHashes(invocation.platform, state.sessionKey, response, payloadInfo.turnId));
            }
            if (payloadInfo.transcriptPath !== undefined) {
                const entries = await readCodexTranscript(payloadInfo.transcriptPath);
                if (response === undefined || response === "") {
                    await storeAssistantMessagesFromTranscript(invocation.platform, conversationId, state, memory, entries);
                }
                await recordTraceFromTranscript(conversationId, state, memory, entries);
            }
        }
        catch {
            await appendNamsFailureDiagnostic(invocation, state);
            await saveSessionState(invocation.platform, state.sessionKey, state);
            return allowOutput();
        }
        await saveSessionState(invocation.platform, state.sessionKey, state);
        return allowOutput();
    }
    async afterTool(invocation) {
        const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
        const initialState = createInitialSessionState({
            platform: invocation.platform,
            sessionId: payloadInfo.sessionId,
            projectDirectory: payloadInfo.projectDirectory,
        });
        const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
            initialState;
        await appendRawPlatformLog(invocation, state);
        state.seenToolCallIds ??= [];
        state.seenReasoningStepHashes ??= [];
        state.reasoningStepIdsByHash ??= {};
        const conversationId = state.conversationId;
        const toolName = payloadInfo.toolName;
        if (conversationId === undefined || toolName === undefined) {
            await saveSessionState(invocation.platform, state.sessionKey, state);
            return allowPostToolUseOutput();
        }
        const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
        if (config === undefined) {
            await saveSessionState(invocation.platform, state.sessionKey, state);
            return allowPostToolUseOutput();
        }
        const toolInput = payloadInfo.toolInput ?? {};
        const toolCallId = codexToolCallId({
            sessionKey: state.sessionKey,
            toolName,
            turnId: payloadInfo.turnId,
            toolUseId: payloadInfo.toolUseId,
            toolInput,
        });
        if (state.seenToolCallIds.includes(toolCallId)) {
            await saveSessionState(invocation.platform, state.sessionKey, state);
            return allowPostToolUseOutput();
        }
        const reasoningHash = codexReasoningStepHash({
            sessionKey: state.sessionKey,
            toolName,
            turnId: payloadInfo.turnId,
        });
        try {
            const memory = createNamsMemoryService(config, invocation, state);
            let stepId = state.reasoningStepIdsByHash[reasoningHash];
            if (!state.seenReasoningStepHashes.includes(reasoningHash)) {
                stepId = await memory.recordReasoningStep({
                    conversationId,
                    reasoning: `Codex ran ${toolName} for the current turn.`,
                    actionTaken: `Ran ${toolName}`,
                    ...(payloadInfo.toolResponse !== undefined ? { result: "Codex exposed post-tool output." } : {}),
                });
                markReasoningStepSeen(state, reasoningHash, stepId);
            }
            await memory.recordToolCall({
                ...(stepId !== undefined ? { stepId } : {}),
                toolName,
                input: toolInput,
                ...(payloadInfo.toolResponse !== undefined ? { output: payloadInfo.toolResponse } : {}),
            });
            markToolCallSeen(state, toolCallId);
        }
        catch {
            await appendNamsFailureDiagnostic(invocation, state);
            await saveSessionState(invocation.platform, state.sessionKey, state);
            return allowPostToolUseOutput();
        }
        await saveSessionState(invocation.platform, state.sessionKey, state);
        return allowPostToolUseOutput();
    }
}
function allowOutput(additionalContext) {
    return {
        stdout: {
            continue: true,
            suppressOutput: true,
            ...(additionalContext !== undefined
                ? {
                    hookSpecificOutput: {
                        hookEventName: "UserPromptSubmit",
                        additionalContext,
                    },
                }
                : {}),
        },
    };
}
function workspaceResultOutput(result, sessionId) {
    if (result.reason === "selection-required") {
        return allowOutput(formatWorkspaceSelectionNotice("codex", result.workspaces, sessionId));
    }
    return allowOutput();
}
function allowPostToolUseOutput() {
    return { stdout: { continue: true } };
}
async function storeAssistantMessagesFromTranscript(platform, conversationId, state, memory, entries) {
    for (const entry of entries) {
        if (entry.kind !== "assistant") {
            continue;
        }
        if (entry.id !== undefined && state.seenTranscriptEntryIds.includes(entry.id)) {
            continue;
        }
        const content = entry.content.trim();
        if (content !== "") {
            const responseHash = assistantContentHash(platform, state.sessionKey, content);
            if (!hasSeenAssistantMessage(state, responseHash)) {
                await memory.storeAssistantMessage(conversationId, content);
            }
            markAssistantMessageSeen(state, [responseHash]);
        }
        if (entry.id !== undefined) {
            state.seenTranscriptEntryIds.push(entry.id);
        }
    }
}
async function recordTraceFromTranscript(conversationId, state, memory, entries) {
    for (const entry of entries) {
        if (entry.kind !== "toolCall") {
            continue;
        }
        const toolCallId = codexTranscriptToolCallId(state.sessionKey, entry);
        if (state.seenToolCallIds.includes(toolCallId)) {
            continue;
        }
        const reasoningHash = codexTranscriptReasoningStepHash(state.sessionKey, entry.name, entry.status);
        let stepId = state.reasoningStepIdsByHash[reasoningHash];
        if (!state.seenReasoningStepHashes.includes(reasoningHash)) {
            stepId = await memory.recordReasoningStep({
                conversationId,
                reasoning: `Codex exposed ${entry.name} from the session transcript.`,
                actionTaken: `Ran ${entry.name}`,
                ...(entry.status !== undefined ? { result: `Codex transcript recorded status: ${entry.status}.` } : {}),
            });
            markReasoningStepSeen(state, reasoningHash, stepId);
        }
        await memory.recordToolCall({
            ...(stepId !== undefined ? { stepId } : {}),
            toolName: entry.name,
            input: entry.args,
            ...(entry.status !== undefined ? { status: entry.status } : {}),
        });
        markToolCallSeen(state, toolCallId);
    }
}
function assistantMessageDedupeHash(platform, sessionKey, content, turnId) {
    if (turnId === undefined) {
        return assistantContentHash(platform, sessionKey, content);
    }
    return sha256([platform, sessionKey, "assistant", "turn", turnId, content].join("\n"));
}
function assistantMessageHashes(platform, sessionKey, content, turnId) {
    const contentHash = assistantContentHash(platform, sessionKey, content);
    if (turnId === undefined) {
        return [contentHash];
    }
    return [assistantMessageDedupeHash(platform, sessionKey, content, turnId), contentHash];
}
function assistantContentHash(platform, sessionKey, content) {
    return sha256([platform, sessionKey, "assistant", content].join("\n"));
}
function hasSeenAssistantMessage(state, hash) {
    return state.lastAssistantMessageHash === hash || state.seenAssistantMessageHashes.includes(hash);
}
function markAssistantMessageSeen(state, hashes) {
    state.lastAssistantMessageHash = hashes[0];
    for (const hash of hashes) {
        if (!state.seenAssistantMessageHashes.includes(hash)) {
            state.seenAssistantMessageHashes.push(hash);
        }
    }
}
function codexToolCallId(input) {
    if (input.toolUseId !== undefined) {
        return `codex-tool-use-id:${input.toolUseId}`;
    }
    return `codex-tool-fallback:${sha256([input.sessionKey, input.turnId ?? "", input.toolName, serializeToolInput(input.toolInput)].join("\n"))}`;
}
function codexReasoningStepHash(input) {
    return sha256([input.sessionKey, "codex-reasoning-step", input.turnId ?? "", input.toolName].join("\n"));
}
function codexTranscriptToolCallId(sessionKey, entry) {
    if (entry.id !== undefined) {
        return `codex-transcript-tool-id:${entry.id}`;
    }
    return `codex-transcript-tool-fallback:${sha256([sessionKey, String(entry.transcriptEntryIndex), entry.name, serializeToolInput(entry.args)].join("\n"))}`;
}
function codexTranscriptReasoningStepHash(sessionKey, toolName, status) {
    return sha256([sessionKey, "codex-transcript-reasoning-step", toolName, status ?? ""].join("\n"));
}
function markReasoningStepSeen(state, hash, stepId) {
    if (!state.seenReasoningStepHashes.includes(hash)) {
        state.seenReasoningStepHashes.push(hash);
    }
    if (stepId !== undefined) {
        state.reasoningStepIdsByHash[hash] = stepId;
    }
}
function markToolCallSeen(state, toolCallId) {
    if (!state.seenToolCallIds.includes(toolCallId)) {
        state.seenToolCallIds.push(toolCallId);
    }
}
