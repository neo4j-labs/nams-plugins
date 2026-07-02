import type { HookInvocation, HookResult } from "../interfaces.js";
import {
  hasSeenAny,
  hasSeenAssistantMessage,
  markSeen,
  markAssistantMessageSeen,
  type AssistantMessageState,
} from "./dedupe.js";
import { sha256 } from "./hashing.js";
import { appendNamsFailureDiagnostic, appendRawPlatformLog } from "./logging.js";
import {
  combineMemoryContexts,
  type NamsMemoryService,
  type ReasoningStepInput,
  type ToolCallInput,
} from "./memory-service.js";
import { createInitialSessionState, loadSessionState, saveSessionState, type SessionState } from "./session-state.js";

export interface HookPayloadIdentity {
  sessionId?: string;
  projectDirectory: string;
}

export interface AssistantMessageKeys {
  lookupHash: string;
  markHashes: string[];
}

export interface ToolCallDedupeKeys {
  lookupKeys: string[];
  markKeys: string[];
}

export interface ToolCallTraceState {
  seenToolCallIds: string[];
  seenReasoningStepHashes: string[];
  reasoningStepIdsByHash: Record<string, string>;
}

export async function loadHookSessionState(
  invocation: HookInvocation,
  payload: HookPayloadIdentity,
): Promise<SessionState> {
  const initialState = createInitialSessionState({
    platform: invocation.platform,
    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
    projectDirectory: payload.projectDirectory,
  });
  const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ?? initialState;
  await appendRawPlatformLog(invocation, state);
  return state;
}

export async function withHookSessionState(
  invocation: HookInvocation,
  payload: HookPayloadIdentity,
  run: (state: SessionState) => Promise<HookResult>,
): Promise<HookResult> {
  const state = await loadHookSessionState(invocation, payload);
  try {
    return await run(state);
  } finally {
    await saveSessionState(invocation.platform, state.sessionKey, state);
  }
}

export async function ensureConversation(
  memory: NamsMemoryService,
  invocation: HookInvocation,
  state: SessionState,
  projectDirectory: string,
): Promise<string> {
  if (state.conversationId === undefined) {
    state.conversationId = await memory.createConversation({
      harness: invocation.platform,
      projectDirectory,
    });
  }
  return state.conversationId;
}

export async function recallMemoryContextOnce(
  memory: NamsMemoryService,
  invocation: HookInvocation,
  state: SessionState,
  conversationId: string,
  prompt: string,
): Promise<string | undefined> {
  if (state.lastRecallAt !== undefined) {
    return undefined;
  }
  const recallContexts: string[] = [];
  try {
    recallContexts.push(await memory.recall(conversationId));
  } catch {
    await appendNamsFailureDiagnostic(invocation, state);
  }
  try {
    recallContexts.push(await memory.searchEntities(prompt));
  } catch {
    await appendNamsFailureDiagnostic(invocation, state);
  }
  state.lastRecallAt = new Date().toISOString();
  const recalledContext = combineMemoryContexts(recallContexts);
  return recalledContext.trim() === "" ? undefined : recalledContext;
}

export async function storeUserPromptOnce(
  memory: NamsMemoryService,
  invocation: HookInvocation,
  state: SessionState,
  conversationId: string,
  prompt: string,
): Promise<void> {
  const promptHash = sha256([invocation.platform, state.sessionKey, "user", prompt.trim()].join("\n"));
  if (state.lastUserMessageHash !== promptHash) {
    await memory.storeUserMessage(conversationId, prompt);
    state.lastUserMessageHash = promptHash;
  }
}

export function assistantContentHash(platform: string, sessionKey: string, content: string): string {
  return sha256([platform, sessionKey, "assistant", content].join("\n"));
}

export async function storeAssistantMessageOnce(
  memory: NamsMemoryService,
  state: AssistantMessageState,
  conversationId: string,
  content: string,
  keys: AssistantMessageKeys,
): Promise<void> {
  if (!hasSeenAssistantMessage(state, keys.lookupHash)) {
    await memory.storeAssistantMessage(conversationId, content);
  }
  markAssistantMessageSeen(state, keys.markHashes);
}

export async function recordToolCallOnce(
  memory: NamsMemoryService,
  state: ToolCallTraceState,
  keys: ToolCallDedupeKeys,
  reasoningStep: ReasoningStepInput,
  reasoningStepHash: string,
  toolCall: Omit<ToolCallInput, "stepId">,
): Promise<void> {
  if (hasSeenAny(state.seenToolCallIds, keys.lookupKeys)) {
    return;
  }
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
    ...toolCall,
  });
  markSeen(state.seenToolCallIds, keys.markKeys);
}
