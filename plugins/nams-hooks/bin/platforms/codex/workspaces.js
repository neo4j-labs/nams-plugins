import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
export class CodexWorkspaceAdapter {
    async installConfigure(invocation) {
        return configureWorkspaceSelection(invocation);
    }
}
