#!/usr/bin/env node
import process from "node:process";
import { isHookEvent, isPlatform, isWorkspaceHookEvent, } from "./interfaces.js";
import { getMemoryPlatformAdapter, getWorkspacePlatformAdapter } from "./platforms/index.js";
import { readJsonPayload } from "./runtime/stdin.js";
async function main(argv) {
    const args = parseArgs(argv);
    if (args === null) {
        process.stderr.write(usage());
        return 1;
    }
    if (args.command === "workspace-configure") {
        const result = await routeWorkspaceEvent(getWorkspacePlatformAdapter(args.platform), {
            platform: args.platform,
            event: "InstallConfigure",
            rawPayload: {
                scope: args.scope,
                ...(args.workspaceId !== undefined ? { workspaceId: args.workspaceId } : {}),
            },
            processCwd: process.cwd(),
        });
        return writeWorkspaceConfigureResult(result);
    }
    const rawPayload = await readJsonPayload();
    const result = args.command === "run"
        ? await routeEvent(getMemoryPlatformAdapter(args.platform), {
            platform: args.platform,
            event: args.event,
            rawPayload,
            processCwd: process.cwd(),
        })
        : await routeWorkspaceEvent(getWorkspacePlatformAdapter(args.platform), {
            platform: args.platform,
            event: args.event,
            rawPayload,
            processCwd: process.cwd(),
        });
    process.stdout.write(`${JSON.stringify(result.stdout)}\n`);
    return 0;
}
function parseArgs(argv) {
    const [command, platformArg, eventFlag, eventArg] = argv;
    if (command === "workspaces" && platformArg === "configure") {
        const platform = argv[2];
        const scopeFlagIndex = argv.indexOf("--scope");
        const workspaceFlagIndex = argv.indexOf("--workspace-id");
        const scope = scopeFlagIndex >= 0 ? argv[scopeFlagIndex + 1] : undefined;
        const workspaceId = workspaceFlagIndex >= 0 ? argv[workspaceFlagIndex + 1] : undefined;
        if (isPlatform(platform) && (scope === "project" || scope === "user")) {
            return {
                command: "workspace-configure",
                platform,
                scope,
                ...(workspaceId !== undefined && workspaceId.trim() !== "" ? { workspaceId } : {}),
            };
        }
    }
    if (command === "run" && eventFlag === "--event" && isPlatform(platformArg) && isHookEvent(eventArg)) {
        return { command: "run", platform: platformArg, event: eventArg };
    }
    if (command === "workspaces" &&
        eventFlag === "--event" &&
        isPlatform(platformArg) &&
        isWorkspaceHookEvent(eventArg)) {
        return { command: "workspaces", platform: platformArg, event: eventArg };
    }
    return null;
}
async function routeEvent(adapter, invocation) {
    switch (invocation.event) {
        case "SessionStart":
            return adapter.startSession({ ...invocation, event: "SessionStart" });
        case "BeforeAgent":
            return adapter.beforeAgent?.({ ...invocation, event: "BeforeAgent" }) ?? allowHook();
        case "AfterAgent":
            return adapter.afterAgent?.({ ...invocation, event: "AfterAgent" }) ?? allowHook();
        case "AfterTool":
            return adapter.afterTool?.({ ...invocation, event: "AfterTool" }) ?? allowHook();
    }
}
async function routeWorkspaceEvent(adapter, invocation) {
    switch (invocation.event) {
        case "BeforeAgent":
            return adapter.beforeAgent?.({ ...invocation, event: "BeforeAgent" }) ?? allowHook();
        case "InstallConfigure":
            return adapter.installConfigure?.({ ...invocation, event: "InstallConfigure" }) ?? allowHook();
    }
}
function allowHook() {
    return { stdout: { continue: true, suppressOutput: true } };
}
function writeWorkspaceConfigureResult(result) {
    const exitCode = typeof result.stdout.exitCode === "number" ? result.stdout.exitCode : 0;
    const message = typeof result.stdout.message === "string" ? result.stdout.message : JSON.stringify(result.stdout);
    const stream = exitCode === 0 ? process.stdout : process.stderr;
    stream.write(`${message}\n`);
    return exitCode;
}
function usage() {
    return [
        "Usage: nams-hooks run <gemini|claude|codex|opencode> --event <SessionStart|BeforeAgent|AfterAgent|AfterTool>",
        "       nams-hooks workspaces <gemini|claude|codex|opencode> --event <BeforeAgent|InstallConfigure>",
        "       nams-hooks workspaces configure <gemini|claude|codex|opencode> --scope <project|user> [--workspace-id ID]",
        "",
    ].join("\n");
}
main(process.argv.slice(2))
    .then((code) => {
    process.exitCode = code;
})
    .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
});
