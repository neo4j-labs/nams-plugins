import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
function readPackageVersion() {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
        const candidate = path.join(dir, "package.json");
        try {
            const parsed = JSON.parse(readFileSync(candidate, "utf8"));
            if (typeof parsed.version === "string" && parsed.version.length > 0) {
                return parsed.version;
            }
        }
        catch {
            // not found at this level; walk up
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    throw new Error("Unable to locate package.json relative to runtime/provenance.ts");
}
export const namsHooksVersion = readPackageVersion();
export function namsProvenanceHeaders(invocation) {
    return {
        ...baseProvenanceHeaders(invocation.platform),
        "X-NAMS-Hooks-Event": invocation.event,
    };
}
export function namsReplayProvenanceHeaders() {
    return {
        ...baseProvenanceHeaders("codex"),
        "X-NAMS-Hooks-Command": "replay",
    };
}
export function namsClaudeReplayProvenanceHeaders() {
    return {
        ...baseProvenanceHeaders("claude"),
        "X-NAMS-Hooks-Command": "replay",
    };
}
function baseProvenanceHeaders(harness) {
    return {
        "X-NAMS-Hooks-Harness": harness,
        "X-NAMS-Hooks-Version": namsHooksVersion,
        "X-NAMS-Hooks-Platform": process.platform,
        "X-NAMS-Hooks-Node-Version": process.version,
    };
}
