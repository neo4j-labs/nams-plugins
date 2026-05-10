import type { HookInvocation, HookResult, PlatformAdapter } from "../interfaces.js";
import { appendPlatformLog } from "../runtime/logging.js";

export class GeminiAdapter implements PlatformAdapter {
  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: resolveGeminiProjectDirectory(invocation),
    });
    return { stdout: { continue: true, suppressOutput: true } };
  }
}

function resolveGeminiProjectDirectory(invocation: HookInvocation<"SessionStart">): string {
  const value = invocation.rawPayload.cwd ?? invocation.rawPayload.GEMINI_PROJECT_DIR;
  return typeof value === "string" && value.trim() !== "" ? value : invocation.processCwd;
}
