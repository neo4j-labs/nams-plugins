#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  hookEvents,
  platforms,
  replayPlatforms,
  workspaceHookEvents,
  type HookEvent,
  type HookInvocation,
  type HookResult,
  type MemoryPlatformAdapter,
  type Platform,
  type ReplayPlatform,
  type WorkspaceHookEvent,
  type WorkspaceHookInvocation,
  type WorkspacePlatformAdapter,
} from "./interfaces.js";
import {
  getMemoryPlatformAdapter,
  getReplayPlatformAdapter,
  getWorkspacePlatformAdapter,
} from "./platforms/index.js";
import { formatReplaySummary, runReplay } from "./runtime/replay.js";
import { readJsonPayload } from "./runtime/stdin.js";

type CliArgs =
  | { command: "run"; platform: Platform; event: HookEvent }
  | { command: "workspaces"; platform: Platform; event: WorkspaceHookEvent }
  | { command: "replay"; platform: ReplayPlatform; workingDirectory?: string }
  | {
      command: "workspace-configure";
      platform: Platform;
      scope: "project" | "user" | "session";
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
        ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      },
      processCwd: process.cwd(),
    });
    return writeWorkspaceConfigureResult(result);
  }

  if (args.command === "replay") {
    const importRoot = path.resolve(args.workingDirectory ?? process.cwd());
    const adapter = getReplayPlatformAdapter(args.platform);
    const summary = await runReplay({
      importRoot,
      adapter,
      onProgress: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(`${formatReplaySummary(adapter.platform, summary)}\n`);
    return summary.failed === 0 ? 0 : 1;
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
  if (command === "replay" && isReplayPlatform(platformArg)) {
    if (argv.length === 2) return { command: "replay", platform: platformArg };
    if (argv.length === 4 && argv[2] === "--working-dir" && argv[3] !== undefined && argv[3].trim() !== "" && !argv[3].startsWith("--")) {
      return { command: "replay", platform: platformArg, workingDirectory: argv[3] };
    }
    return null;
  }
  if (command === "workspaces" && platformArg === "configure") {
    const platform = argv[2];
    const scope = flagValue(argv, "--scope");
    const workspace = flagValue(argv, "--workspace");
    const sessionId = flagValue(argv, "--session-id");
    if (hasLegacyWorkspaceIdFlag(argv) || scope === null || workspace === null || sessionId === null) {
      return null;
    }
    if (isPlatform(platform) && (scope === "project" || scope === "user" || scope === "session")) {
      return {
        command: "workspace-configure",
        platform,
        scope,
        ...(workspace !== undefined && workspace.trim() !== "" ? { workspace } : {}),
        ...(sessionId !== undefined && sessionId.trim() !== "" ? { sessionId } : {}),
      };
    }
  }
  if (command === "workspaces" && platformArg === "run") {
    const platform = argv[2];
    const workspaceEventFlag = argv[3];
    const workspaceEvent = argv[4];
    if (workspaceEventFlag === "--event" && isPlatform(platform) && isWorkspaceHookEvent(workspaceEvent)) {
      return { command: "workspaces", platform, event: workspaceEvent };
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

function isPlatform(value: string | undefined): value is Platform {
  return value !== undefined && platforms.includes(value as Platform);
}

function isReplayPlatform(value: string | undefined): value is ReplayPlatform {
  return value !== undefined && replayPlatforms.includes(value as ReplayPlatform);
}

function isHookEvent(value: string | undefined): value is HookEvent {
  return value !== undefined && hookEvents.includes(value as HookEvent);
}

function isWorkspaceHookEvent(value: string | undefined): value is WorkspaceHookEvent {
  return value !== undefined && workspaceHookEvents.includes(value as WorkspaceHookEvent);
}

function flagValue(argv: string[], flag: string): string | undefined | null {
  const flagIndex = argv.indexOf(flag);
  if (flagIndex < 0) {
    return undefined;
  }
  const value = argv[flagIndex + 1];
  return value !== undefined && !value.startsWith("--") ? value : null;
}

function hasLegacyWorkspaceIdFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === "--workspace-id" || arg.startsWith("--workspace-id="));
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
): Promise<HookResult> {
  switch (invocation.event) {
    case "BeforeAgent":
      return adapter.beforeAgent?.({ ...invocation, event: "BeforeAgent" }) ?? allowHook();
    case "InstallConfigure":
      return adapter.installConfigure?.({ ...invocation, event: "InstallConfigure" }) ?? allowHook();
    case "UserPromptExpansion":
      return adapter.userPromptExpansion?.({ ...invocation, event: "UserPromptExpansion" }) ?? allowHook();
    case "CommandExecuteBefore":
      return adapter.commandExecuteBefore?.({ ...invocation, event: "CommandExecuteBefore" }) ?? allowHook();
    case "CustomCommand":
      return adapter.customCommand?.({ ...invocation, event: "CustomCommand" }) ?? allowHook();
  }
}

function allowHook(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}

function writeWorkspaceConfigureResult(result: HookResult): number {
  const exitCode = typeof result.stdout.exitCode === "number" ? result.stdout.exitCode : 0;
  const message = typeof result.stdout.message === "string" ? result.stdout.message : JSON.stringify(result.stdout);
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${message}\n`);
  return exitCode;
}

function usage(): string {
  return [
    "Usage: nams-hooks run <gemini|claude|codex|opencode> --event <SessionStart|BeforeAgent|AfterAgent|AfterTool>",
    "       nams-hooks replay <claude|codex> [--working-dir PATH]",
    "       nams-hooks workspaces run <gemini|claude|codex|opencode> --event <BeforeAgent|InstallConfigure|UserPromptExpansion|CommandExecuteBefore|CustomCommand>",
    "       nams-hooks workspaces configure <gemini|claude|codex|opencode> --scope <project|user> [--workspace WORKSPACE_NAME_OR_ID]",
    "       nams-hooks workspaces configure <gemini|claude|codex|opencode> --scope session --session-id ID [--workspace WORKSPACE_NAME_OR_ID]",
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
