# Installation

`nams-hooks` is built from TypeScript and distributed as generated JavaScript. Runtime hook code uses Node.js built-ins only.

## Prerequisites

- Node.js 20 or newer
- A NAMS API key
- Claude Code, for project-level Claude hooks
- Gemini CLI, for the Gemini local extension path
- OpenCode, for the OpenCode project plugin path

## Configure NAMS

Create a project-local `.nams/.env` file in the directory where the harness runs:

```env
NAMS_API_KEY=your_api_key_here
NAMS_BASE_URL=https://memory.neo4jlabs.com
```

`NAMS_API_KEY` is required. `NAMS_BASE_URL` is optional when using the default service URL, but set it explicitly when testing against another NAMS endpoint.

`.nams/.env` has priority over process environment variables. Keep this file local and do not commit it.

## Gemini CLI

### From A Local Build

Use this path when developing or testing the extension from a checkout.

```bash
npm install
npm run dist
gemini extensions link ./dist
```

This builds the generated Gemini extension tree under `dist/` and links it into Gemini CLI.

### From Repository

Repository-hosted Gemini installation is not published yet. For now, use the local build path above when testing Gemini CLI.

## OpenCode

OpenCode loads project plugins from `.opencode/plugins/`.

OpenCode also reads NAMS settings from the project-local `.nams/.env` described above. If OpenCode logs are written under `/path/to/project/.nams/logs/`, put `NAMS_API_KEY` and optional `NAMS_BASE_URL` in `/path/to/project/.nams/.env`.

Install the package so `nams-hooks` is on `PATH`:

```bash
npm install -g @neo4j-labs/nams-hooks
mkdir -p .opencode/plugins
cp "$(npm root -g)/@neo4j-labs/nams-hooks/templates/opencode/plugins/nams-hooks.js" .opencode/plugins/nams-hooks.js
```

If your global npm root is customized, run `npm root -g` first and copy the template from the reported package directory.

For local development from this repository:

```bash
npm install
npm run dist
mkdir -p /path/to/project/.opencode/plugins
cp templates/opencode/plugins/nams-hooks.js /path/to/project/.opencode/plugins/nams-hooks.js
```

If `nams-hooks` is not on OpenCode's `PATH`, set `NAMS_HOOKS_COMMAND` to the executable path before starting OpenCode. For a local checkout, use the generated executable:

```bash
export NAMS_HOOKS_COMMAND=/absolute/path/to/nams-hooks/dist/bin/cli.js
```

The plugin listens for OpenCode events and routes them through the CLI gateway, for example `nams-hooks run opencode --event SessionStart`.

## Claude Code

Claude Code uses project-level hook settings. The template in this repository maps Claude-native hooks to the NAMS lifecycle events understood by the shared CLI:

| Claude hook | NAMS event | Purpose |
|---|---|---|
| `SessionStart` | `SessionStart` | Log startup or resume payloads and initialize local hook state. |
| `UserPromptSubmit` | `BeforeAgent` | Prepare the before-agent memory step for prompt recall and user-message persistence. |
| `PostToolUse` | `AfterTool` | Prepare tool-call metadata capture after successful tool use. |
| `Stop` | `AfterAgent` | Prepare assistant-message persistence after Claude finishes responding. |

### From A Local Build

Use this path when developing or testing Claude hooks from a checkout.

```bash
npm install
npm run dist
npm install -g ./dist
mkdir -p .claude .nams
cp templates/claude/settings.local.json .claude/settings.local.json
```

Then create `.nams/.env` as described above. Run Claude Code from the same project directory so `nams-hooks` writes local state and logs under that project's `.nams/` directory.

If `.claude/settings.local.json` already exists, merge the `hooks` entries from `templates/claude/settings.local.json` instead of replacing the file.

### From A Package Install

When using an installed package, make sure `nams-hooks` is available on `PATH`, then create or merge the Claude hook settings in the target project:

```bash
npm install -g @neo4j-labs/nams-hooks
mkdir -p .claude .nams
```

Use this `.claude/settings.local.json` content for a new Claude project:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run claude --event SessionStart"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run claude --event BeforeAgent"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run claude --event AfterTool"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "nams-hooks run claude --event AfterAgent"
          }
        ]
      }
    ]
  }
}
```

The package install supplies the `nams-hooks` command. The project-local `.claude/settings.local.json` supplies the Claude hook wiring, and `.nams/.env` supplies NAMS credentials.
