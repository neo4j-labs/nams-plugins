import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import { appendPlatformLog } from "../../runtime/logging.js";

export interface ClaudeAdapterOptions {
  env?: Record<string, string | undefined>;
}

export class ClaudeAdapter implements PlatformAdapter {
  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: resolveClaudeProjectDirectory(invocation),
      env: this.options.env,
    });
    return { stdout: { continue: true, suppressOutput: true } };
  }
}

function resolveClaudeProjectDirectory(invocation: HookInvocation<"SessionStart">): string {
  const value = invocation.rawPayload.cwd;
  return typeof value === "string" && value.trim() !== "" ? value : invocation.processCwd;
}
