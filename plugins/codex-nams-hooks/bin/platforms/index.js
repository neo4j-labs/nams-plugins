import { ClaudeAdapter } from "./claude/index.js";
import { CodexAdapter } from "./codex/index.js";
import { GeminiAdapter } from "./gemini/index.js";
import { OpenCodeAdapter } from "./opencode/index.js";
const adapters = {
    gemini: new GeminiAdapter(),
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    opencode: new OpenCodeAdapter(),
};
export function getPlatformAdapter(platform) {
    return adapters[platform];
}
