import { stableJsonHash } from "../../runtime/hashing.js";
import { recordActiveWorkspaceSession } from "../../runtime/active-workspace-session.js";
import { firstDefined, firstRecord, firstString } from "../../runtime/util.js";
import { hasSeenAny, markSeen } from "../../runtime/dedupe.js";
import { pickStringFields } from "../payload.js";
import { appendNamsFailureDiagnostic } from "../../runtime/logging.js";
import { createNamsMemoryService } from "../../runtime/memory-service.js";
import { assistantContentHash, ensureConversation, recallMemoryContextOnce, recordToolCallOnce, storeAssistantMessageOnce, storeUserPromptOnce, withHookSessionState, } from "../../runtime/memory-turn.js";
import { sessionStatePath } from "../../runtime/paths.js";
import { loadEffectiveNamsConfigForMemory, resolveWorkspaceForMemory, } from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { parseGeminiPayload } from "./payload.js";
import { readGeminiTranscript } from "./transcript.js";
async function startSession(invocation) {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
        await recordActiveGeminiWorkspaceSession(invocation, state, payloadInfo.projectDirectory, payloadInfo.sessionId);
        return { stdout: { continue: true, suppressOutput: true } };
    });
}
async function beforeAgent(invocation) {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
        if (payloadInfo.prompt === undefined || isWorkspaceCommandResultPrompt(payloadInfo.prompt)) {
            return allowOutput();
        }
        const workspaceResult = await resolveWorkspaceForMemory({
            invocation,
            state,
            projectDirectory: payloadInfo.projectDirectory,
        });
        if (workspaceResult.status !== "ready") {
            if (workspaceResult.reason === "selection-required") {
                await recordActiveGeminiWorkspaceSession(invocation, state, payloadInfo.projectDirectory, payloadInfo.sessionId);
            }
            return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
        }
        let additionalContext;
        try {
            const memory = createNamsMemoryService(workspaceResult.config, invocation, state);
            const conversationId = await ensureConversation(memory, invocation, state, payloadInfo.projectDirectory);
            additionalContext = await recallMemoryContextOnce(memory, invocation, state, conversationId, payloadInfo.prompt);
            await storeUserPromptOnce(memory, invocation, state, conversationId, payloadInfo.prompt);
        }
        catch {
            await appendNamsFailureDiagnostic(invocation, state);
        }
        return allowOutput(additionalContext);
    });
}
async function afterAgent(invocation) {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
        if (state.conversationId === undefined) {
            return allowOutput();
        }
        const conversationId = state.conversationId;
        const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
        if (config === undefined) {
            return allowOutput();
        }
        try {
            const memory = createNamsMemoryService(config, invocation, state);
            const response = payloadInfo.promptResponse?.trim();
            if (response !== undefined && response !== "") {
                const responseHash = assistantContentHash(invocation.platform, state.sessionKey, response);
                await storeAssistantMessageOnce(memory, state, conversationId, response, {
                    lookupHash: responseHash,
                    markHashes: [responseHash],
                });
            }
            if (payloadInfo.transcriptPath !== undefined) {
                const entries = await readGeminiTranscript(payloadInfo.transcriptPath);
                if (response === undefined || response === "") {
                    await storeAssistantMessagesFromTranscript(invocation.platform, conversationId, state, memory, entries);
                }
                await recordTraceFromTranscript(conversationId, state, memory, entries);
            }
        }
        catch {
            await appendNamsFailureDiagnostic(invocation, state);
        }
        return allowOutput();
    });
}
async function afterTool(invocation) {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
        if (state.conversationId === undefined) {
            return allowOutput();
        }
        const toolPayload = parseGeminiAfterToolPayload(invocation.rawPayload);
        if (toolPayload.toolName === undefined) {
            return allowOutput();
        }
        const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
        if (config === undefined) {
            return allowOutput();
        }
        try {
            const memory = createNamsMemoryService(config, invocation, state);
            const reasoningStep = {
                conversationId: state.conversationId,
                reasoning: `Gemini invoked ${toolPayload.toolName} with the provided tool input.`,
                actionTaken: `Ran ${toolPayload.toolName}`,
                ...(toolPayload.outputSummary !== undefined ? { result: toolPayload.outputSummary } : {}),
            };
            await recordToolCallOnce(memory, state, geminiToolCallDedupeKeys(state.sessionKey, toolPayload.toolName, toolPayload.input), reasoningStep, stableJsonHash({ sessionKey: state.sessionKey, ...reasoningStep }), {
                toolName: toolPayload.toolName,
                input: toolPayload.input,
                ...(toolPayload.output !== undefined ? { output: toolPayload.output } : {}),
            });
        }
        catch {
            await appendNamsFailureDiagnostic(invocation, state);
        }
        return allowOutput();
    });
}
export const geminiMemoryAdapter = { startSession, beforeAgent, afterAgent, afterTool };
function allowOutput(additionalContext) {
    return {
        stdout: {
            continue: true,
            suppressOutput: true,
            ...(additionalContext !== undefined
                ? {
                    hookSpecificOutput: {
                        additionalContext,
                    },
                }
                : {}),
        },
    };
}
function workspaceResultOutput(result, sessionId) {
    if (result.reason === "selection-required") {
        const message = formatWorkspaceSelectionNotice("gemini", result.workspaces, sessionId, [
            "Select a session workspace with: /nams:workspace use <workspace-id-or-name>",
        ]);
        return {
            stdout: {
                continue: true,
                suppressOutput: false,
                systemMessage: message,
                hookSpecificOutput: {
                    additionalContext: message,
                },
            },
        };
    }
    return allowOutput();
}
async function recordActiveGeminiWorkspaceSession(invocation, state, projectDirectory, sessionId) {
    try {
        await recordActiveWorkspaceSession({
            platform: invocation.platform,
            sessionId,
            sessionKey: state.sessionKey,
            projectDirectory,
            statePath: sessionStatePath(invocation.platform, state.sessionKey, state.createdAt),
        });
    }
    catch {
        return;
    }
}
function isWorkspaceCommandResultPrompt(prompt) {
    return prompt.trimStart().startsWith("NAMS workspace command result:");
}
function parseGeminiAfterToolPayload(payload) {
    const toolResponse = firstRecord(payload.tool_response);
    const { toolName } = pickStringFields(payload, { toolName: "tool_name" });
    const output = firstString(toolResponse?.llmContent);
    const outputSummary = firstString(toolResponse?.returnDisplay);
    return {
        ...(toolName !== undefined ? { toolName } : {}),
        input: firstDefined(payload.tool_input) ?? {},
        ...(output !== undefined ? { output } : {}),
        ...(outputSummary !== undefined ? { outputSummary } : {}),
    };
}
/**
 * Lookup and mark key sets are deliberately asymmetric.
 *
 * Invariant: one tool call must dedupe across Gemini's id-bearing and id-less
 * payload variants in either arrival order, while two DISTINCT id-bearing calls
 * that happen to share identical input must NOT dedupe.
 *
 * How the keys achieve that:
 * - id-less mark writes `fallback:` + bare hash; an id-bearing lookup includes
 *   `fallback:`, so it finds the earlier mark.
 * - id-bearing mark writes `gemini-id:` + `gemini-id-fallback:` (NOT
 *   `fallback:`); an id-less lookup includes `gemini-id-fallback:`, so it
 *   finds the earlier mark. A second id-bearing call with a different id looks
 *   up `gemini-id:<other>` + `fallback:` - neither was marked - so it records.
 * - the bare hash in lookup keys accepts marks written by older builds.
 *
 * Pinned by test/gemini/gemini-dedupe-keys.test.ts - keep the tests and this
 * comment in sync with any key-shape change, and keep new key shapes findable
 * by the previous version's marks (state files outlive upgrades).
 */
