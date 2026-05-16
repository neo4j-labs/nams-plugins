import type { HookInvocation, HookResult, PlatformAdapter, PlatformAdapterOptions } from "../../interfaces.js";
import { appendRawPlatformLog } from "../../runtime/logging.js";

export class ClaudeAdapter implements PlatformAdapter {
  constructor(_options: PlatformAdapterOptions = {}) {}

  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    await appendRawPlatformLog(invocation);
    return { stdout: { continue: true, suppressOutput: true } };
  }
}
