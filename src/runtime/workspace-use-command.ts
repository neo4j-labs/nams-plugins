import type { WorkspaceHookInvocation } from "../interfaces.js";
import { configureWorkspaceSelection } from "./workspace-configuration.js";

const workspaceCommandName = "nams:workspace";
const workspaceCommandUsage = "Usage: /nams:workspace use <workspace-id-or-name>";

export type WorkspaceUseCommandResult =
  | { status: "ignored" }
  | { status: "completed"; code: number; stdout: string; stderr: string };

export interface WorkspaceUseCommandInput {
  commandName?: string;
  arguments: unknown;
  sessionId?: string;
  invalidSubcommandMode: "ignore" | "usage";
  sessionLabel: string;
}

export async function runSessionWorkspaceUseCommand(
  invocation: WorkspaceHookInvocation,
  input: WorkspaceUseCommandInput,
): Promise<WorkspaceUseCommandResult> {
  if (input.commandName !== workspaceCommandName) {
    return { status: "ignored" };
  }

  const selectorResult = workspaceSelectorFromArguments(input.arguments);
  if (selectorResult.status === "invalid") {
    if (input.invalidSubcommandMode === "ignore") {
      return { status: "ignored" };
    }
    return commandFailure(workspaceCommandUsage);
  }
  if (selectorResult.selector === "") {
    return commandFailure(workspaceCommandUsage);
  }

  const sessionId = input.sessionId?.trim() ?? "";
  if (sessionId === "") {
    return commandFailure([
      `${input.sessionLabel} session id is unavailable; cannot configure a session workspace automatically.`,
      `Run manually: nams-hooks workspaces configure ${invocation.platform} --scope session --session-id <session-id> --workspace ${shellQuote(selectorResult.selector)}`,
    ].join("\n"));
  }

  const configureResult = await configureWorkspaceSelection({
    ...invocation,
    event: "InstallConfigure",
    rawPayload: {
      scope: "session",
      sessionId,
      workspace: selectorResult.selector,
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
