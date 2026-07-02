import type { HookInvocation, HookResult } from "../interfaces.js";
import { sha256 } from "./hashing.js";
import { appendNamsFailureDiagnostic, appendRawPlatformLog } from "./logging.js";
import { combineMemoryContexts, type NamsMemoryService } from "./memory-service.js";
import { createInitialSessionState, loadSessionState, saveSessionState, type SessionState } from "./session-state.js";

export interface HookPayloadIdentity {
  sessionId?: string;
  projectDirectory: string;
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
