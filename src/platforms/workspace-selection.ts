import type { Platform } from "../interfaces.js";
import type { PublicWorkspaceSummary } from "../runtime/workspace-resolution.js";

export function formatWorkspaceSelectionNotice(
  platform: Platform,
  workspaces: PublicWorkspaceSummary[],
  sessionId?: string,
): string {
  const commandSessionId = sessionId?.trim() || "<session-id>";
  return [
    "NAMS memory is inactive for this turn.",
    "No memory messages were stored. Multiple NAMS workspaces are available, and no workspaceId is configured.",
    `Configure a session workspace before memory can resume: nams-hooks workspaces configure ${platform} --scope session --session-id ${commandSessionId} --workspace <workspace-id-or-name>`,
    "Available NAMS workspaces:",
    ...workspaces.map((workspace, index) => {
      const name = workspace.name?.trim() || "(unnamed workspace)";
      const role = workspace.role?.trim() || "unknown-role";
      const status = workspace.status?.trim() || "unknown-status";
      return `${index + 1}. ${name} (${role}, ${status}) - ${workspace.id}`;
    }),
  ].join("\n");
}
