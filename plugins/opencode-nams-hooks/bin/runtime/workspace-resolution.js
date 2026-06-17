import { NamsWorkspaceClient } from "../generated/nams-client.js";
import { configDiagnosticPayload, loadNamsConnectionConfig, } from "./config.js";
import { appendNamsRequestLog, appendPlatformDiagnosticLog, appendWorkspaceDiagnostic, workspaceDiagnosticMessages, } from "./logging.js";
import { namsProvenanceHeaders } from "./provenance.js";
import { validWorkspaces } from "./workspace-configuration.js";
export async function loadEffectiveNamsConfigForMemory(invocation, state, projectDirectory, discoverConfig) {
    const result = await resolveWorkspaceForMemory({
        invocation,
        state,
        projectDirectory,
        discoverConfig,
    });
    return result.status === "ready" ? result.config : undefined;
}
export async function resolveWorkspaceForMemory(input) {
    const connectionResult = await loadNamsConnectionConfig(input.projectDirectory, input.discoverConfig);
    if (!connectionResult.ok) {
        await appendPlatformDiagnosticLog(input.invocation, input.state, configDiagnosticPayload(connectionResult));
        return { status: "skip-memory", reason: "unavailable" };
    }
    const config = connectionResult.config;
    const sessionWorkspace = input.state.workspace;
    if (sessionWorkspace?.source === "session-selection") {
        await appendWorkspaceDiagnostic(input.invocation, input.state, {
            message: workspaceDiagnosticMessages.loadedFromSessionState,
            workspace: {
                id: sessionWorkspace.id,
                source: sessionWorkspace.source,
            },
        });
        return {
            status: "ready",
            config: runtimeConfig(config.apiKey, sessionWorkspace.id, config.baseUrl),
        };
    }
    if (config.workspaceId !== undefined) {
        input.state.workspace = {
            id: config.workspaceId,
            source: "config",
            selectedAt: new Date().toISOString(),
        };
        await appendWorkspaceDiagnostic(input.invocation, input.state, {
            message: workspaceDiagnosticMessages.loadedFromConfig,
            configSources: connectionResult.sources,
        });
        return {
            status: "ready",
            config: runtimeConfig(config.apiKey, config.workspaceId, config.baseUrl),
        };
    }
    if (input.state.workspace !== undefined) {
        await appendWorkspaceDiagnostic(input.invocation, input.state, {
            message: workspaceDiagnosticMessages.loadedFromSessionState,
            workspace: {
                id: input.state.workspace.id,
                source: input.state.workspace.source,
            },
        });
        return {
            status: "ready",
            config: runtimeConfig(config.apiKey, input.state.workspace.id, config.baseUrl),
        };
    }
    const client = new NamsWorkspaceClient({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        defaultHeaders: namsProvenanceHeaders(input.invocation),
        onRequest: (event) => appendNamsRequestLog(input.invocation, input.state, event),
    });
    let workspaces;
    try {
        const response = await client.listMyWorkspaces();
        workspaces = validWorkspaces(response.workspaces);
    }
    catch {
        await appendWorkspaceDiagnostic(input.invocation, input.state, {
            message: workspaceDiagnosticMessages.requestFailed,
        });
        return { status: "skip-memory", reason: "unavailable" };
    }
    if (workspaces.length === 0) {
        await appendWorkspaceDiagnostic(input.invocation, input.state, {
            message: workspaceDiagnosticMessages.listEmpty,
        });
        return { status: "skip-memory", reason: "unavailable" };
    }
    if (workspaces.length === 1) {
        const workspace = workspaces[0];
        input.state.workspace = {
            id: workspace.id,
            source: "runtime-single-workspace",
            selectedAt: new Date().toISOString(),
        };
        await appendWorkspaceDiagnostic(input.invocation, input.state, {
            message: workspaceDiagnosticMessages.autoSelected,
            workspace: publicWorkspace(workspace),
        });
        return {
            status: "ready",
            config: runtimeConfig(config.apiKey, workspace.id, config.baseUrl),
        };
    }
    await appendWorkspaceDiagnostic(input.invocation, input.state, {
        message: workspaceDiagnosticMessages.selectionRequired,
        workspaces: workspaces.map(publicWorkspace),
    });
    return {
        status: "skip-memory",
        reason: "selection-required",
        workspaces: workspaces.map(publicWorkspace),
    };
}
function runtimeConfig(apiKey, workspaceId, baseUrl) {
    return {
        apiKey,
        workspaceId,
        baseUrl,
    };
}
function publicWorkspace(workspace) {
    return {
        id: workspace.id,
        name: workspace.name,
        role: workspace.role,
        status: workspace.status,
        dbMode: workspace.dbMode,
    };
}
