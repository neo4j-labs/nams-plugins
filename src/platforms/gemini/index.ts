import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { sha256, stableJsonHash } from "../../runtime/hashing.js";
import { recordActiveWorkspaceSession } from "../../runtime/active-workspace-session.js";
import { hasSeenAny, hasSeenAssistantMessage, markAssistantMessageSeen, markSeen, type AssistantMessageState } from "../dedupe.js";
import { pickStringFields } from "../payload.js";
import {
  appendNamsFailureDiagnostic,
  appendRawPlatformLog,
} from "../../runtime/logging.js";
import {
  combineMemoryContexts,
  createNamsMemoryService,
  type NamsMemoryService,
} from "../../runtime/memory-service.js";
import { sessionStatePath } from "../../runtime/paths.js";
import {
  createInitialSessionState,
  loadSessionState,
  saveSessionState,
  type SessionState,
} from "../../runtime/session-state.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { parseGeminiPayload } from "./payload.js";
import { readGeminiTranscript, type GeminiTranscriptEntry } from "./transcript.js";

export class GeminiAdapter implements MemoryPlatformAdapter {
  async startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    await appendRawPlatformLog(invocation, state);
    await saveSessionState(invocation.platform, state.sessionKey, state);
    await recordActiveGeminiWorkspaceSession(
      invocation,
      state,
      payloadInfo.projectDirectory,
      payloadInfo.sessionId,
    );

