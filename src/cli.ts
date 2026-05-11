#!/usr/bin/env node

import process from "node:process";
import {
  isHookEvent,
  isPlatform,
  type HookEvent,
  type HookInvocation,
  type HookResult,
  type Platform,
  type PlatformAdapter,
} from "./interfaces.js";
import { getPlatformAdapter } from "./platforms/index.js";
import { readJsonPayload } from "./runtime/stdin.js";

interface RunArgs {
  platform: Platform;
  event: HookEvent;
}

async function main(argv: string[]): Promise<number> {
  const args = parseRunArgs(argv);
  if (args === null) {
    process.stderr.write("Usage: nams-hooks run <gemini|claude|codex> --event <SessionStart|BeforeAgent|AfterAgent|AfterTool>\n");
    return 1;
  }

  const rawPayload = await readJsonPayload();
  const adapter = getPlatformAdapter(args.platform);
  const result = await routeEvent(adapter, {
    platform: args.platform,
    event: args.event,
    rawPayload,
    processCwd: process.cwd(),
  });
  process.stdout.write(`${JSON.stringify(result.stdout)}\n`);
  return 0;
}

function parseRunArgs(argv: string[]): RunArgs | null {
  const [command, platformArg, eventFlag, eventArg] = argv;
  if (command !== "run" || eventFlag !== "--event") {
    return null;
  }
  if (!isPlatform(platformArg) || !isHookEvent(eventArg)) {
    return null;
  }
  return { platform: platformArg, event: eventArg };
}

async function routeEvent(
  adapter: PlatformAdapter,
  invocation: HookInvocation,
): Promise<HookResult> {
  switch (invocation.event) {
    case "SessionStart":
      return adapter.startConversation({ ...invocation, event: "SessionStart" });
    case "BeforeAgent":
      return adapter.beforeAgent?.({ ...invocation, event: "BeforeAgent" }) ?? allowHook();
    case "AfterAgent":
      return adapter.afterAgent?.({ ...invocation, event: "AfterAgent" }) ?? allowHook();
    case "AfterTool":
      return adapter.afterTool?.({ ...invocation, event: "AfterTool" }) ?? allowHook();
  }
}

function allowHook(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
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
