import type { HookResult, WorkspaceHookInvocation, WorkspacePlatformAdapter } from "../interfaces.js";
import { configureWorkspaceSelection } from "../runtime/workspace-configuration.js";

type CustomCommandKey = keyof Pick<
  WorkspacePlatformAdapter,
  "userPromptExpansion" | "commandExecuteBefore" | "customCommand"
>;

type CustomCommandHandler<K extends CustomCommandKey> = K extends "userPromptExpansion"
  ? (invocation: WorkspaceHookInvocation<"UserPromptExpansion">) => Promise<HookResult>
  : K extends "commandExecuteBefore"
    ? (invocation: WorkspaceHookInvocation<"CommandExecuteBefore">) => Promise<HookResult>
    : (invocation: WorkspaceHookInvocation<"CustomCommand">) => Promise<HookResult>;

export function makeWorkspaceAdapter<K extends CustomCommandKey>(
  customCommandHook: K,
  customCommand: CustomCommandHandler<K>,
): WorkspacePlatformAdapter {
  return {
    installConfigure: configureWorkspaceSelection,
    [customCommandHook]: customCommand,
  } as WorkspacePlatformAdapter;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
