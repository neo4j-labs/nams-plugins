# Installation

`nams-hooks` is built from TypeScript and distributed as generated JavaScript. Runtime hook code uses Node.js built-ins only.

## Prerequisites

- Node.js 20 or newer
- A NAMS API key
- Gemini CLI, for the Gemini local extension path
- OpenCode, for the OpenCode project plugin path

## Configure NAMS

Create a project-local `.nams/.env` file:

```env
NAMS_API_KEY=your_api_key_here
```

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

Placeholder: installation instructions for linking or installing directly from a repository-hosted release will be added once the external distribution path is defined.

## OpenCode

OpenCode loads project plugins from `.opencode/plugins/`.

Install the package so `nams-hooks` is on `PATH`:

```bash
npm install -g @neo4j-labs/nams-hooks
mkdir -p .opencode/plugins
```

Until an installer or packaged template command exists, copy the plugin shim from a repository checkout or release artifact into the target project.

For local development from this repository:

```bash
npm install
npm run build
mkdir -p /path/to/project/.opencode/plugins
cp templates/opencode/plugins/nams-hooks.js /path/to/project/.opencode/plugins/nams-hooks.js
```

If `nams-hooks` is not on OpenCode's `PATH`, set `NAMS_HOOKS_COMMAND` to the executable path before starting OpenCode.

The plugin listens for OpenCode events and routes them through the CLI gateway, for example `nams-hooks run opencode --event SessionStart`.
