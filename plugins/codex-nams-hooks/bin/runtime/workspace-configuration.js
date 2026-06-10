import { NamsWorkspaceClient } from "../generated/nams-client.js";
import { configDiagnosticPayload, loadNamsConnectionConfig } from "./config.js";
import { assertNamsJsonConfigInputsSafe, writeNamsJsonConfig, } from "./config-writer.js";
export async function configureWorkspaceSelection(invocation) {
    const configureInput = parseConfigureInput(invocation.rawPayload);
    if (configureInput === undefined) {
        return configureOutput(1, "NAMS workspace configure requires --scope project or --scope user.");
    }
    const projectDirectory = invocation.processCwd;
    const preflightResult = await preflightConfigurePaths(projectDirectory, configureInput.scope);
    if (preflightResult !== undefined) {
        return preflightResult;
    }
    const connectionResult = await loadNamsConnectionConfig(projectDirectory);
    if (!connectionResult.ok) {
        return configureOutput(1, String(configDiagnosticPayload(connectionResult).message));
    }
    const client = new NamsWorkspaceClient({
        apiKey: connectionResult.config.apiKey,
        baseUrl: connectionResult.config.baseUrl,
    });
    let workspaces;
    try {
        const response = await client.listMyWorkspaces();
        workspaces = validWorkspaces(response.workspaces);
    }
    catch {
        return configureOutput(2, "NAMS workspace request failed. Check NAMS_API_KEY and NAMS_BASE_URL, then try again.");
    }
    const selectedWorkspace = selectWorkspace(workspaces, configureInput.workspaceId);
    if (selectedWorkspace === undefined) {
        return configureOutput(2, workspaceSelectionFailureMessage(workspaces, configureInput.workspaceId));
    }
    const result = await writeNamsJsonConfig({
        projectDirectory,
        scope: configureInput.scope,
        workspaceId: selectedWorkspace.id,
    });
    return configureOutput(0, `NAMS workspace configured for ${invocation.platform}: ${selectedWorkspace.id}\nUpdated ${result.path}`);
}
async function preflightConfigurePaths(projectDirectory, scope) {
    try {
        await assertNamsJsonConfigInputsSafe(projectDirectory, scope);
        return undefined;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "NAMS config path is unavailable";
        return configureOutput(1, message);
    }
}
function parseConfigureInput(rawPayload) {
    const scope = rawPayload.scope;
    if (scope !== "project" && scope !== "user") {
        return undefined;
    }
    const workspaceId = rawPayload.workspaceId;
    return {
        scope,
        ...(typeof workspaceId === "string" && workspaceId.trim() !== "" ? { workspaceId } : {}),
    };
}
function selectWorkspace(workspaces, workspaceId) {
    if (workspaceId !== undefined) {
        return workspaces.find((workspace) => workspace.id === workspaceId);
    }
    return workspaces.length === 1 ? workspaces[0] : undefined;
}
function validWorkspaces(workspaces) {
    return (workspaces ?? []).filter((workspace) => {
        return typeof workspace.id === "string" && workspace.id.trim() !== "";
    });
}
function workspaceSelectionFailureMessage(workspaces, workspaceId) {
    if (workspaceId !== undefined) {
        return [
            `Requested NAMS workspace ID was not found: ${workspaceId}`,
            ...(workspaces.length > 0 ? ["Available workspaces:", ...workspaceChoices(workspaces)] : []),
        ].join("\n");
    }
    if (workspaces.length === 0) {
        return "No NAMS workspaces were returned. Check that your NAMS account has access to at least one workspace.";
    }
    return [
        "NAMS workspace selection required. Re-run with --workspace-id and one of these IDs:",
        ...workspaceChoices(workspaces),
    ].join("\n");
}
function workspaceChoices(workspaces) {
    return workspaces.map((workspace) => {
        const name = workspace.name?.trim() || "(unnamed workspace)";
        const role = workspace.role?.trim() || "unknown-role";
        const status = workspace.status?.trim() || "unknown-status";
        return `- ${name} (${role}, ${status}) - ${workspace.id}`;
    });
}
function configureOutput(exitCode, message) {
    return {
        stdout: {
            continue: exitCode === 0,
            suppressOutput: false,
            exitCode,
            message,
        },
    };
}
