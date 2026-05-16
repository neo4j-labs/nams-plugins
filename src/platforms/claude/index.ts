import type { HookInvocation, HookResult, PlatformAdapter, PlatformAdapterOptions } from "../../interfaces.js";
import { appendPlatformLog } from "../../runtime/logging.js";

export class ClaudeAdapter implements PlatformAdapter {
  constructor(_options: PlatformAdapterOptions = {}) {}

  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
    });
    return { stdout: { continue: true, suppressOutput: true } };
  }
}
