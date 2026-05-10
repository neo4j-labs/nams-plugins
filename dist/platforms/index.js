import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { GeminiAdapter } from "./gemini.js";
const adapters = {
    gemini: new GeminiAdapter(),
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
};
export function getPlatformAdapter(platform) {
    return adapters[platform];
}
