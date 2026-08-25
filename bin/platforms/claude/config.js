import { envValue } from "../../runtime/paths.js";
export function discoverClaudeNamsConfig(env) {
    return {
        ...discoveredEnvConfigValue(env, "apiKey", "CLAUDE_PLUGIN_OPTION_NAMS_API_KEY"),
        ...discoveredEnvConfigValue(env, "workspaceId", "CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID"),
        ...discoveredEnvConfigValue(env, "baseUrl", "CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL"),
    };
}
function discoveredEnvConfigValue(env, key, envVar) {
    const value = envValue(env, envVar);
    if (value === undefined) {
        return {};
    }
    return {
        [key]: {
            value,
            source: `platform:claude:${envVar}`,
        },
    };
}