export function geminiToolCallDedupeKeys(sessionKey, toolName, input, geminiToolCallId) {
    const fallbackHash = stableJsonHash({
        sessionKey,
        toolName,
        input,
    });
    const fallbackKey = `fallback:${fallbackHash}`;
    const idFallbackKey = `gemini-id-fallback:${fallbackHash}`;
    if (geminiToolCallId !== undefined && geminiToolCallId.trim() !== "") {
        const idKey = `gemini-id:${stableJsonHash({ sessionKey, geminiToolCallId })}`;
        return {
            lookupKeys: [idKey, fallbackKey, fallbackHash],
            markKeys: [idKey, idFallbackKey],
        };
    }
    return {
        lookupKeys: [fallbackKey, idFallbackKey, fallbackHash],
        markKeys: [fallbackKey, fallbackHash],
    };
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
            await storeAssistantMessageOnce(memory, state, conversationId, content, {
                lookupHash: responseHash,
                markHashes: [responseHash],
            });
        }
        if (entry.id !== undefined) {
            state.seenTranscriptEntryIds.push(entry.id);
        }
    }
}
async function recordTraceFromTranscript(conversationId, state, memory, entries) {
    let currentParentKey;
    let currentParentStepIds = [];
    for (const entry of entries) {
        if (entry.kind === "thought") {
            const parentKey = transcriptParentKey(entry);
            if (parentKey !== currentParentKey) {
                currentParentKey = parentKey;
                currentParentStepIds = [];
            }
            const reasoningStepHash = stableJsonHash({
                sessionKey: state.sessionKey,
                conversationId,
                actionTaken: entry.subject.trim(),
                reasoning: entry.description.trim(),
            });
            if (state.seenReasoningStepHashes.includes(reasoningStepHash)) {
                addCurrentParentStepId(currentParentStepIds, state.reasoningStepIdsByHash[reasoningStepHash]);
                continue;
            }
            const stepId = await memory.recordReasoningStep({
                conversationId,
                reasoning: entry.description,
                actionTaken: entry.subject,
            });
            state.seenReasoningStepHashes.push(reasoningStepHash);
            if (stepId !== undefined) {
                state.reasoningStepIdsByHash[reasoningStepHash] = stepId;
                addCurrentParentStepId(currentParentStepIds, stepId);
            }
            continue;
        }
        if (entry.kind === "toolCall") {
            const parentKey = transcriptParentKey(entry);
            if (parentKey !== currentParentKey) {
                currentParentKey = parentKey;
                currentParentStepIds = [];
            }
            const toolCallKeys = geminiToolCallDedupeKeys(state.sessionKey, entry.name, entry.args, entry.id);
            if (hasSeenAny(state.seenToolCallIds, toolCallKeys.lookupKeys)) {
                continue;
            }
            await memory.recordToolCall({
                ...(currentParentStepIds.length === 1 ? { stepId: currentParentStepIds[0] } : {}),
                toolName: entry.name,
                input: entry.args,
                ...(entry.status !== undefined ? { status: entry.status } : {}),
            });
            markSeen(state.seenToolCallIds, toolCallKeys.markKeys);
        }
    }
}
function addCurrentParentStepId(stepIds, stepId) {
    if (stepId !== undefined && !stepIds.includes(stepId)) {
        stepIds.push(stepId);
    }
}
function transcriptParentKey(entry) {
    return stableJsonHash({
        parentTranscriptEntryId: entry.parentTranscriptEntryId,
        parentTranscriptEntryIndex: entry.parentTranscriptEntryIndex,
    });
}
