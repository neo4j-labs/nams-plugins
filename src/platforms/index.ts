import type { Platform, PlatformAdapter } from "../interfaces.js";
import { ClaudeAdapter } from "./claude/index.js";
import { CodexAdapter } from "./codex/index.js";
import { GeminiAdapter } from "./gemini/index.js";
import { OpenCodeAdapter } from "./opencode/index.js";

const adapters: Record<Platform, PlatformAdapter> = {
  gemini: new GeminiAdapter(),
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  opencode: new OpenCodeAdapter(),
};

export function getPlatformAdapter(platform: Platform): PlatformAdapter {
  return adapters[platform];
}
