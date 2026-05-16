import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import { appendPlatformLog } from "../../runtime/logging.js";

export class ClaudeAdapter implements PlatformAdapter {
  async startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    await logClaudeInvocation(invocation);
    return allowOutput();
  }

  async beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    await logClaudeInvocation(invocation);
    return allowOutput();
  }

  async afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    await logClaudeInvocation(invocation);
    return allowOutput();
  }

  async afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    await logClaudeInvocation(invocation);
    return allowOutput();
  }
}

async function logClaudeInvocation(invocation: HookInvocation): Promise<void> {
  await appendPlatformLog({
    platform: invocation.platform,
    event: invocation.event,
    payload: invocation.rawPayload
  });
}

function allowOutput(): HookResult {
  return { stdout: { continue: true, suppressOutput: true } };
}

function resolveClaudeProjectDirectory(invocation: HookInvocation): string {
  const value = invocation.rawPayload.cwd;
  return typeof value === "string" && value.trim() !== "" ? value : invocation.processCwd;
}
