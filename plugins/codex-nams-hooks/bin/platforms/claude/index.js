import { stableJsonHash } from "../../runtime/hashing.js";
import { appendNamsFailureDiagnostic } from "../../runtime/logging.js";
import { createNamsMemoryService } from "../../runtime/memory-service.js";
import { assistantContentHash, ensureConversation, recallMemoryContextOnce, recordToolCallOnce, storeAssistantMessageOnce, storeUserPromptOnce, withHookSessionState, } from "../../runtime/memory-turn.js";
import { loadEffectiveNamsConfigForMemory, resolveWorkspaceForMemory, } from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { discoverClaudeNamsConfig } from "./config.js";
import { parseClaudePayload } from "./payload.js";
export { formatClaudeReplaySummary, runClaudeReplay, } from "./replay-runner.js";
async function startSession(invocation) {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async () => allowOutput());
}
async function beforeAgent(invocation) {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
        if (payloadInfo.prompt === undefined) {
            return allowOutput();
        }
        const workspaceResult = await resolveWorkspaceForMemory({
            invocation,
            state,
            projectDirectory: payloadInfo.projectDirectory,
            discoverConfig: discoverClaudeNamsConfig,
        });
        if (workspaceResult.status !== "ready") {
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
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
        if (state.conversationId === undefined) {
            return allowOutput();
        }
        const response = payloadInfo.lastAssistantMessage?.trim();
        if (response === undefined || response === "") {
            return allowOutput();
        }
        const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory, discoverClaudeNamsConfig);
        if (config === undefined) {
            return allowOutput();
        }
        try {
            const memory = createNamsMemoryService(config, invocation, state);
            const responseHash = assistantContentHash(invocation.platform, state.sessionKey, response);
            await storeAssistantMessageOnce(memory, state, state.conversationId, response, {
                lookupHash: responseHash,
                markHashes: [responseHash],
            });
        }
        catch {
            await appendNamsFailureDiagnostic(invocation, state);
        }
        return allowOutput();
    });
}
async function afterTool(invocation) {
    const payloadInfo = parseClaudePayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
        if (state.conversationId === undefined || payloadInfo.toolName === undefined) {
            return allowOutput();
        }
        const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory, discoverClaudeNamsConfig);
        if (config === undefined) {
            return allowOutput();
        }
        try {
            const memory = createNamsMemoryService(config, invocation, state);
            const reasoningStep = {
                conversationId: state.conversationId,
                reasoning: `Claude Code ran ${payloadInfo.toolName} with the provided tool input.`,
                actionTaken: `Ran ${payloadInfo.toolName}`,
            };
            await recordToolCallOnce(memory, state, claudeToolCallDedupeKeys(state.sessionKey, payloadInfo.toolUseId, payloadInfo.toolName, payloadInfo.toolInput), reasoningStep, stableJsonHash({ sessionKey: state.sessionKey, ...reasoningStep }), {
                toolName: payloadInfo.toolName,
                input: payloadInfo.toolInput,
                ...(payloadInfo.toolResponse !== undefined ? { output: payloadInfo.toolResponse } : {}),
                status: "success",
                ...(payloadInfo.durationMs !== undefined ? { durationMs: payloadInfo.durationMs } : {}),
            });
        }
        catch {
            await appendNamsFailureDiagnostic(invocation, state);
        }
        return allowOutput();
    });
}
export const claudeMemoryAdapter = { startSession, beforeAgent, afterAgent, afterTool };
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
        const message = formatWorkspaceSelectionNotice("claude", result.workspaces, sessionId, [
            "In Claude Code sessions with nams-hooks installed, you can select a workspace with: /nams:workspace use <workspace-id-or-name>",
            "For marketplace plugin installs, use: /nams-hooks:nams:workspace use <workspace-id-or-name>",
        ]);
        return {
            stdout: {
                continue: true,
                suppressOutput: false,
                systemMessage: message,
                hookSpecificOutput: {
                    hookEventName: "UserPromptSubmit",
                    additionalContext: message,
                },
            },
        };
    }
    return allowOutput();
}
function claudeToolCallDedupeKeys(sessionKey, toolUseId, toolName, toolInput) {
    const fallbackHash = stableJsonHash({ sessionKey, toolName, input: toolInput });
    const fallbackKey = `claude-fallback:${fallbackHash}`;
    if (toolUseId !== undefined && toolUseId.trim() !== "") {
        const idKey = `claude-tool-use-id:${stableJsonHash({ sessionKey, toolUseId })}`;
        return {
            lookupKeys: [idKey],
            markKeys: [idKey],
        };
    }
    return {
        lookupKeys: [fallbackKey, fallbackHash],
        markKeys: [fallbackKey, fallbackHash],
    };
}
