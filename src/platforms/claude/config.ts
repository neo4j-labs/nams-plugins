import type { DiscoveredNamsConfig, DiscoveredNamsConfigValue, PlatformConfigSource } from "../../runtime/config.js";
import { RuntimeEnvironment } from "../../runtime/paths.js";

export function discoverClaudeNamsConfig(runtimeEnvironment: RuntimeEnvironment): DiscoveredNamsConfig {
  return {
    ...discoveredEnvConfigValue(runtimeEnvironment, "apiKey", "CLAUDE_PLUGIN_OPTION_NAMS_API_KEY"),
    ...discoveredEnvConfigValue(runtimeEnvironment, "workspaceId", "CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID"),
    ...discoveredEnvConfigValue(runtimeEnvironment, "baseUrl", "CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL"),
  };
}

function discoveredEnvConfigValue(
  runtimeEnvironment: RuntimeEnvironment,
  key: keyof DiscoveredNamsConfig,
  envVar: string,
): Partial<DiscoveredNamsConfig> {
  const value = runtimeEnvironment.value(envVar);
  if (value === undefined) {
    return {};
  }
  return {
    [key]: {
      value,
      source: `platform:claude:${envVar}` satisfies PlatformConfigSource,
    } satisfies DiscoveredNamsConfigValue,
  };
}
