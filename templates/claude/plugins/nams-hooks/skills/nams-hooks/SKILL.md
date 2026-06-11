---
name: nams-hooks
description: Select the NAMS workspace for this Claude Code session.
argument-hint: workspaces use <workspace-id-or-name>
disable-model-invocation: true
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_SKILL_DIR}/scripts/workspace-use.mjs" "$ARGUMENTS"`