    return { stdout: { continue: true, suppressOutput: true } };
  }

  async beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    await appendRawPlatformLog(invocation, state);

    if (payloadInfo.prompt === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }
    if (isWorkspaceCommandResultPrompt(payloadInfo.prompt)) {
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
      if (workspaceResult.reason === "selection-required") {
        await recordActiveGeminiWorkspaceSession(
          invocation,
          state,
          payloadInfo.projectDirectory,
          payloadInfo.sessionId,
        );
      }
      return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
    }
    const config = workspaceResult.config;

    let additionalContext: string | undefined;
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
        const recallContexts: string[] = [];
        try {
          recallContexts.push(await memory.recall(conversationId));
        } catch {
          await appendNamsFailureDiagnostic(invocation, state);
        }
        try {
          recallContexts.push(await memory.searchEntities(payloadInfo.prompt));
        } catch {
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
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput(additionalContext);
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput(additionalContext);
  }

  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    await appendRawPlatformLog(invocation, state);
    state.seenAssistantMessageHashes ??= [];
    state.seenTranscriptEntryIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.seenToolCallIds ??= [];
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
      const response = payloadInfo.promptResponse?.trim();
      if (response !== undefined && response !== "") {
        const responseHash = sha256([invocation.platform, state.sessionKey, "assistant", response].join("\n"));
        if (!hasSeenAssistantMessage(state, responseHash)) {
          await memory.storeAssistantMessage(state.conversationId, response);
        }
        markAssistantMessageSeen(state, [responseHash]);
      }

      if (payloadInfo.transcriptPath !== undefined) {
        const entries = await readGeminiTranscript(payloadInfo.transcriptPath);
        if (response === undefined || response === "") {
          await storeAssistantMessagesFromTranscript(invocation.platform, conversationId, state, memory, entries);
        }
        await recordTraceFromTranscript(conversationId, state, memory, entries);
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  async afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseGeminiPayload(invocation.rawPayload, invocation.processCwd);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      sessionId: payloadInfo.sessionId,
      projectDirectory: payloadInfo.projectDirectory,
    });
    const state =
      (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
      initialState;
    await appendRawPlatformLog(invocation, state);
    state.seenToolCallIds ??= [];
    state.seenReasoningStepHashes ??= [];
    state.reasoningStepIdsByHash ??= {};

    if (state.conversationId === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const toolPayload = parseGeminiAfterToolPayload(invocation.rawPayload);
    if (toolPayload.toolName === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
    if (config === undefined) {
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    try {
      const toolCallKeys = geminiToolCallDedupeKeys(
        state.sessionKey,
        toolPayload.toolName,
        toolPayload.input,
      );
      if (!hasSeenAny(state.seenToolCallIds, toolCallKeys.lookupKeys)) {
        const memory = createNamsMemoryService(config, invocation, state);
        const reasoningStep = {
          conversationId: state.conversationId,
          reasoning: `Gemini invoked ${toolPayload.toolName} with the provided tool input.`,
          actionTaken: `Ran ${toolPayload.toolName}`,
          ...(toolPayload.outputSummary !== undefined ? { result: toolPayload.outputSummary } : {}),
        };
        const reasoningStepHash = stableJsonHash({
          sessionKey: state.sessionKey,
          ...reasoningStep,
        });
        let stepId: string | undefined = state.reasoningStepIdsByHash[reasoningStepHash];
        if (!state.seenReasoningStepHashes.includes(reasoningStepHash)) {
          stepId = await memory.recordReasoningStep(reasoningStep);
          state.seenReasoningStepHashes.push(reasoningStepHash);
          if (stepId !== undefined) {
            state.reasoningStepIdsByHash[reasoningStepHash] = stepId;
          }
        }
        await memory.recordToolCall({
          ...(stepId !== undefined ? { stepId } : {}),
          toolName: toolPayload.toolName,
          input: toolPayload.input,
          ...(toolPayload.output !== undefined ? { output: toolPayload.output } : {}),
        });
        markSeen(state.seenToolCallIds, toolCallKeys.markKeys);
      }
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      await saveSessionState(invocation.platform, state.sessionKey, state);
      return allowOutput();
    }

    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

}

function allowOutput(additionalContext?: string): HookResult {
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

function workspaceResultOutput(
  result: Exclude<WorkspaceResolutionResult, { status: "ready" }>,
  sessionId?: string,
): HookResult {
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

async function recordActiveGeminiWorkspaceSession(
  invocation: HookInvocation,
  state: SessionState,
  projectDirectory: string,
  sessionId?: string,
): Promise<void> {
  try {
    await recordActiveWorkspaceSession({
      platform: invocation.platform,
      sessionId,
      sessionKey: state.sessionKey,
      projectDirectory,
      statePath: sessionStatePath(invocation.platform, state.sessionKey, state.createdAt),
    });
  } catch {
    return;
  }
}

function isWorkspaceCommandResultPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith("NAMS workspace command result:");
}

interface GeminiAfterToolPayload {
  toolName?: string;
  input: unknown;
  output?: string;
  outputSummary?: string;
}

function parseGeminiAfterToolPayload(payload: Record<string, unknown>): GeminiAfterToolPayload {
  const toolResponse = firstRecord(payload.tool_response);
  const { toolName } = pickStringFields(payload, { toolName: "tool_name" });
  return {
    ...(toolName !== undefined ? { toolName } : {}),
    input: firstDefined(payload.tool_input) ?? {},
    ...optionalString(
      "output",
      firstString(toolResponse?.llmContent),
    ),
    ...optionalString(
      "outputSummary",
      firstString(toolResponse?.returnDisplay),
    ),
  };
}

function geminiToolCallDedupeKeys(
  sessionKey: string,
  toolName: string,
  input: unknown,
  geminiToolCallId?: string,
): { lookupKeys: string[]; markKeys: string[] } {
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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function optionalString<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value !== undefined ? ({ [key]: value } as { [P in K]: string }) : {};
}

type TraceState = {
  sessionKey: string;
  seenReasoningStepHashes: string[];
  seenToolCallIds: string[];
  reasoningStepIdsByHash: Record<string, string>;
};

async function storeAssistantMessagesFromTranscript(
  platform: string,
  conversationId: string,
  state: AssistantMessageState & { sessionKey: string; seenTranscriptEntryIds: string[] },
  memory: NamsMemoryService,
  entries: GeminiTranscriptEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.kind !== "assistant") {
      continue;
    }
    if (entry.id !== undefined && state.seenTranscriptEntryIds.includes(entry.id)) {
      continue;
    }

    const content = entry.content.trim();
    if (content !== "") {
      const responseHash = sha256([platform, state.sessionKey, "assistant", content].join("\n"));
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

async function recordTraceFromTranscript(
  conversationId: string,
  state: TraceState,
  memory: NamsMemoryService,
  entries: GeminiTranscriptEntry[],
): Promise<void> {
  let currentParentKey: string | undefined;
  let currentParentStepIds: string[] = [];

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

function addCurrentParentStepId(stepIds: string[], stepId: string | undefined): void {
  if (stepId !== undefined && !stepIds.includes(stepId)) {
    stepIds.push(stepId);
  }
}

function transcriptParentKey(
  entry: Extract<GeminiTranscriptEntry, { kind: "thought" | "toolCall" }>,
): string {
  return stableJsonHash({
    parentTranscriptEntryId: entry.parentTranscriptEntryId,
    parentTranscriptEntryIndex: entry.parentTranscriptEntryIndex,
  });
}

