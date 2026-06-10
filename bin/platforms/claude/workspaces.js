import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
export class ClaudeWorkspaceAdapter {
    async installConfigure(invocation) {
        return configureWorkspaceSelection(invocation);
    }
}
