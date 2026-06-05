import type { MemoryPlatformAdapter, Platform } from "../interfaces.js";
import { ClaudeAdapter } from "./claude/index.js";
import { CodexAdapter } from "./codex/index.js";
import { GeminiAdapter } from "./gemini/index.js";
import { OpenCodeAdapter } from "./opencode/index.js";

const memoryAdapters: Record<Platform, MemoryPlatformAdapter> = {
  gemini: new GeminiAdapter(),
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  opencode: new OpenCodeAdapter(),
};

export function getMemoryPlatformAdapter(platform: Platform): MemoryPlatformAdapter {
  return memoryAdapters[platform];
}
