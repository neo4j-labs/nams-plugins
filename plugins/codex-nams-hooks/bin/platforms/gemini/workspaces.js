import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";
export class GeminiWorkspaceAdapter {
    async installConfigure(invocation) {
        return configureWorkspaceSelection(invocation);
    }
}
