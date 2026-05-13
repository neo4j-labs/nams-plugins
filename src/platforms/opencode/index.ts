import type { HookInvocation, HookResult, PlatformAdapter } from "../../interfaces.js";
import { appendPlatformLog } from "../../runtime/logging.js";

export class OpenCodeAdapter implements PlatformAdapter {
  async startConversation(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    await appendPlatformLog({
      platform: invocation.platform,
      event: invocation.event,
      payload: invocation.rawPayload,
      projectDirectory: resolveOpencodeProjectDirectory(invocation),
    });
    return { stdout: { continue: true, suppressOutput: true } };
  }
}

function resolveOpencodeProjectDirectory(invocation: HookInvocation<"SessionStart">): string {
  const cwd = invocation.rawPayload.cwd;
  if (typeof cwd === "string" && cwd.trim() !== "") {
    return cwd;
  }

  const directory = invocation.rawPayload.directory;
  return typeof directory === "string" && directory.trim() !== "" ? directory : invocation.processCwd;
}
