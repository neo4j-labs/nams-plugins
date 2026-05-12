export const platforms = ["gemini", "claude", "codex"] as const;
export type Platform = (typeof platforms)[number];

export const hookEvents = ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool"] as const;
export type HookEvent = (typeof hookEvents)[number];

export interface HookInvocation<E extends HookEvent = HookEvent> {
  platform: Platform;
  event: E;
  rawPayload: Record<string, unknown>;
  processCwd: string;
}

export interface HookResult {
  stdout: Record<string, unknown>;
}

export interface PlatformAdapter {
  startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult>;
  beforeAgent?(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult>;
  afterAgent?(invocation: HookInvocation<"AfterAgent">): Promise<HookResult>;
  afterTool?(invocation: HookInvocation<"AfterTool">): Promise<HookResult>;
}

export function isPlatform(value: string | undefined): value is Platform {
  return value !== undefined && platforms.includes(value as Platform);
}

export function isHookEvent(value: string | undefined): value is HookEvent {
  return value !== undefined && hookEvents.includes(value as HookEvent);
}
