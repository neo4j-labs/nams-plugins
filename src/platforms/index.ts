import type { Platform, PlatformAdapter } from "../interfaces.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { GeminiAdapter } from "./gemini.js";

const adapters: Record<Platform, PlatformAdapter> = {
  gemini: new GeminiAdapter(),
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
};

export function getPlatformAdapter(platform: Platform): PlatformAdapter {
  return adapters[platform];
}
