import { readFile } from "node:fs/promises";
import { RuntimeEnvironment } from "./paths.js";

export interface NamsRuntimeConfig {
  apiKey: string;
  baseUrl?: string;
}

export type ConfigSource = "missing" | "global:~/.nams/config.json" | "project:.nams/config.json" | "env:NAMS_API_KEY";
export type BaseUrlSource =
  | "default"
  | "global:~/.nams/config.json"
  | "project:.nams/config.json"
  | "env:NAMS_BASE_URL";

export interface NamsConfigSources {
  apiKey: ConfigSource;
  baseUrl: BaseUrlSource;
}

export type NamsConfigLoadResult =
  | {
      ok: true;
      config: NamsRuntimeConfig;
      sources: NamsConfigSources;
    }
  | {
      ok: false;
      reason: "missing-api-key";
      sources: NamsConfigSources;
    }
  | {
      ok: false;
      reason: "invalid-json";
      errorSource: "global:~/.nams/config.json" | "project:.nams/config.json";
      sources: NamsConfigSources;
    };

export function configDiagnosticPayload(result: NamsConfigLoadResult): Record<string, unknown> {
  if (result.ok) {
    return {
      message: "NAMS config loaded",
      configSources: result.sources,
    };
  }
  if (result.reason === "invalid-json") {
    return {
      message: "NAMS config invalid",
      configSources: result.sources,
      errorSource: result.errorSource,
    };
  }
  return {
    message: "NAMS apiKey missing",
    configSources: result.sources,
  };
}

export async function loadNamsConfig(projectDirectory: string): Promise<NamsConfigLoadResult> {
  const runtimeEnvironment = RuntimeEnvironment.fromProcess();
  const accumulated: Partial<NamsRuntimeConfig> = {};
  const sources: NamsConfigSources = {
    apiKey: "missing",
    baseUrl: "default",
  };

  const globalResult = await readGlobalJsonConfig(runtimeEnvironment);
  if (!globalResult.ok) {
    return invalidJsonResult(globalResult.source);
  }
  applyJsonConfig(accumulated, sources, globalResult.config, "global:~/.nams/config.json");

  const projectResult = await readJsonConfig(
    runtimeEnvironment.projectConfigPath(projectDirectory),
    "project:.nams/config.json",
  );
  if (!projectResult.ok) {
    return invalidJsonResult(projectResult.source, sources);
  }
  applyJsonConfig(accumulated, sources, projectResult.config, "project:.nams/config.json");

  applyEnvironmentOverrides(accumulated, sources, runtimeEnvironment);

  if (accumulated.apiKey === undefined) {
    return {
      ok: false,
      reason: "missing-api-key",
      sources,
    };
  }

  return {
    ok: true,
    config: {
      apiKey: accumulated.apiKey,
      ...(accumulated.baseUrl !== undefined ? { baseUrl: accumulated.baseUrl } : {}),
    },
    sources,
  };
}

type JsonConfigSource = "global:~/.nams/config.json" | "project:.nams/config.json";

type JsonConfigReadResult =
  | {
      ok: true;
      config: JsonConfig;
    }
  | {
      ok: false;
      source: JsonConfigSource;
    };

interface JsonConfig {
  apiKey?: string;
  baseUrl?: string;
}

async function readJsonConfig(path: string, source: JsonConfigSource): Promise<JsonConfigReadResult> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: true, config: {} };
    }
    return { ok: false, source };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, source };
  }

  if (!isPlainObject(parsed)) {
    return { ok: true, config: {} };
  }

  return {
    ok: true,
    config: {
      ...(nonBlankString(parsed.apiKey) !== undefined ? { apiKey: nonBlankString(parsed.apiKey) } : {}),
      ...(nonBlankString(parsed.baseUrl) !== undefined ? { baseUrl: nonBlankString(parsed.baseUrl) } : {}),
    },
  };
}

async function readGlobalJsonConfig(runtimeEnvironment: RuntimeEnvironment): Promise<JsonConfigReadResult> {
  const configPath = runtimeEnvironment.globalConfigPath();
  if (configPath === undefined) {
    return { ok: true, config: {} };
  }
  return readJsonConfig(configPath, "global:~/.nams/config.json");
}

function invalidJsonResult(errorSource: JsonConfigSource, sources: NamsConfigSources = defaultSources()): NamsConfigLoadResult {
  return {
    ok: false,
    reason: "invalid-json",
    errorSource,
    sources,
  };
}

function defaultSources(): NamsConfigSources {
  return {
    apiKey: "missing",
    baseUrl: "default",
  };
}

function applyJsonConfig(
  accumulated: Partial<NamsRuntimeConfig>,
  sources: NamsConfigSources,
  config: JsonConfig,
  source: JsonConfigSource,
): void {
  if (config.apiKey !== undefined) {
    accumulated.apiKey = config.apiKey;
    sources.apiKey = source;
  }
  if (config.baseUrl !== undefined) {
    accumulated.baseUrl = config.baseUrl;
    sources.baseUrl = source;
  }
}

function applyEnvironmentOverrides(
  accumulated: Partial<NamsRuntimeConfig>,
  sources: NamsConfigSources,
  runtimeEnvironment: RuntimeEnvironment,
): void {
  const apiKey = runtimeEnvironment.value("NAMS_API_KEY");
  if (apiKey !== undefined) {
    accumulated.apiKey = apiKey;
    sources.apiKey = "env:NAMS_API_KEY";
  }

  const baseUrl = runtimeEnvironment.value("NAMS_BASE_URL");
  if (baseUrl !== undefined) {
    accumulated.baseUrl = baseUrl;
    sources.baseUrl = "env:NAMS_BASE_URL";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
