#!/usr/bin/env node

import process from "node:process";
import {
  isHookEvent,
  isPlatform,
  isWorkspaceHookEvent,
  type HookEvent,
  type HookInvocation,
  type HookResult,
  type MemoryPlatformAdapter,
  type Platform,
  type WorkspaceHookEvent,
  type WorkspaceHookInvocation,
  type WorkspaceHookResult,
  type WorkspacePlatformAdapter,
} from "./interfaces.js";
import { getMemoryPlatformAdapter, getWorkspacePlatformAdapter } from "./platforms/index.js";
import { readJsonPayload } from "./runtime/stdin.js";

type CliArgs =
  | { command: "run"; platform: Platform; event: HookEvent }
  | { command: "workspaces"; platform: Platform; event: WorkspaceHookEvent }
  | {
      command: "workspace-configure";
      platform: Platform;
      scope: "project" | "user" | "session";
      workspaceId?: string;
      workspace?: string;
      sessionId?: string;
    };

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    process.stderr.write(usage());
    return 1;
  }

  if (args.command === "workspace-configure") {
    const result = await routeWorkspaceEvent(getWorkspacePlatformAdapter(args.platform), {
      platform: args.platform,
      event: "InstallConfigure",
      rawPayload: {
        scope: args.scope,
        ...(args.workspaceId !== undefined ? { workspaceId: args.workspaceId } : {}),
        ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      },
      processCwd: process.cwd(),
    });
    return writeWorkspaceConfigureResult(result);
  }

  const rawPayload = await readJsonPayload();
  const result =
    args.command === "run"
      ? await routeEvent(getMemoryPlatformAdapter(args.platform), {
          platform: args.platform,
          event: args.event,
          rawPayload,
          processCwd: process.cwd(),
        })
      : await routeWorkspaceEvent(getWorkspacePlatformAdapter(args.platform), {
          platform: args.platform,
          event: args.event,
          rawPayload,
          processCwd: process.cwd(),
        });
  process.stdout.write(`${JSON.stringify(result.stdout)}\n`);
  return 0;
}

function parseArgs(argv: string[]): CliArgs | null {
  const [command, platformArg, eventFlag, eventArg] = argv;
  if (command === "workspaces" && platformArg === "configure") {
    const platform = argv[2];
    const scope = flagValue(argv, "--scope");
    const workspaceId = flagValue(argv, "--workspace-id");
    const workspace = flagValue(argv, "--workspace");
    const sessionId = flagValue(argv, "--session-id");
    if (scope === null || workspaceId === null || workspace === null || sessionId === null) {
      return null;
    }
    if (isPlatform(platform) && (scope === "project" || scope === "user" || scope === "session")) {
      return {
        command: "workspace-configure",
        platform,
        scope,
        ...(workspaceId !== undefined && workspaceId.trim() !== "" ? { workspaceId } : {}),
        ...(workspace !== undefined && workspace.trim() !== "" ? { workspace } : {}),
        ...(sessionId !== undefined && sessionId.trim() !== "" ? { sessionId } : {}),
      };
    }
  }
  if (command === "run" && eventFlag === "--event" && isPlatform(platformArg) && isHookEvent(eventArg)) {
    return { command: "run", platform: platformArg, event: eventArg };
  }
  if (
    command === "workspaces" &&
    eventFlag === "--event" &&
    isPlatform(platformArg) &&
    isWorkspaceHookEvent(eventArg)
  ) {
    return { command: "workspaces", platform: platformArg, event: eventArg };
  }
  return null;
}

function flagValue(argv: string[], flag: string): string | undefined | null {
  const flagIndex = argv.indexOf(flag);
  if (flagIndex < 0) {
    return undefined;
  }
  const value = argv[flagIndex + 1];
  return value !== undefined && !value.startsWith("--") ? value : null;
}

async function routeEvent(
  adapter: MemoryPlatformAdapter,
  invocation: HookInvocation,
): Promise<HookResult> {
  switch (invocation.event) {
    case "SessionStart":
      return adapter.startSession({ ...invocation, event: "SessionStart" });
    case "BeforeAgent":
      return adapter.beforeAgent?.({ ...invocation, event: "BeforeAgent" }) ?? allowHook();
    case "AfterAgent":
      return adapter.afterAgent?.({ ...invocation, event: "AfterAgent" }) ?? allowHook();
    case "AfterTool":
      return adapter.afterTool?.({ ...invocation, event: "AfterTool" }) ?? allowHook();
  }
}

async function routeWorkspaceEvent(
  adapter: WorkspacePlatformAdapter,
  invocation: WorkspaceHookInvocation,
): Promise<WorkspaceHookResult> {
  switch (invocation.event) {
    case "BeforeAgent":
      return adapter.beforeAgent?.({ ...invocation, event: "BeforeAgent" }) ?? allowHook();
    case "InstallConfigure":
      return adapter.installConfigure?.({ ...invocation, event: "InstallConfigure" }) ?? allowHook();
  }
}

function allowHook(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}

function writeWorkspaceConfigureResult(result: WorkspaceHookResult): number {
  const exitCode = typeof result.stdout.exitCode === "number" ? result.stdout.exitCode : 0;
  const message = typeof result.stdout.message === "string" ? result.stdout.message : JSON.stringify(result.stdout);
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${message}\n`);
  return exitCode;
}

function usage(): string {
  return [
    "Usage: nams-hooks run <gemini|claude|codex|opencode> --event <SessionStart|BeforeAgent|AfterAgent|AfterTool>",
    "       nams-hooks workspaces <gemini|claude|codex|opencode> --event <BeforeAgent|InstallConfigure>",
    "       nams-hooks workspaces configure <gemini|claude|codex|opencode> --scope <project|user|session> [--workspace-id ID] [--workspace ID_OR_NAME] [--session-id ID]",
    "",
  ].join("\n");
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
