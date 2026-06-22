import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { sha256 } from "../../runtime/hashing.js";
import {
  appendNamsFailureDiagnostic,
  appendRawPlatformLog,
} from "../../runtime/logging.js";
import {
  combineMemoryContexts,
  createNamsMemoryService,
} from "../../runtime/memory-service.js";
import {
  createInitialSessionState,
  loadSessionState,
  saveSessionState,
} from "../../runtime/session-state.js";
import {
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { parseAntigravityPayload } from "./payload.js";
import { readLatestAntigravityUserPrompt } from "./transcript.js";

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
  return logOnly(invocation);
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
