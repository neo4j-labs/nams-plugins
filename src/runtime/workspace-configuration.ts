import { NamsWorkspaceClient, type WorkspaceSummary } from "../generated/nams-client.js";
import type { WorkspaceHookInvocation, WorkspaceHookResult } from "../interfaces.js";
import { configDiagnosticPayload, loadNamsConnectionConfig } from "./config.js";
import { writeNamsJsonConfig, type NamsConfigWriteScope } from "./config-writer.js";

interface ConfigureInput {
  scope: NamsConfigWriteScope;
  workspaceId?: string;
}

export async function configureWorkspaceSelection(
  invocation: WorkspaceHookInvocation<"InstallConfigure">,
): Promise<WorkspaceHookResult> {
  const configureInput = parseConfigureInput(invocation.rawPayload);
  if (configureInput === undefined) {
    return configureOutput(1, "NAMS workspace configure requires --scope project or --scope user.");
  }

  const projectDirectory = invocation.processCwd;
  const connectionResult = await loadNamsConnectionConfig(projectDirectory);
  if (!connectionResult.ok) {
    return configureOutput(1, String(configDiagnosticPayload(connectionResult).message));
  }

  const client = new NamsWorkspaceClient({
    apiKey: connectionResult.config.apiKey,
    ...(connectionResult.config.baseUrl !== undefined ? { baseUrl: connectionResult.config.baseUrl } : {}),
  });

  let workspaces: Array<WorkspaceSummary & { id: string }>;
  try {
    const response = await client.listMyWorkspaces();
    workspaces = validWorkspaces(response.workspaces);
  } catch {
    return configureOutput(
      2,
      "NAMS workspace request failed. Check NAMS_API_KEY and NAMS_BASE_URL, then try again.",
    );
  }

  const selectedWorkspace = selectWorkspace(workspaces, configureInput.workspaceId);
  if (selectedWorkspace === undefined) {
    return configureOutput(2, workspaceSelectionMessage(workspaces));
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

function parseConfigureInput(rawPayload: Record<string, unknown>): ConfigureInput | undefined {
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

function selectWorkspace(
  workspaces: Array<WorkspaceSummary & { id: string }>,
  workspaceId: string | undefined,
): (WorkspaceSummary & { id: string }) | undefined {
  if (workspaceId !== undefined) {
    return workspaces.find((workspace) => workspace.id === workspaceId);
  }
  return workspaces.length === 1 ? workspaces[0] : undefined;
}

function validWorkspaces(workspaces: WorkspaceSummary[] | undefined): Array<WorkspaceSummary & { id: string }> {
  return (workspaces ?? []).filter((workspace): workspace is WorkspaceSummary & { id: string } => {
    return typeof workspace.id === "string" && workspace.id.trim() !== "";
  });
}

function workspaceSelectionMessage(workspaces: Array<WorkspaceSummary & { id: string }>): string {
  return [
    "NAMS workspace selection required. Re-run with --workspace-id and one of these IDs:",
    ...workspaces.map((workspace) => {
      const name = workspace.name?.trim() || "(unnamed workspace)";
      const role = workspace.role?.trim() || "unknown-role";
      const status = workspace.status?.trim() || "unknown-status";
      return `- ${name} (${role}, ${status}) - ${workspace.id}`;
    }),
  ].join("\n");
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
