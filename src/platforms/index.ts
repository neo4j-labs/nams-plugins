import type { MemoryPlatformAdapter, Platform, WorkspacePlatformAdapter } from "../interfaces.js";
import { ClaudeAdapter } from "./claude/index.js";
import { ClaudeWorkspaceAdapter } from "./claude/workspaces.js";
import { CodexAdapter } from "./codex/index.js";
import { CodexWorkspaceAdapter } from "./codex/workspaces.js";
import { GeminiAdapter } from "./gemini/index.js";
import { GeminiWorkspaceAdapter } from "./gemini/workspaces.js";
import { OpenCodeAdapter } from "./opencode/index.js";
import { OpenCodeWorkspaceAdapter } from "./opencode/workspaces.js";

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
  gemini: new GeminiWorkspaceAdapter(),
  claude: new ClaudeWorkspaceAdapter(),
  codex: new CodexWorkspaceAdapter(),
  opencode: new OpenCodeWorkspaceAdapter(),
};

export function getWorkspacePlatformAdapter(platform: Platform): WorkspacePlatformAdapter {
  return workspaceAdapters[platform];
}
