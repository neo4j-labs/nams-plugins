import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { sha256 } from "../../runtime/hashing.js";
import {
  appendNamsFailureDiagnostic,
  appendPlatformDiagnosticLog,
  appendRawPlatformLog,
} from "../../runtime/logging.js";
import {
  combineMemoryContexts,
  createNamsMemoryService,
  serializeToolInput,
  type NamsMemoryService,
} from "../../runtime/memory-service.js";
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
import { hasSeenAssistantMessage, markAssistantMessageSeen } from "../dedupe.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { parseAntigravityPayload, type AntigravityPayloadInfo } from "./payload.js";
import {
  readAntigravityTranscript,
  readLatestAntigravityToolCall,
  readLatestAntigravityUserPrompt,
  type AntigravityTranscriptEntry,
  type AntigravityToolTranscriptEntry,
} from "./transcript.js";

async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
  return logOnly(invocation);
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
  const payloadInfo = parseAntigravityPayload(invocation.rawPayload, invocation.processCwd);
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    projectDirectory: payloadInfo.projectDirectory,
    sessionId: antigravitySessionId(payloadInfo),
  });
  const state =
    (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
    initialState;

  await appendRawPlatformLog(invocation, state);

  if (payloadInfo.transcriptPath === undefined) {
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  const userPrompt = await readLatestAntigravityUserPrompt(payloadInfo.transcriptPath);
  if (userPrompt === undefined) {
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

  let additionalContext: string | undefined;
  try {
    const memory = createNamsMemoryService(workspaceResult.config, invocation, state);

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
        recallContexts.push(await memory.searchEntities(userPrompt));
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }
      state.lastRecallAt = new Date().toISOString();
      const recalledContext = combineMemoryContexts(recallContexts);
      if (recalledContext.trim() !== "") {
        additionalContext = recalledContext;
      }
    }

    const promptHash = sha256([invocation.platform, state.sessionKey, "user", userPrompt.trim()].join("\n"));
    if (state.lastUserMessageHash !== promptHash) {
      await memory.storeUserMessage(conversationId, userPrompt);
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

async function afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
  const payloadInfo = parseAntigravityPayload(invocation.rawPayload, invocation.processCwd);
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    projectDirectory: payloadInfo.projectDirectory,
    sessionId: antigravitySessionId(payloadInfo),
  });
  const state =
    (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
    initialState;

  await appendRawPlatformLog(invocation, state);
  state.seenAssistantMessageHashes ??= [];
  state.seenTranscriptEntryIds ??= [];

  if (state.conversationId === undefined) {
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }
  const conversationId = state.conversationId;

  if (payloadInfo.transcriptPath === undefined) {
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  let entries: AntigravityTranscriptEntry[];
  try {
    entries = await readAntigravityTranscript(payloadInfo.transcriptPath);
  } catch {
    await appendNamsFailureDiagnostic(invocation, state);
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  if (!entries.some((entry) => entry.kind === "assistant")) {
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
  if (config === undefined) {
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  try {
    const memory = createNamsMemoryService(config, invocation, state);
    await storeAssistantMessagesFromTranscript(invocation.platform, conversationId, state, memory, entries);
  } catch {
    await appendNamsFailureDiagnostic(invocation, state);
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  await saveSessionState(invocation.platform, state.sessionKey, state);
  return allowOutput();
}

async function afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
  const payloadInfo = parseAntigravityPayload(invocation.rawPayload, invocation.processCwd);
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    projectDirectory: payloadInfo.projectDirectory,
    sessionId: antigravitySessionId(payloadInfo),
  });
  const state =
    (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
    initialState;

  await appendRawPlatformLog(invocation, state);
  state.seenToolCallIds ??= [];
  state.seenReasoningStepHashes ??= [];
  state.reasoningStepIdsByHash ??= {};

  const conversationId = state.conversationId;
  if (conversationId === undefined) {
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  if (payloadInfo.transcriptPath === undefined) {
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  if (payloadInfo.stepIdx === undefined) {
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  let toolCall: AntigravityToolTranscriptEntry | undefined;
  try {
    toolCall = await readLatestAntigravityToolCall(payloadInfo.transcriptPath, payloadInfo.stepIdx);
  } catch (error) {
    await appendPlatformDiagnosticLog(invocation, state, {
      message:
        error instanceof SyntaxError
          ? "Antigravity transcript JSON malformed"
          : "Antigravity transcript read failed",
    });
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  if (toolCall === undefined) {
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  const toolCallId = antigravityToolCallId(state.sessionKey, toolCall, payloadInfo.stepIdx);
  if (state.seenToolCallIds.includes(toolCallId)) {
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
  if (config === undefined) {
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  const reasoningHash = antigravityReasoningStepHash(state.sessionKey, toolCallId, toolCall.name);
  try {
    const memory = createNamsMemoryService(config, invocation, state);
    let stepId: string | undefined = state.reasoningStepIdsByHash[reasoningHash];
    if (!state.seenReasoningStepHashes.includes(reasoningHash)) {
      stepId = await memory.recordReasoningStep({
        conversationId,
        reasoning: `Antigravity ran ${toolCall.name} with the provided tool input.`,
        actionTaken: `Ran ${toolCall.name}`,
        ...(toolCall.output !== undefined ? { result: "Antigravity exposed post-tool output." } : {}),
      });
      markReasoningStepSeen(state, reasoningHash, stepId);
    }

    await memory.recordToolCall({
      ...(stepId !== undefined ? { stepId } : {}),
      toolName: toolCall.name,
      input: toolCall.input,
      ...(toolCall.output !== undefined ? { output: toolCall.output } : {}),
      ...(toolCall.status !== undefined ? { status: toolCall.status } : {}),
      ...(toolCall.durationMs !== undefined ? { durationMs: toolCall.durationMs } : {}),
    });
    markToolCallSeen(state, toolCallId);
  } catch {
    await appendNamsFailureDiagnostic(invocation, state);
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return allowOutput();
  }

  await saveSessionState(invocation.platform, state.sessionKey, state);
  return allowOutput();
}

async function logOnly(invocation: HookInvocation): Promise<HookResult> {
  const payloadInfo = parseAntigravityPayload(invocation.rawPayload, invocation.processCwd);
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    projectDirectory: payloadInfo.projectDirectory,
    sessionId: antigravitySessionId(payloadInfo),
  });
  const state =
    (await loadSessionState(invocation.platform, initialState.sessionKey)) ??
    initialState;

  await appendRawPlatformLog(invocation, state);
  await saveSessionState(invocation.platform, state.sessionKey, state);

  return { stdout: {} };
}

export const antigravityMemoryAdapter: Required<MemoryPlatformAdapter> = {
  startSession,
  beforeAgent,
  afterAgent,
  afterTool,
};

function allowOutput(additionalContext?: string): HookResult {
  return {
    stdout:
      additionalContext !== undefined
        ? {
            injectSteps: [{ ephemeralMessage: additionalContext }],
          }
        : {},
  };
}

function antigravitySessionId(payloadInfo: AntigravityPayloadInfo): string | undefined {
  if (payloadInfo.sessionId !== undefined && payloadInfo.sessionId.trim() !== "") {
    return payloadInfo.sessionId;
  }
  if (payloadInfo.transcriptPath === undefined || payloadInfo.workspacePaths.length === 0) {
    return undefined;
  }
  return `antigravity-transcript-${sha256(
    JSON.stringify({
      transcriptPath: payloadInfo.transcriptPath,
      workspacePaths: payloadInfo.workspacePaths,
    }),
  )}`;
}

function workspaceResultOutput(
  result: Exclude<WorkspaceResolutionResult, { status: "ready" }>,
  sessionId?: string,
): HookResult {
  if (result.reason === "selection-required") {
    return allowOutput(formatWorkspaceSelectionNotice("antigravity", result.workspaces, sessionId));
  }
  return allowOutput();
}

async function storeAssistantMessagesFromTranscript(
  platform: string,
  conversationId: string,
  state: Pick<
    SessionState,
    "lastAssistantMessageHash" | "seenAssistantMessageHashes" | "seenTranscriptEntryIds" | "sessionKey"
  >,
  memory: NamsMemoryService,
  entries: AntigravityTranscriptEntry[],
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
      const responseHash = assistantTranscriptDedupeHash(platform, state.sessionKey, entry, content);
      if (!hasSeenAssistantMessage(state, responseHash)) {
        await memory.storeAssistantMessage(conversationId, content);
      }
      markAssistantMessageSeen(state, [responseHash]);
    }

    if (entry.id !== undefined && !state.seenTranscriptEntryIds.includes(entry.id)) {
      state.seenTranscriptEntryIds.push(entry.id);
    }
  }
}

function assistantTranscriptDedupeHash(
  platform: string,
  sessionKey: string,
  entry: Extract<AntigravityTranscriptEntry, { kind: "assistant" }>,
  content: string,
): string {
  if (entry.id !== undefined) {
    return sha256([platform, sessionKey, "assistant", "transcript-entry", entry.id].join("\n"));
  }
  return sha256([platform, sessionKey, "assistant", content].join("\n"));
}

type TraceState = Pick<
  SessionState,
  "seenReasoningStepHashes" | "seenToolCallIds" | "reasoningStepIdsByHash"
>;

function antigravityToolCallId(
  sessionKey: string,
  entry: AntigravityToolTranscriptEntry,
  payloadStepIdx?: number,
): string {
  if (entry.id !== undefined) {
    return `antigravity-transcript-tool-id:${sha256([sessionKey, entry.id].join("\n"))}`;
  }
  return `antigravity-transcript-tool-fallback:${sha256(
    [
      sessionKey,
      entry.name,
      serializeToolInput(entry.input),
      entry.stepIdx?.toString() ?? payloadStepIdx?.toString() ?? "",
      entry.timestamp ?? "",
    ].join("\n"),
  )}`;
}

function antigravityReasoningStepHash(sessionKey: string, toolCallId: string, toolName: string): string {
  return sha256([sessionKey, "antigravity-tool-reasoning-step", toolCallId, toolName].join("\n"));
}

function markReasoningStepSeen(state: TraceState, hash: string, stepId: string | undefined): void {
  if (!state.seenReasoningStepHashes.includes(hash)) {
    state.seenReasoningStepHashes.push(hash);
  }
  if (stepId !== undefined) {
    state.reasoningStepIdsByHash[hash] = stepId;
  }
}

function markToolCallSeen(state: TraceState, toolCallId: string): void {
  if (!state.seenToolCallIds.includes(toolCallId)) {
    state.seenToolCallIds.push(toolCallId);
  }
}
