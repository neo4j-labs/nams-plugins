---
name: nams:workspace
description: Explicitly use $nams:workspace use <workspace-id-or-name> to select the NAMS workspace for the current Codex session after a NAMS workspace ambiguity notice.
---

# NAMS Workspace Selection

Use this skill only when the user explicitly invokes `$nams:workspace use <workspace-id-or-name>`.

Extract the selector as the full text after `use`. Preserve spaces inside the selector.

Run the NAMS workspace command through the installed executable:

```bash
nams-hooks workspaces run codex --event CustomCommand
```

Pass this JSON object on stdin:

```json
{
  "command_name": "nams:workspace",
  "command_args": "use <workspace-id-or-name>"
}
```

Report the command output to the user. If the command asks for the explicit shell fallback with `<session-id>`, show that fallback exactly.
