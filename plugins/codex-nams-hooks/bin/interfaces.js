export const platforms = ["gemini", "claude", "codex", "opencode"];
export const hookEvents = ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool"];
export function isPlatform(value) {
    return value !== undefined && platforms.includes(value);
}
export function isHookEvent(value) {
    return value !== undefined && hookEvents.includes(value);
}
