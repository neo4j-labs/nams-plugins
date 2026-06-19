import { readFile } from "node:fs/promises";
import { ensurePrivateFileMode } from "./permissions.js";
import { envValue, globalConfigPath, projectConfigPath } from "./paths.js";
import { isPlainObject, nonBlankString } from "./util.js";
export function configDiagnosticPayload(result) {
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
    if (result.reason === "missing-workspace-id") {
        return {
            message: "NAMS workspaceId missing",
            configSources: result.sources,
        };
    }
    if (result.reason === "missing-base-url") {
        return {
            message: "NAMS baseUrl missing",
            configSources: result.sources,
        };
    }
    return {
        message: "NAMS apiKey missing",
        configSources: result.sources,
    };
}
export async function loadNamsConfig(projectDirectory, discoverConfig) {
    const connectionResult = await loadNamsConnectionConfig(projectDirectory, discoverConfig);
    if (!connectionResult.ok) {
        return connectionResult;
    }
    if (connectionResult.config.workspaceId === undefined) {
        return {
            ok: false,
            reason: "missing-workspace-id",
            sources: connectionResult.sources,
        };
    }
    return {
        ok: true,
        config: {
            apiKey: connectionResult.config.apiKey,
            workspaceId: connectionResult.config.workspaceId,
            baseUrl: connectionResult.config.baseUrl,
        },
        sources: connectionResult.sources,
    };
}
export async function loadNamsConnectionConfig(projectDirectory, discoverConfig) {
    const env = process.env;
    const accumulated = {};
    const sources = {
        apiKey: "missing",
        workspaceId: "missing",
        baseUrl: "missing",
    };
    const globalResult = await readGlobalJsonConfig(env);
    if (!globalResult.ok) {
        return invalidJsonResult(globalResult.source);
    }
    applyJsonConfig(accumulated, sources, globalResult.config, "global:~/.nams/config.json");
    const projectResult = await readJsonConfig(projectConfigPath(projectDirectory), "project:.nams/config.json");
    if (!projectResult.ok) {
        return invalidJsonResult(projectResult.source, sources);
    }
    applyJsonConfig(accumulated, sources, projectResult.config, "project:.nams/config.json");
    if (discoverConfig !== undefined) {
        applyDiscoveredConfig(accumulated, sources, await discoverConfig(env));
    }
    applyEnvironmentOverrides(accumulated, sources, env);
    if (accumulated.apiKey === undefined) {
        return {
            ok: false,
            reason: "missing-api-key",
            sources,
        };
    }
    if (accumulated.baseUrl === undefined) {
        return {
            ok: false,
            reason: "missing-base-url",
            sources,
        };
    }
    return {
        ok: true,
        config: {
            apiKey: accumulated.apiKey,
            ...(accumulated.workspaceId !== undefined ? { workspaceId: accumulated.workspaceId } : {}),
            baseUrl: accumulated.baseUrl,
        },
        ...(accumulated.workspaceId !== undefined ? { workspaceId: accumulated.workspaceId } : {}),
        sources,
    };
}
async function readJsonConfig(path, source) {
    let content;
    try {
        content = await readFile(path, "utf8");
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return { ok: true, config: {} };
        }
        return { ok: false, source };
    }
    try {
        await ensurePrivateFileMode(path);
    }
    catch {
        return { ok: false, source };
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return { ok: false, source };
    }
    if (!isPlainObject(parsed)) {
        return { ok: true, config: {} };
    }
    return {
        ok: true,
        config: {
            ...(nonBlankString(parsed.apiKey) !== undefined ? { apiKey: nonBlankString(parsed.apiKey) } : {}),
            ...(nonBlankString(parsed.workspaceId) !== undefined ? { workspaceId: nonBlankString(parsed.workspaceId) } : {}),
            ...(nonBlankString(parsed.baseUrl) !== undefined ? { baseUrl: nonBlankString(parsed.baseUrl) } : {}),
        },
    };
}
async function readGlobalJsonConfig(env) {
    const configPath = globalConfigPath(env);
    if (configPath === undefined) {
        return { ok: true, config: {} };
    }
    return readJsonConfig(configPath, "global:~/.nams/config.json");
}
function invalidJsonResult(errorSource, sources = { apiKey: "missing", workspaceId: "missing", baseUrl: "missing" }) {
    return {
        ok: false,
        reason: "invalid-json",
        errorSource,
        sources,
    };
}
function applyJsonConfig(accumulated, sources, config, source) {
    if (config.apiKey !== undefined) {
        accumulated.apiKey = config.apiKey;
        sources.apiKey = source;
    }
    if (config.workspaceId !== undefined) {
        accumulated.workspaceId = config.workspaceId;
        sources.workspaceId = source;
    }
    if (config.baseUrl !== undefined) {
        accumulated.baseUrl = config.baseUrl;
        sources.baseUrl = source;
    }
}
const CONFIG_FIELDS = [
    { key: "apiKey", env: "NAMS_API_KEY" },
    { key: "workspaceId", env: "NAMS_WORKSPACE_ID" },
    { key: "baseUrl", env: "NAMS_BASE_URL" },
];
function applyDiscoveredConfig(accumulated, sources, config) {
    for (const { key } of CONFIG_FIELDS) {
        const discovered = config[key];
        if (discovered === undefined)
            continue;
        const value = nonBlankString(discovered.value);
        if (value === undefined)
            continue;
        accumulated[key] = value;
        sources[key] = discovered.source;
    }
}
function applyEnvironmentOverrides(accumulated, sources, env) {
    for (const { key, env: envVar } of CONFIG_FIELDS) {
        const value = envValue(env, envVar);
        if (value === undefined)
            continue;
        accumulated[key] = value;
        sources[key] = `env:${envVar}`;
    }
}
