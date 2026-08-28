import { claudeMemoryAdapter } from "./claude/index.js";
import { claudeWorkspaceAdapter } from "./claude/workspaces.js";
import { codexMemoryAdapter } from "./codex/index.js";
import { codexWorkspaceAdapter } from "./codex/workspaces.js";
import { geminiMemoryAdapter } from "./gemini/index.js";
import { geminiWorkspaceAdapter } from "./gemini/workspaces.js";
import { opencodeMemoryAdapter } from "./opencode/index.js";
import { opencodeWorkspaceAdapter } from "./opencode/workspaces.js";
const memoryAdapters = {
    gemini: geminiMemoryAdapter,
    claude: claudeMemoryAdapter,
    codex: codexMemoryAdapter,
    opencode: opencodeMemoryAdapter,
};
export function getMemoryPlatformAdapter(platform) {
    return memoryAdapters[platform];
}
const workspaceAdapters = {
    gemini: geminiWorkspaceAdapter,
    claude: claudeWorkspaceAdapter,
    codex: codexWorkspaceAdapter,
    opencode: opencodeWorkspaceAdapter,
};
export function getWorkspacePlatformAdapter(platform) {
    return workspaceAdapters[platform];
}
