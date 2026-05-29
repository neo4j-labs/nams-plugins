import type { HookInvocation } from "../interfaces.js";

export const namsHooksVersion = "0.1.0";

export function namsProvenanceHeaders(invocation: HookInvocation): Record<string, string> {
  return {
    "X-NAMS-Hooks-Harness": invocation.platform,
    "X-NAMS-Hooks-Version": namsHooksVersion,
    "X-NAMS-Hooks-Platform": process.platform,
    "X-NAMS-Hooks-Node-Version": process.version,
    "X-NAMS-Hooks-Event": invocation.event,
  };
}
