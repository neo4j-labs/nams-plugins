import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { sha256 } from "../../runtime/hashing.js";
import {
  appendNamsFailureDiagnostic,
  appendRawPlatformLog,
} from "../../runtime/logging.js";
import {
  combineMemoryContexts,
  createNamsMemoryService,
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
import { parseAntigravityPayload } from "./payload.js";
import {
  readAntigravityTranscript,
  readLatestAntigravityUserPrompt,
  type AntigravityTranscriptEntry,
} from "./transcript.js";

async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
  return logOnly(invocation);
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
  const payloadInfo = parseAntigravityPayload(invocation.rawPayload, invocation.processCwd);
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    projectDirectory: payloadInfo.projectDirectory,
    sessionId: payloadInfo.sessionId,
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
    sessionId: payloadInfo.sessionId,
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
  return logOnly(invocation);
}

async function logOnly(invocation: HookInvocation): Promise<HookResult> {
  const payloadInfo = parseAntigravityPayload(invocation.rawPayload, invocation.processCwd);
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    projectDirectory: payloadInfo.projectDirectory,
    sessionId: payloadInfo.sessionId,
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
