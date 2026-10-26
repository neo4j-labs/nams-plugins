import { configureWorkspaceSelection } from "../runtime/workspace-configuration.js";
export function makeWorkspaceAdapter(customCommandHook, customCommand) {
    return {
        installConfigure: configureWorkspaceSelection,
        [customCommandHook]: customCommand,
    };
}
export function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
