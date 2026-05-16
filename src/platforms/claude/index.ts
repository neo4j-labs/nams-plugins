import type { HookInvocation, HookResult, PlatformAdapter, PlatformAdapterOptions } from "../../interfaces.js";
import { appendPlatformLog } from "../../runtime/logging.js";
import { RuntimeEnvironment } from "../../runtime/paths.js";

export class ClaudeAdapter implements PlatformAdapter {
  private readonly runtimeEnvironment: RuntimeEnvironment;

  constructor(options: PlatformAdapterOptions = {}) {
    this.runtimeEnvironment = RuntimeEnvironment.from(options.runtimeEnvironment);
  }

  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: resolveClaudeProjectDirectory(invocation),
      runtimeEnvironment: this.runtimeEnvironment,
    });
    return { stdout: { continue: true, suppressOutput: true } };
  }
}

function resolveClaudeProjectDirectory(invocation: HookInvocation<"SessionStart">): string {
  const value = invocation.rawPayload.cwd;
  return typeof value === "string" && value.trim() !== "" ? value : invocation.processCwd;
}
