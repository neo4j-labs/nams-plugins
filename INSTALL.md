# Installation

`nams-hooks` is built from TypeScript and distributed as generated JavaScript. Runtime hook code uses Node.js built-ins only.

## Prerequisites

- Node.js 20 or newer
- A NAMS API key
- Gemini CLI, for the Gemini local extension path
- OpenCode, for the OpenCode project plugin path

## Configuration

Create a user-local config file at `~/.nams/config.json`:

```json
{
  "apiKey": "nams-api-key",
  "baseUrl": "https://memory.neo4jlabs.com"
}
```

`apiKey` is required for NAMS requests. `baseUrl` is optional and defaults to the runtime client's built-in NAMS URL.

Projects may override either key with `<project>/.nams/config.json`:

```json
{
  "baseUrl": "https://memory.neo4jlabs.com"
}
```

Environment variables are final overrides:

- `NAMS_API_KEY` overrides `apiKey`.
- `NAMS_BASE_URL` overrides `baseUrl`.

The runtime does not read `.env` files.

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

OpenCode uses the same NAMS configuration hierarchy as other harnesses: `~/.nams/config.json`, optional project `.nams/config.json`, then final `NAMS_API_KEY` and `NAMS_BASE_URL` environment overrides.

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
