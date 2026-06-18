import type { MemoryPlatformAdapter, Platform, WorkspacePlatformAdapter } from "../interfaces.js";
import { ClaudeAdapter } from "./claude/index.js";
import { claudeWorkspaceAdapter } from "./claude/workspaces.js";
import { CodexAdapter } from "./codex/index.js";
import { codexWorkspaceAdapter } from "./codex/workspaces.js";
import { GeminiAdapter } from "./gemini/index.js";
import { geminiWorkspaceAdapter } from "./gemini/workspaces.js";
import { OpenCodeAdapter } from "./opencode/index.js";
import { opencodeWorkspaceAdapter } from "./opencode/workspaces.js";

const memoryAdapters: Record<Platform, MemoryPlatformAdapter> = {
  gemini: new GeminiAdapter(),
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  opencode: new OpenCodeAdapter(),
};

export function getMemoryPlatformAdapter(platform: Platform): MemoryPlatformAdapter {
  return memoryAdapters[platform];
}

const workspaceAdapters: Record<Platform, WorkspacePlatformAdapter> = {
  gemini: geminiWorkspaceAdapter,
  claude: claudeWorkspaceAdapter,
  codex: codexWorkspaceAdapter,
  opencode: opencodeWorkspaceAdapter,
};

export function getWorkspacePlatformAdapter(platform: Platform): WorkspacePlatformAdapter {
  return workspaceAdapters[platform];
}
