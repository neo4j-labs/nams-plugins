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
                ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
                ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
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
        const scope = flagValue(argv, "--scope");
        const workspace = flagValue(argv, "--workspace");
        const sessionId = flagValue(argv, "--session-id");
        if (hasLegacyWorkspaceIdFlag(argv) || scope === null || workspace === null || sessionId === null) {
            return null;
        }
        if (isPlatform(platform) && (scope === "project" || scope === "user" || scope === "session")) {
            return {
                command: "workspace-configure",
                platform,
                scope,
                ...(workspace !== undefined && workspace.trim() !== "" ? { workspace } : {}),
                ...(sessionId !== undefined && sessionId.trim() !== "" ? { sessionId } : {}),
            };
        }
    }
    if (command === "workspaces" && platformArg === "run") {
        const platform = argv[2];
        const workspaceEventFlag = argv[3];
        const workspaceEvent = argv[4];
        if (workspaceEventFlag === "--event" && isPlatform(platform) && isWorkspaceHookEvent(workspaceEvent)) {
            return { command: "workspaces", platform, event: workspaceEvent };
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
function flagValue(argv, flag) {
    const flagIndex = argv.indexOf(flag);
    if (flagIndex < 0) {
        return undefined;
    }
    const value = argv[flagIndex + 1];
    return value !== undefined && !value.startsWith("--") ? value : null;
}
function hasLegacyWorkspaceIdFlag(argv) {
    return argv.some((arg) => arg === "--workspace-id" || arg.startsWith("--workspace-id="));
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
        case "UserPromptExpansion":
            return adapter.userPromptExpansion?.({ ...invocation, event: "UserPromptExpansion" }) ?? allowHook();
        case "CommandExecuteBefore":
            return adapter.commandExecuteBefore?.({ ...invocation, event: "CommandExecuteBefore" }) ?? allowHook();
        case "CustomCommand":
            return adapter.customCommand?.({ ...invocation, event: "CustomCommand" }) ?? allowHook();
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
        "       nams-hooks workspaces run <gemini|claude|codex|opencode> --event <BeforeAgent|InstallConfigure|UserPromptExpansion|CommandExecuteBefore|CustomCommand>",
        "       nams-hooks workspaces configure <gemini|claude|codex|opencode> --scope <project|user> [--workspace WORKSPACE_NAME_OR_ID]",
        "       nams-hooks workspaces configure <gemini|claude|codex|opencode> --scope session --session-id ID [--workspace WORKSPACE_NAME_OR_ID]",
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
