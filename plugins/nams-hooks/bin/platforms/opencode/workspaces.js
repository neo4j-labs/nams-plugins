import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
export class OpenCodeWorkspaceAdapter {
    async installConfigure(invocation) {
        return configureWorkspaceSelection(invocation);
    }
}
