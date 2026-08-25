import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { NamsWorkspaceClient } from "../generated/nams-client.js";
import { configDiagnosticPayload, loadNamsConnectionConfig } from "./config.js";
import { nonBlankString } from "./util.js";
import { assertNamsJsonConfigInputsSafe, writeNamsJsonConfig, } from "./config-writer.js";
import { sha256 } from "./hashing.js";
import { sessionStateDirectory } from "./paths.js";
import { ensurePrivateDirectory } from "./permissions.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "./session-state.js";
export async function configureWorkspaceSelection(invocation) {
    const configureInput = parseConfigureInput(invocation.rawPayload);
    if (configureInput === undefined) {
        return configureOutput(1, "NAMS workspace configure requires --scope project, --scope user, or --scope session.");
    }
    const projectDirectory = invocation.processCwd;
    if (configureInput.scope === "session") {
        return configureSessionWorkspaceSelection(invocation, configureInput, projectDirectory);
    }
    const preflightResult = await preflightConfigurePaths(projectDirectory, configureInput.scope);
    if (preflightResult !== undefined) {
        return preflightResult;
    }
    const connectionResult = await loadNamsConnectionConfig(projectDirectory);
    if (!connectionResult.ok) {
        return configureOutput(1, String(configDiagnosticPayload(connectionResult).message));
    }
    const workspaces = await listWorkspaces(connectionResult.config);
    if (workspaces === undefined) {
        return configureOutput(2, "NAMS workspace request failed. Check NAMS_API_KEY and NAMS_BASE_URL, then try again.");
    }
    const selection = selectWorkspace(workspaces, configureInput.workspace);
    if (selection.status !== "selected") {
        return configureOutput(2, workspaceSelectionFailureMessage(workspaces, selection));
    }
    const result = await writeNamsJsonConfig({
        projectDirectory,
        scope: configureInput.scope,
        workspaceId: selection.workspace.id,
    });
    return configureOutput(0, `NAMS workspace configured for ${invocation.platform}: ${selection.workspace.id}\nUpdated ${result.path}`);
}
async function configureSessionWorkspaceSelection(invocation, configureInput, projectDirectory) {
    if (configureInput.sessionId === undefined) {
        return configureOutput(1, "NAMS workspace configure --scope session requires --session-id.");
    }
    const initialState = createInitialSessionState({
        platform: invocation.platform,
        sessionId: configureInput.sessionId,
        projectDirectory,
    });
    const preflightResult = await preflightSessionStateDestination(invocation.platform, initialState.sessionKey);
    if (preflightResult !== undefined) {
        return preflightResult;
    }
    const configPreflightResult = await preflightConfigurePaths(projectDirectory, "project");
    if (configPreflightResult !== undefined) {
        return configPreflightResult;
    }
    const connectionResult = await loadNamsConnectionConfig(projectDirectory);
    if (!connectionResult.ok) {
        return configureOutput(1, String(configDiagnosticPayload(connectionResult).message));
    }
    const workspaces = await listWorkspaces(connectionResult.config);
    if (workspaces === undefined) {
        return configureOutput(2, "NAMS workspace request failed. Check NAMS_API_KEY and NAMS_BASE_URL, then try again.");
    }
    const selection = selectWorkspace(workspaces, configureInput.workspace);
    if (selection.status !== "selected") {
        return configureOutput(2, workspaceSelectionFailureMessage(workspaces, selection));
    }
    const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ?? initialState;
    state.workspace = {
        id: selection.workspace.id,
        source: "session-selection",
        selectedAt: new Date().toISOString(),
    };
    await saveSessionState(invocation.platform, state.sessionKey, state);
    return configureOutput(0, `NAMS workspace configured for ${invocation.platform} session ${configureInput.sessionId}: ${selection.workspace.id}`);
}
async function preflightSessionStateDestination(platform, sessionKey) {
    let stateDirectory;
    try {
        stateDirectory = sessionStateDirectory(platform);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "NAMS session state path is unavailable";
        return configureOutput(1, message);
    }
    try {
        await assertExistingSessionStateDirectoriesSafe(stateDirectory);
        await ensurePrivateDirectory(stateDirectory);
        await assertExistingSessionStateFilesSafe(stateDirectory, sessionKey);
        return undefined;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "NAMS session state path is unavailable";
        return configureOutput(1, message);
    }
}
async function assertExistingSessionStateDirectoriesSafe(stateDirectory) {
    for (const directoryPath of [
        path.dirname(path.dirname(stateDirectory)),
        path.dirname(stateDirectory),
        stateDirectory,
    ]) {
        try {
            const directory = await lstat(directoryPath);
            if (directory.isSymbolicLink()) {
                throw new Error("NAMS session state path must not contain symbolic links");
            }
            if (!directory.isDirectory()) {
                throw new Error("NAMS session state path is unavailable; existing path must be a directory.");
            }
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                continue;
            }
            throw error;
        }
    }
}
async function assertExistingSessionStateFilesSafe(stateDirectory, sessionKey) {
    const suffix = `--${sha256(sessionKey)}.json`;
    const filenames = await readdir(stateDirectory);
    for (const filename of filenames) {
        if (!filename.startsWith("session-") || !filename.endsWith(suffix)) {
            continue;
        }
        const stateFile = await lstat(path.join(stateDirectory, filename));
        if (stateFile.isSymbolicLink()) {
            throw new Error("NAMS session state file must not be a symbolic link");
        }
        if (!stateFile.isFile() || stateFile.nlink > 1) {
            throw new Error("NAMS session state path is unsafe; existing state must be a regular file without hard links");
        }
    }
}
async function listWorkspaces(connectionConfig) {
    const client = new NamsWorkspaceClient({
        apiKey: connectionConfig.apiKey,
        baseUrl: connectionConfig.baseUrl,
    });
    try {
        const response = await client.listMyWorkspaces();
        return validWorkspaces(response.workspaces);
    }
    catch {
        return undefined;
    }
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
    if (scope !== "project" && scope !== "user" && scope !== "session") {
        return undefined;
    }
    const workspace = nonBlankString(rawPayload.workspace);
    const sessionId = nonBlankString(rawPayload.sessionId);
    return {
        scope,
        ...(workspace !== undefined ? { workspace } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
    };
}
function selectWorkspace(workspaces, selector) {
    if (selector === undefined) {
        return workspaces.length === 1
            ? { status: "selected", workspace: workspaces[0] }
            : { status: "missing-selector" };
    }
    const idMatch = workspaces.find((workspace) => workspace.id === selector);
    if (idMatch !== undefined) {
        return { status: "selected", workspace: idMatch };
    }
    const nameMatches = workspaces.filter((workspace) => workspace.name?.trim() === selector);
    if (nameMatches.length === 1) {
        return { status: "selected", workspace: nameMatches[0] };
    }
    if (nameMatches.length > 1) {
        return { status: "ambiguous-name", selector, matches: nameMatches };
    }
    return { status: "not-found", selector };
}
export function validWorkspaces(workspaces) {
    return (workspaces ?? []).filter((workspace) => {
        return typeof workspace.id === "string" && workspace.id.trim() !== "";
    });
}
function workspaceSelectionFailureMessage(workspaces, selection) {
    if (workspaces.length === 0) {
        return "No NAMS workspaces were returned. Check that your NAMS account has access to at least one workspace.";
    }
    if (selection.status === "not-found") {
        return [
            `Requested NAMS workspace was not found: ${selection.selector}`,
            ...(workspaces.length > 0 ? ["Available workspaces:", ...workspaceChoices(workspaces)] : []),
        ].join("\n");
    }
    if (selection.status === "ambiguous-name") {
        return [
            `Requested NAMS workspace name is ambiguous: ${selection.selector}`,
            "Matching workspaces:",
            ...workspaceChoices(selection.matches),
        ].join("\n");
    }
    return [
        "NAMS workspace selection required. Re-run with --workspace and one of these workspaces:",
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
