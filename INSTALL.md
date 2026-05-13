# Installation

`nams-hooks` is built from TypeScript and distributed as generated JavaScript. Runtime hook code uses Node.js built-ins only.

## Prerequisites

- Node.js 20 or newer
- A NAMS API key
- Gemini CLI, for the Gemini local extension path

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

OpenCode loads project plugins from `.opencode/plugins/`. For the walking skeleton, install the package so `nams-hooks` is on `PATH`, then copy the plugin template into the target project:

```bash
mkdir -p .opencode/plugins
cp /path/to/nams-hooks/templates/opencode/plugins/nams-hooks.js .opencode/plugins/nams-hooks.js
```

The plugin listens for OpenCode `session.created` events and routes them through:

```bash
nams-hooks run opencode --event SessionStart
```
