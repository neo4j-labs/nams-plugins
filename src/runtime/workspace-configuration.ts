import { lstat } from "node:fs/promises";
import { NamsWorkspaceClient, type WorkspaceSummary } from "../generated/nams-client.js";
import type { WorkspaceHookInvocation, WorkspaceHookResult } from "../interfaces.js";
import { configDiagnosticPayload, loadNamsConnectionConfig } from "./config.js";
import {
  assertNamsJsonConfigInputsSafe,
  writeNamsJsonConfig,
  type NamsConfigWriteScope,
} from "./config-writer.js";
import { sessionStateDirectory } from "./paths.js";
import { createInitialSessionState, loadSessionState, saveSessionState } from "./session-state.js";

interface ConfigureInput {
  scope: NamsConfigWriteScope | "session";
  workspaceId?: string;
  workspace?: string;
  sessionId?: string;
}

type ValidWorkspace = WorkspaceSummary & { id: string };

type SessionWorkspaceSelectionResult =
  | { status: "selected"; workspace: ValidWorkspace }
  | { status: "not-found"; selector: string }
  | { status: "ambiguous-name"; selector: string; matches: ValidWorkspace[] }
  | { status: "missing-selector" };

export async function configureWorkspaceSelection(
  invocation: WorkspaceHookInvocation<"InstallConfigure">,
): Promise<WorkspaceHookResult> {
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
    return configureOutput(
      2,
      "NAMS workspace request failed. Check NAMS_API_KEY and NAMS_BASE_URL, then try again.",
    );
  }

  const selectedWorkspace = selectConfigWorkspace(workspaces, configureInput.workspaceId);
  if (selectedWorkspace === undefined) {
    return configureOutput(2, configWorkspaceSelectionFailureMessage(workspaces, configureInput.workspaceId));
  }

  const result = await writeNamsJsonConfig({
    projectDirectory,
    scope: configureInput.scope,
    workspaceId: selectedWorkspace.id,
  });

  return configureOutput(
    0,
    `NAMS workspace configured for ${invocation.platform}: ${selectedWorkspace.id}\nUpdated ${result.path}`,
  );
}

async function configureSessionWorkspaceSelection(
  invocation: WorkspaceHookInvocation<"InstallConfigure">,
  configureInput: ConfigureInput,
  projectDirectory: string,
): Promise<WorkspaceHookResult> {
  if (configureInput.sessionId === undefined) {
    return configureOutput(1, "NAMS workspace configure --scope session requires --session-id.");
  }

  const preflightResult = await preflightSessionStateDestination(invocation.platform);
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
    return configureOutput(
      2,
      "NAMS workspace request failed. Check NAMS_API_KEY and NAMS_BASE_URL, then try again.",
    );
  }

  const selection = selectSessionWorkspace(workspaces, configureInput.workspace ?? configureInput.workspaceId);
  if (selection.status !== "selected") {
    return configureOutput(2, sessionWorkspaceSelectionFailureMessage(workspaces, selection));
  }

  const initialState = createInitialSessionState({
    platform: invocation.platform,
    sessionId: configureInput.sessionId,
    projectDirectory,
  });
  const state = (await loadSessionState(invocation.platform, initialState.sessionKey)) ?? initialState;
  state.workspace = {
    id: selection.workspace.id,
    source: "session-selection",
    selectedAt: new Date().toISOString(),
  };
  await saveSessionState(invocation.platform, state.sessionKey, state);

  return configureOutput(
    0,
    `NAMS workspace configured for ${invocation.platform} session ${configureInput.sessionId}: ${selection.workspace.id}`,
  );
}

async function preflightSessionStateDestination(
  platform: WorkspaceHookInvocation<"InstallConfigure">["platform"],
): Promise<WorkspaceHookResult | undefined> {
  let stateDirectory: string;
  try {
    stateDirectory = sessionStateDirectory(platform);
  } catch (error) {
    const message = error instanceof Error ? error.message : "NAMS session state path is unavailable";
    return configureOutput(1, message);
  }

  try {
    const stateDirectoryStat = await lstat(stateDirectory);
    if (!stateDirectoryStat.isDirectory()) {
      return configureOutput(1, "NAMS session state path is unavailable; existing path must be a directory.");
    }
    return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    const message = error instanceof Error ? error.message : "NAMS session state path is unavailable";
    return configureOutput(1, message);
  }
}

async function listWorkspaces(
  connectionConfig: { apiKey: string; baseUrl: string },
): Promise<ValidWorkspace[] | undefined> {
  const client = new NamsWorkspaceClient({
    apiKey: connectionConfig.apiKey,
    baseUrl: connectionConfig.baseUrl,
  });

  try {
    const response = await client.listMyWorkspaces();
    return validWorkspaces(response.workspaces);
  } catch {
    return undefined;
  }
}

async function preflightConfigurePaths(
  projectDirectory: string,
  scope: NamsConfigWriteScope,
): Promise<WorkspaceHookResult | undefined> {
  try {
    await assertNamsJsonConfigInputsSafe(projectDirectory, scope);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : "NAMS config path is unavailable";
    return configureOutput(1, message);
  }
}

function parseConfigureInput(rawPayload: Record<string, unknown>): ConfigureInput | undefined {
  const scope = rawPayload.scope;
  if (scope !== "project" && scope !== "user" && scope !== "session") {
    return undefined;
  }

  const workspaceId = optionalString(rawPayload.workspaceId);
  const workspace = optionalString(rawPayload.workspace);
  const sessionId = optionalString(rawPayload.sessionId);
  return {
    scope,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

function selectConfigWorkspace(
  workspaces: ValidWorkspace[],
  workspaceId: string | undefined,
): ValidWorkspace | undefined {
  if (workspaceId !== undefined) {
    return workspaces.find((workspace) => workspace.id === workspaceId);
  }
  return workspaces.length === 1 ? workspaces[0] : undefined;
}

function selectSessionWorkspace(
  workspaces: ValidWorkspace[],
  selector: string | undefined,
): SessionWorkspaceSelectionResult {
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

function validWorkspaces(workspaces: WorkspaceSummary[] | undefined): ValidWorkspace[] {
  return (workspaces ?? []).filter((workspace): workspace is WorkspaceSummary & { id: string } => {
    return typeof workspace.id === "string" && workspace.id.trim() !== "";
  });
}

function configWorkspaceSelectionFailureMessage(
  workspaces: ValidWorkspace[],
  workspaceId: string | undefined,
): string {
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

function sessionWorkspaceSelectionFailureMessage(
  workspaces: ValidWorkspace[],
  selection: Exclude<SessionWorkspaceSelectionResult, { status: "selected" }>,
): string {
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

  if (workspaces.length === 0) {
    return "No NAMS workspaces were returned. Check that your NAMS account has access to at least one workspace.";
  }

  return [
    "NAMS workspace selection required. Re-run with --workspace or --workspace-id and one of these workspaces:",
    ...workspaceChoices(workspaces),
  ].join("\n");
}

function workspaceChoices(workspaces: ValidWorkspace[]): string[] {
  return workspaces.map((workspace) => {
    const name = workspace.name?.trim() || "(unnamed workspace)";
    const role = workspace.role?.trim() || "unknown-role";
    const status = workspace.status?.trim() || "unknown-status";
    return `- ${name} (${role}, ${status}) - ${workspace.id}`;
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function configureOutput(exitCode: number, message: string): WorkspaceHookResult {
  return {
    stdout: {
      continue: exitCode === 0,
      suppressOutput: false,
      exitCode,
      message,
    },
  };
}
