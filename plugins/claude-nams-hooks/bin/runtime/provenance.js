export const namsHooksVersion = "0.1.0";
export function namsProvenanceHeaders(invocation) {
    return {
        "X-NAMS-Hooks-Harness": invocation.platform,
        "X-NAMS-Hooks-Version": namsHooksVersion,
        "X-NAMS-Hooks-Platform": process.platform,
        "X-NAMS-Hooks-Node-Version": process.version,
        "X-NAMS-Hooks-Event": invocation.event,
    };
}
