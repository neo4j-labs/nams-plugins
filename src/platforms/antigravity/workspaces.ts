import type { WorkspacePlatformAdapter } from "../../interfaces.js";
import { configureWorkspaceSelection } from "../../runtime/workspace-configuration.js";

export const antigravityWorkspaceAdapter: WorkspacePlatformAdapter = {
  installConfigure: configureWorkspaceSelection,
};
