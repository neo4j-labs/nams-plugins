export function discoverClaudeNamsConfig(runtimeEnvironment) {
    return {
        ...discoveredEnvConfigValue(runtimeEnvironment, "apiKey", "CLAUDE_PLUGIN_OPTION_NAMS_API_KEY"),
        ...discoveredEnvConfigValue(runtimeEnvironment, "workspaceId", "CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID"),
        ...discoveredEnvConfigValue(runtimeEnvironment, "baseUrl", "CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL"),
    };
}
function discoveredEnvConfigValue(runtimeEnvironment, key, envVar) {
    const value = runtimeEnvironment.value(envVar);
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
