export const platforms = ["gemini", "claude", "codex", "opencode"] as const;
export type Platform = (typeof platforms)[number];

export const hookEvents = ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool"] as const;
export type HookEvent = (typeof hookEvents)[number];

export const workspaceHookEvents = [
  "BeforeAgent",
  "InstallConfigure",
  "UserPromptExpansion",
  "CommandExecuteBefore",
  "CustomCommand",
] as const;
export type WorkspaceHookEvent = (typeof workspaceHookEvents)[number];

export interface HookInvocation<E extends HookEvent = HookEvent> {
  platform: Platform;
  event: E;
  rawPayload: Record<string, unknown>;
  processCwd: string;
}

export interface HookResult {
  stdout: Record<string, unknown>;
}

export interface WorkspaceHookInvocation<E extends WorkspaceHookEvent = WorkspaceHookEvent> {
  platform: Platform;
  event: E;
  rawPayload: Record<string, unknown>;
  processCwd: string;
}

export type MemoryPlatformAdapter = {
  startSession: (invocation: HookInvocation<"SessionStart">) => Promise<HookResult>;
  beforeAgent?: (invocation: HookInvocation<"BeforeAgent">) => Promise<HookResult>;
  afterAgent?: (invocation: HookInvocation<"AfterAgent">) => Promise<HookResult>;
  afterTool?: (invocation: HookInvocation<"AfterTool">) => Promise<HookResult>;
};

export interface WorkspacePlatformAdapter {
  beforeAgent?(invocation: WorkspaceHookInvocation<"BeforeAgent">): Promise<HookResult>;
  installConfigure?(invocation: WorkspaceHookInvocation<"InstallConfigure">): Promise<HookResult>;
  userPromptExpansion?(invocation: WorkspaceHookInvocation<"UserPromptExpansion">): Promise<HookResult>;
  commandExecuteBefore?(invocation: WorkspaceHookInvocation<"CommandExecuteBefore">): Promise<HookResult>;
  customCommand?(invocation: WorkspaceHookInvocation<"CustomCommand">): Promise<HookResult>;
}

export function isPlatform(value: string | undefined): value is Platform {
  return value !== undefined && platforms.includes(value as Platform);
}

export function isHookEvent(value: string | undefined): value is HookEvent {
  return value !== undefined && hookEvents.includes(value as HookEvent);
}

export function isWorkspaceHookEvent(value: string | undefined): value is WorkspaceHookEvent {
  return value !== undefined && workspaceHookEvents.includes(value as WorkspaceHookEvent);
}
