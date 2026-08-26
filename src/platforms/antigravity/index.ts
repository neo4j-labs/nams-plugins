import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { sha256 } from "../../runtime/hashing.js";
import {
  appendNamsFailureDiagnostic,
  appendPlatformDiagnosticLog,
} from "../../runtime/logging.js";
import {
  createNamsMemoryService,
  serializeToolInput,
  type NamsMemoryService,
} from "../../runtime/memory-service.js";
import {
  ensureConversation,
  recordToolCallOnce,
  recallMemoryContextOnce,
  storeAssistantMessageOnce,
  storeUserPromptOnce,
  withHookSessionState,
  type HookPayloadIdentity,
} from "../../runtime/memory-turn.js";
import { type SessionState } from "../../runtime/session-state.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
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
  return withHookSessionState(invocation, antigravityHookPayloadIdentity(payloadInfo), async (state) => {
    if (payloadInfo.transcriptPath === undefined) {
      return allowOutput();
    }

    const userPrompt = await readLatestAntigravityUserPrompt(payloadInfo.transcriptPath);
    if (userPrompt === undefined) {
      return allowOutput();
    }

    const workspaceResult = await resolveWorkspaceForMemory({
      invocation,
      state,
      projectDirectory: payloadInfo.projectDirectory,
    });
    if (workspaceResult.status !== "ready") {
      return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
    }

    let additionalContext: string | undefined;
    try {
      const memory = createNamsMemoryService(workspaceResult.config, invocation, state);
      const conversationId = await ensureConversation(memory, invocation, state, payloadInfo.projectDirectory);
      additionalContext = await recallMemoryContextOnce(memory, invocation, state, conversationId, userPrompt);
      await storeUserPromptOnce(memory, invocation, state, conversationId, userPrompt);
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      return allowOutput(additionalContext);
    }

    return allowOutput(additionalContext);
  });
}

async function afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
  const payloadInfo = parseAntigravityPayload(invocation.rawPayload, invocation.processCwd);
  return withHookSessionState(invocation, antigravityHookPayloadIdentity(payloadInfo), async (state) => {
    if (state.conversationId === undefined) {
      return allowOutput();
    }
    const conversationId = state.conversationId;

    if (payloadInfo.transcriptPath === undefined) {
      return allowOutput();
    }

    let entries: AntigravityTranscriptEntry[];
    try {
      entries = await readAntigravityTranscript(payloadInfo.transcriptPath);
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      return allowOutput();
    }

    if (!entries.some((entry) => entry.kind === "assistant")) {
      return allowOutput();
    }

    const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
    if (config === undefined) {
      return allowOutput();
    }

    try {
      const memory = createNamsMemoryService(config, invocation, state);
      await storeAssistantMessagesFromTranscript(invocation.platform, conversationId, state, memory, entries);
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      return allowOutput();
    }

    return allowOutput();
  });
}

async function afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
  const payloadInfo = parseAntigravityPayload(invocation.rawPayload, invocation.processCwd);
  return withHookSessionState(invocation, antigravityHookPayloadIdentity(payloadInfo), async (state) => {
    const conversationId = state.conversationId;
    if (conversationId === undefined) {
      return allowOutput();
    }

    if (payloadInfo.transcriptPath === undefined) {
      return allowOutput();
    }

    if (payloadInfo.stepIdx === undefined) {
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
      return allowOutput();
    }

    if (toolCall === undefined) {
      return allowOutput();
    }

    const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
    if (config === undefined) {
      return allowOutput();
    }

    const toolCallId = antigravityToolCallId(state.sessionKey, toolCall, payloadInfo.stepIdx);
    try {
      const memory = createNamsMemoryService(config, invocation, state);
      const reasoningStep = {
        conversationId,
        reasoning: `Antigravity ran ${toolCall.name} with the provided tool input.`,
        actionTaken: `Ran ${toolCall.name}`,
        ...(toolCall.output !== undefined ? { result: "Antigravity exposed post-tool output." } : {}),
      };
      await recordToolCallOnce(
        memory,
        state,
        { lookupKeys: [toolCallId], markKeys: [toolCallId] },
        reasoningStep,
        antigravityReasoningStepHash(state.sessionKey, toolCallId, toolCall.name),
        {
          toolName: toolCall.name,
          input: toolCall.input,
          ...(toolCall.output !== undefined ? { output: toolCall.output } : {}),
          ...(toolCall.status !== undefined ? { status: toolCall.status } : {}),
          ...(toolCall.durationMs !== undefined ? { durationMs: toolCall.durationMs } : {}),
        },
      );
    } catch {
      await appendNamsFailureDiagnostic(invocation, state);
      return allowOutput();
    }

    return allowOutput();
  });
}

async function logOnly(invocation: HookInvocation): Promise<HookResult> {
  const payloadInfo = parseAntigravityPayload(invocation.rawPayload, invocation.processCwd);
  return withHookSessionState(invocation, antigravityHookPayloadIdentity(payloadInfo), async () => ({ stdout: {} }));
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

function antigravityHookPayloadIdentity(payloadInfo: AntigravityPayloadInfo): HookPayloadIdentity {
  const sessionId = antigravitySessionId(payloadInfo);
  return {
    projectDirectory: payloadInfo.projectDirectory,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
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
      await storeAssistantMessageOnce(memory, state, conversationId, content, {
        lookupHash: responseHash,
        markHashes: [responseHash],
      });
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
