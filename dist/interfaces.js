export const platforms = ["gemini", "claude", "codex"];
export const hookEvents = ["SessionStart"];
export function isPlatform(value) {
    return value !== undefined && platforms.includes(value);
}
export function isHookEvent(value) {
    return value !== undefined && hookEvents.includes(value);
}
