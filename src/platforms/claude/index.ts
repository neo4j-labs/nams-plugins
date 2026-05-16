import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import { appendRawPlatformLog } from "../../runtime/logging.js";

export class ClaudeAdapter implements PlatformAdapter {
  async startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    await appendRawPlatformLog(invocation);
    return { stdout: { continue: true, suppressOutput: true } };
  }
}
