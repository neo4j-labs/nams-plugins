import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HookInvocation } from "../interfaces.js";

function readPackageVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, "package.json");
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // not found at this level; walk up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Unable to locate package.json relative to runtime/provenance.ts");
}

export const namsHooksVersion: string = readPackageVersion();

export function namsProvenanceHeaders(invocation: HookInvocation): Record<string, string> {
  return {
    ...baseProvenanceHeaders(invocation.platform),
    "X-NAMS-Hooks-Event": invocation.event,
  };
}

export function namsReplayProvenanceHeaders(): Record<string, string> {
  return {
    ...baseProvenanceHeaders("codex"),
    "X-NAMS-Hooks-Command": "replay",
  };
}

function baseProvenanceHeaders(harness: string): Record<string, string> {
  return {
    "X-NAMS-Hooks-Harness": harness,
    "X-NAMS-Hooks-Version": namsHooksVersion,
    "X-NAMS-Hooks-Platform": process.platform,
    "X-NAMS-Hooks-Node-Version": process.version,
  };
}
