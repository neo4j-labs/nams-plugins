import type { WorkspaceHookInvocation } from "../interfaces.js";
import { resolveActiveWorkspaceSession } from "./active-workspace-session.js";
import { configureWorkspaceSelection } from "./workspace-configuration.js";

const workspaceCommandName = "nams:workspace";
const claudeMarketplaceWorkspaceCommandName = `nams-hooks:${workspaceCommandName}`;
export const slashWorkspaceCommandUsage = "Usage: /nams:workspace use <workspace-id-or-name>";
export const codexWorkspaceCommandUsage = "Usage: $nams:workspace use <workspace-id-or-name>";

export type WorkspaceUseCommandResult =
  | { status: "ignored" }
  | { status: "completed"; code: number; stdout: string; stderr: string };

export interface WorkspaceUseCommandInput {
  commandName?: string;
  arguments: unknown;
  sessionId?: string;
  invalidSubcommandMode: "ignore" | "usage";
  sessionLabel: string;
  usage: string;
}

export interface ActiveSessionWorkspaceUseCommandInput {
  commandName?: string;
  arguments: unknown;
  projectDirectory: string;
  sessionLabel: string;
  usage: string;
}

export async function runSessionWorkspaceUseCommand(
  invocation: WorkspaceHookInvocation,
  input: WorkspaceUseCommandInput,
): Promise<WorkspaceUseCommandResult> {
  const parsedCommand = parseWorkspaceUseCommand(input.commandName, input.arguments);
  if (parsedCommand.status === "ignored") {
    return parsedCommand;
  }
  if (parsedCommand.status === "invalid") {
    if (input.invalidSubcommandMode === "ignore") {
      return { status: "ignored" };
    }
    return commandFailure(input.usage);
  }
  if (parsedCommand.selector === "") {
    return commandFailure(input.usage);
  }

  const sessionId = input.sessionId?.trim() ?? "";
  if (sessionId === "") {
    return commandFailure([
      `${input.sessionLabel} session id is unavailable; cannot configure a session workspace automatically.`,
      manualConfigureCommand(invocation.platform, parsedCommand.selector),
    ].join("\n"));
  }

  return configureSessionWorkspace(invocation, sessionId, parsedCommand.selector, invocation.processCwd);
}

export async function runActiveSessionWorkspaceUseCommand(
  invocation: WorkspaceHookInvocation,
  input: ActiveSessionWorkspaceUseCommandInput,
): Promise<WorkspaceUseCommandResult> {
  const parsedCommand = parseWorkspaceUseCommand(input.commandName, input.arguments);
  if (parsedCommand.status === "ignored") {
    return parsedCommand;
  }
  if (parsedCommand.status === "invalid" || parsedCommand.selector === "") {
    return commandFailure(input.usage);
  }

  const activeSession = await resolveActiveWorkspaceSession({
    platform: invocation.platform,
    projectDirectory: input.projectDirectory,
  });
  if (activeSession.status === "missing") {
    return commandFailure([
      `${input.sessionLabel} session id is unavailable; no recent active NAMS workspace session matched this project.`,
      manualConfigureCommand(invocation.platform, parsedCommand.selector),
    ].join("\n"));
  }
  if (activeSession.status === "ambiguous") {
    return commandFailure([
      `${input.sessionLabel} session id is unavailable; multiple recent active NAMS workspace sessions matched this project.`,
      manualConfigureCommand(invocation.platform, parsedCommand.selector),
    ].join("\n"));
  }

  return configureSessionWorkspace(invocation, activeSession.sessionId, parsedCommand.selector, input.projectDirectory);
}

async function configureSessionWorkspace(
  invocation: WorkspaceHookInvocation,
  sessionId: string,
  selector: string,
  projectDirectory: string,
): Promise<WorkspaceUseCommandResult> {
  const configureResult = await configureWorkspaceSelection({
    ...invocation,
    event: "InstallConfigure",
    processCwd: projectDirectory,
    rawPayload: {
      scope: "session",
      sessionId,
      workspace: selector,
    },
  });
  const code = typeof configureResult.stdout.exitCode === "number" ? configureResult.stdout.exitCode : 0;
  const message = typeof configureResult.stdout.message === "string"
    ? configureResult.stdout.message
    : JSON.stringify(configureResult.stdout);

  return {
    status: "completed",
    code,
    stdout: code === 0 ? message : "",
    stderr: code === 0 ? "" : message,
  };
}

function parseWorkspaceUseCommand(
  commandName: string | undefined,
  argumentValue: unknown,
): { status: "ignored" } | { status: "ok"; selector: string } | { status: "invalid" } {
  if (!isWorkspaceCommandName(commandName)) {
    return { status: "ignored" };
  }
  return workspaceSelectorFromArguments(argumentValue);
}

function isWorkspaceCommandName(commandName: string | undefined): boolean {
  const normalized = commandName?.trim();
  return normalized === workspaceCommandName || normalized === claudeMarketplaceWorkspaceCommandName;
}

function workspaceSelectorFromArguments(argumentValue: unknown): { status: "ok"; selector: string } | { status: "invalid" } {
  if (Array.isArray(argumentValue)) {
    const parts = argumentValue.map((part) => String(part).trim());
    if (parts[0] !== "use") {
      return { status: "invalid" };
    }
    return {
      status: "ok",
      selector: argumentValue
        .slice(1)
        .map((part) => String(part))
        .join(" ")
        .trim(),
    };
  }
  if (typeof argumentValue === "string") {
    const match = argumentValue.match(/^\s*use(?:\s+([\s\S]*?))?\s*$/);
    if (match === null) {
      return { status: "invalid" };
    }
    return { status: "ok", selector: match[1]?.trim() ?? "" };
  }
  return { status: "invalid" };
}

function commandFailure(stderr: string): WorkspaceUseCommandResult {
  return {
    status: "completed",
    code: 1,
    stdout: "",
    stderr,
  };
}

function manualConfigureCommand(platform: WorkspaceHookInvocation["platform"], selector: string): string {
  return [
    "Run manually: nams-hooks workspaces configure",
    platform,
    "--scope session --session-id <session-id> --workspace",
    shellQuote(selector),
  ].join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
