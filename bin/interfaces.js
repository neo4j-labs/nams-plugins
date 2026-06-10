export const platforms = ["gemini", "claude", "codex", "opencode"];
export const hookEvents = ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool"];
export const workspaceHookEvents = ["BeforeAgent", "InstallConfigure"];
export function isPlatform(value) {
    return value !== undefined && platforms.includes(value);
}
export function isHookEvent(value) {
    return value !== undefined && hookEvents.includes(value);
}
export function isWorkspaceHookEvent(value) {
    return value !== undefined && workspaceHookEvents.includes(value);
}
