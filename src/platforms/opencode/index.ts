import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import { appendPlatformLog } from "../../runtime/logging.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "../../runtime/session-state.js";

export class OpenCodeAdapter implements PlatformAdapter {
  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const projectDirectory = resolveOpencodeProjectDirectory(invocation);
    const initialState = createInitialSessionState({
      platform: invocation.platform,
      projectDirectory,
      sessionId: resolveOpencodeSessionId(invocation.rawPayload),
    });
    const state = (await loadSessionState(projectDirectory, invocation.platform, initialState.sessionKey)) ?? initialState;

    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory,
      sessionCreatedAt: state.createdAt,
      sessionKey: state.sessionKey,
    });
    await saveSessionState(projectDirectory, invocation.platform, state.sessionKey, state);

    return allowOutput();
  }

  async beforeAgent(_invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    return allowOutput();
  }

  async afterAgent(_invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    return allowOutput();
  }

  async afterTool(_invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    return allowOutput();
  }
}

function resolveOpencodeProjectDirectory(invocation: HookInvocation<"SessionStart">): string {
  const cwd = invocation.rawPayload.cwd;
  if (typeof cwd === "string" && cwd.trim() !== "") {
    return cwd;
  }

  const directory = invocation.rawPayload.directory;
  return typeof directory === "string" && directory.trim() !== "" ? directory : invocation.processCwd;
}

function resolveOpencodeSessionId(payload: Record<string, unknown>): string | undefined {
  const input = asRecord(payload.input);
  const event = asRecord(payload.event);
  const properties = asRecord(event?.properties);
  const info = asRecord(properties?.info);

  return firstString(input?.sessionID, input?.sessionId, properties?.sessionID, info?.id);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function allowOutput(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}
