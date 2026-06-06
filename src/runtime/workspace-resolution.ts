import { NamsWorkspaceClient, type WorkspaceSummary } from "../generated/nams-client.js";
import type { HookInvocation, HookResult, Platform } from "../interfaces.js";
import {
  configDiagnosticPayload,
  loadNamsConnectionConfig,
  type NamsRuntimeConfig,
} from "./config.js";
import {
  appendNamsRequestLog,
  appendPlatformDiagnosticLog,
  appendWorkspaceDiagnostic,
  workspaceDiagnosticMessages,
} from "./logging.js";
import { namsProvenanceHeaders } from "./provenance.js";
import type { SessionState } from "./session-state.js";

export type WorkspaceInteraction = "gemini-blocking" | "single-only";

export type WorkspaceResolutionResult =
  | { status: "ready"; config: NamsRuntimeConfig }
  | { status: "skip-memory"; output: HookResult }
  | { status: "block"; output: HookResult };

export interface ResolveWorkspaceInput {
  invocation: HookInvocation;
  state: SessionState;
  projectDirectory: string;
  interaction: WorkspaceInteraction;
}

export async function loadEffectiveNamsConfigForMemory(
  invocation: HookInvocation,
  state: SessionState,
  projectDirectory: string,
): Promise<NamsRuntimeConfig | undefined> {
  const connectionResult = await loadNamsConnectionConfig(projectDirectory);
  await appendPlatformDiagnosticLog(invocation, state, configDiagnosticPayload(connectionResult));
  if (!connectionResult.ok) {
    return undefined;
  }

  const config = connectionResult.config;
  if (config.workspaceId !== undefined) {
    return runtimeConfig(config.apiKey, config.workspaceId, config.baseUrl);
  }

  if (state.workspace !== undefined) {
    return runtimeConfig(config.apiKey, state.workspace.id, config.baseUrl);
  }

  await appendPlatformDiagnosticLog(invocation, state, {
    message: "NAMS workspaceId missing",
    configSources: connectionResult.sources,
  });
  return undefined;
}

export async function resolveWorkspaceForMemory(input: ResolveWorkspaceInput): Promise<WorkspaceResolutionResult> {
  const connectionResult = await loadNamsConnectionConfig(input.projectDirectory);
  if (!connectionResult.ok) {
    await appendPlatformDiagnosticLog(input.invocation, input.state, configDiagnosticPayload(connectionResult));
    return { status: "skip-memory", output: allowOutput() };
  }

  const config = connectionResult.config;
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

  let workspaces: Array<WorkspaceSummary & { id: string }>;
  try {
    const response = await client.listMyWorkspaces();
    workspaces = validWorkspaces(response.workspaces);
  } catch {
    await appendWorkspaceDiagnostic(input.invocation, input.state, {
      message: workspaceDiagnosticMessages.requestFailed,
    });
    return { status: "skip-memory", output: allowOutput() };
  }

  if (workspaces.length === 0) {
    await appendWorkspaceDiagnostic(input.invocation, input.state, {
      message: workspaceDiagnosticMessages.listEmpty,
    });
    return { status: "skip-memory", output: allowOutput() };
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

  if (input.interaction === "gemini-blocking") {
    return {
      status: "block",
      output: workspaceSelectionRequiredOutput(input.invocation.platform, workspaces),
    };
  }
  return {
    status: "skip-memory",
    output: workspaceSelectionRequiredOutput(input.invocation.platform, workspaces),
  };
}

export function workspaceSelectionRequiredOutput(platform: Platform, workspaces: WorkspaceSummary[]): HookResult {
  if (platform === "gemini") {
    return {
      stdout: {
        decision: "deny",
        reason: workspaceSelectionReason(workspaces),
      },
    };
  }
  if (platform === "opencode") {
    return {
      stdout: {
        continue: true,
        suppressOutput: true,
        namsWorkspaceSelectionRequired: true,
        reason: workspaceSelectionReason(workspaces),
      },
    };
  }
  return allowOutput();
}

function runtimeConfig(apiKey: string, workspaceId: string, baseUrl: string): NamsRuntimeConfig {
  return {
    apiKey,
    workspaceId,
    baseUrl,
  };
}

function workspaceSelectionReason(workspaces: WorkspaceSummary[]): string {
  return [
    "NAMS workspace selection required. Configure one workspace before memory starts:",
    ...workspaces.map((workspace, index) => {
      const name = workspace.name?.trim() || "(unnamed workspace)";
      const role = workspace.role?.trim() || "unknown-role";
      const status = workspace.status?.trim() || "unknown-status";
      return `${index + 1}. ${name} (${role}, ${status}) - ${workspace.id}`;
    }),
  ].join("\n");
}

function validWorkspaces(workspaces: WorkspaceSummary[] | undefined): Array<WorkspaceSummary & { id: string }> {
  return (workspaces ?? []).filter((workspace): workspace is WorkspaceSummary & { id: string } => {
    return typeof workspace.id === "string" && workspace.id.trim() !== "";
  });
}

function publicWorkspace(workspace: WorkspaceSummary): Record<string, string | undefined> {
  return {
    id: workspace.id,
    name: workspace.name,
    role: workspace.role,
    status: workspace.status,
    dbMode: workspace.dbMode,
  };
}

function allowOutput(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}
