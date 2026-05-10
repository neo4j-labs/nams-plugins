import type { HookInvocation, HookResult, PlatformAdapter } from "../interfaces.js";
import { appendPlatformLog } from "../runtime/logging.js";

export class CodexAdapter implements PlatformAdapter {
  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: resolveCodexProjectDirectory(invocation),
    });
    return { stdout: { continue: true, suppressOutput: true } };
  }
}

function resolveCodexProjectDirectory(invocation: HookInvocation<"SessionStart">): string {
  const value = invocation.rawPayload.cwd;
  return typeof value === "string" && value.trim() !== "" ? value : invocation.processCwd;
}
