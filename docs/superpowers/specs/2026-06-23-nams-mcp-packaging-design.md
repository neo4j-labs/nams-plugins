# NAMS MCP Packaging Design

Date: 2026-06-23
Status: Approved design
Repository: nams-plugins

## Summary

`nams-plugins` will package the hosted Neo4j Agent Memory Service MCP server as
a separate `mcp` integration beside the existing `nams-hooks` integration.
`nams-hooks` continues to own deterministic hook-based memory persistence.
`mcp` exposes agent-controlled NAMS tools through each platform's native remote
MCP configuration.

The v1 scope is cross-platform across the platforms already packaged by this
repository: Claude Code, Codex, Gemini CLI, and OpenCode. OAuth is the default
authentication path. Generated MCP artifacts point at
`https://memory.neo4jlabs.com/mcp` and do not include static authorization
headers, NAMS API key prompts, or hook runtime code.

## Source Inputs

- NAMS MCP documentation: `https://memory.neo4jlabs.com/docs#mcp`
- Claude Code MCP and plugin documentation:
  `https://code.claude.com/docs/en/mcp`
- Codex MCP and plugin documentation from the current Codex manual
- Gemini CLI MCP server documentation:
  `https://geminicli.com/docs/tools/mcp-server/`
- OpenCode MCP server documentation: `https://opencode.ai/docs/mcp-servers`
- Existing hook architecture:
  `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- Existing umbrella rename:
  `docs/superpowers/specs/2026-06-08-nams-plugins-umbrella-rename-design.md`
- Existing distribution projections:
  `docs/superpowers/specs/2026-06-12-dist-template-projections-design.md`

## Goals

- Add a separate installable or configurable `mcp` surface under the
  `nams-plugins` umbrella.
- Keep `mcp` separate from `nams-hooks` so users can install either one or both.
- Use OAuth-first remote MCP configuration by default.
- Keep generated MCP artifacts declarative: no bundled Node runtime, no REST
  client, and no install-time setup scripts.
- Support Claude Code, Codex, Gemini CLI, and OpenCode in the first MCP
  packaging pass.
- Preserve the current hook runtime, hook templates, NAMS configuration
  precedence, state, and logs.
- Add package and distribution checks that make the separation between
  `nams-hooks` and `mcp` visible in tests.
- Document platform-specific installation or merge steps honestly where a
  platform does not expose the same marketplace plugin command shape.

## Non-Goals

- Implementing `npx @neo4j-labs/nams-plugins install mcp`.
- Mutating user config files from the hook runtime.
- Adding a local stdio proxy or MCP bridge process.
- Adding runtime npm dependencies.
- Adding NAMS API key prompts or static bearer-token headers to generated MCP
  artifacts.
- Replacing deterministic hook writes with MCP-driven writes.
- Expanding this repository to every client listed in the NAMS MCP docs.
- Changing NAMS REST OpenAPI generation or hook memory behavior.

## Naming Model

`nams-plugins` remains the umbrella marketplace, repository, and npm package
identity.

`nams-hooks` remains the deterministic hook integration:

- Claude plugin name: `nams-hooks`
- Codex plugin name: `nams-hooks`
- Gemini extension name: `nams-hooks`
- npm executable: `nams-hooks`

`mcp` becomes the hosted MCP integration:

- Claude plugin name: `mcp`
- Codex plugin name: `mcp`
- Gemini extension/config name: `nams-mcp`
- OpenCode config fragment name: `nams-mcp`

Platform-specific source folders use explicit names so release artifacts are
easy to inspect:

```text
plugins/claude-nams-mcp/
plugins/codex-nams-mcp/
gemini-mcp/
opencode-mcp/
```

## Architecture

The MCP package is declarative. It points supported clients at the hosted NAMS
MCP endpoint and lets those clients perform OAuth discovery, login, token
storage, and tool execution.

The generated MCP artifacts must not:

- execute `nams-hooks`
- import compiled runtime files
- read or write `.nams/`
- read `docs/nams-openapi.json`
- call the generated NAMS REST client
- define `NAMS_API_KEY`, `NAMS_WORKSPACE_ID`, or `NAMS_BASE_URL`
- include `Authorization` headers

This preserves the existing boundary:

- Hooks own deterministic, automatic memory persistence.
- MCP owns interactive, agent-selected NAMS tools.

Users may install both. If they do, hook memory behavior remains deterministic,
and MCP tool use is an additional explicit capability available to the agent.

## Platform Packaging

### Claude Code

The Claude marketplace root gains a second plugin entry:

```json
{
  "name": "mcp",
  "source": "./plugins/claude-nams-mcp",
  "description": "OAuth-first Neo4j Agent Memory Service MCP tools for Claude Code.",
  "version": "__PACKAGE_VERSION__",
  "repository": "https://github.com/neo4j-labs/nams-plugins",
  "license": "__PACKAGE_LICENSE__",
  "category": "memory"
}
```

`templates/marketplace/claude/plugins/claude-nams-mcp/.claude-plugin/plugin.json`
declares a remote MCP server named `nams`:

```json
{
  "name": "mcp",
  "version": "__PACKAGE_VERSION__",
  "description": "OAuth-first Neo4j Agent Memory Service MCP tools for Claude Code.",
  "mcpServers": {
    "nams": {
      "type": "http",
      "url": "https://memory.neo4jlabs.com/mcp"
    }
  }
}
```

The plugin does not declare hooks or `userConfig`. Claude Code owns OAuth login
and token storage for the remote MCP server.

Documented install command:

```bash
claude plugin marketplace add neo4j-labs/nams-plugins@latest
claude plugin install mcp@nams-plugins
```

### Codex

The Codex marketplace root gains a second plugin entry:

```json
{
  "name": "mcp",
  "source": {
    "source": "local",
    "path": "./plugins/codex-nams-mcp"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_USE"
  },
  "interface": {
    "displayName": "NAMS MCP"
  },
  "description": "OAuth-first Neo4j Agent Memory Service MCP tools for Codex."
}
```

`templates/marketplace/codex/plugins/codex-nams-mcp/.codex-plugin/plugin.json`
declares the NAMS remote MCP server through Codex's plugin-provided MCP server
manifest field. The expected logical server shape is:

```json
{
  "name": "mcp",
  "version": "__PACKAGE_VERSION__",
  "description": "OAuth-first Neo4j Agent Memory Service MCP tools for Codex.",
  "mcpServers": {
    "nams": {
      "url": "https://memory.neo4jlabs.com/mcp"
    }
  }
}
```

During implementation, verify the exact current Codex plugin manifest key and
transport schema against Codex plugin documentation or a local plugin install.
The design requirement is not the literal spelling above; it is that Codex sees
an installed plugin-provided remote MCP server named `nams`, with OAuth enabled
by the absence of static bearer-token configuration. User config may then
control enablement and tool policy under Codex's `plugins.<plugin>.mcp_servers`
tables.

Documented install flow:

```bash
codex plugin marketplace add neo4j-labs/nams-plugins@latest
```

Then restart Codex, open `/plugins`, select the `nams-plugins` marketplace, and
install `NAMS MCP`.

### Gemini CLI

Gemini currently consumes this repository's release root as the `nams-hooks`
extension. To keep `mcp` separate, the MCP package is generated as a separate
MCP-only extension/config root rather than being merged into the existing
`nams-hooks` Gemini extension.

Source layout:

```text
templates/marketplace/gemini-mcp/
  gemini-extension.json
  settings.json
```

Generated marketplace layout:

```text
dist-marketplace/gemini-mcp/
  gemini-extension.json
  settings.json
```

The generated Gemini settings declare only the remote MCP server:

```json
{
  "mcpServers": {
    "nams": {
      "httpUrl": "https://memory.neo4jlabs.com/mcp"
    }
  }
}
```

The MCP-only extension does not include hooks, commands, or compiled runtime.
The documented v1 path is a local link/copy flow for
`dist-marketplace/gemini-mcp/`. The later
`npx @neo4j-labs/nams-plugins install mcp` workstream will own the polished
one-command Gemini setup.

### OpenCode

OpenCode MCP configuration lives in `opencode.json`, not in the current
JavaScript hook plugin shim. To keep `mcp` separate, v1 generates an MCP-only
OpenCode config artifact rather than adding MCP to `nams-hooks.js`.

Source layout:

```text
templates/marketplace/opencode-mcp/
  opencode.json
```

Generated marketplace layout:

```text
dist-marketplace/opencode-mcp/
  opencode.json
```

The generated config declares only the remote MCP server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "nams": {
      "type": "remote",
      "url": "https://memory.neo4jlabs.com/mcp",
      "enabled": true
    }
  }
}
```

The artifact is a mergeable config fragment. It does not replace a user's
existing `opencode.json` automatically. The later `npx @neo4j-labs/nams-plugins
install mcp` workstream can provide safe config merge behavior.

## Distribution Shape

`dist/` remains the npm runtime package for `nams-hooks`. It does not include
MCP marketplace artifacts.

`dist-marketplace/` gains MCP artifacts:

```text
dist-marketplace/
  .claude-plugin/
    marketplace.json              # plugins: nams-hooks, mcp
  .agents/
    plugins/
      marketplace.json            # plugins: nams-hooks, mcp
  plugins/
    claude-nams-hooks/
    claude-nams-mcp/
      .claude-plugin/
        plugin.json
    codex-nams-hooks/
    codex-nams-mcp/
      .codex-plugin/
        plugin.json
    gemini-nams-hooks/
    opencode-nams-hooks/
  gemini-extension.json           # existing nams-hooks extension
  hooks/
  commands/
  gemini-mcp/
    gemini-extension.json
    settings.json
  opencode-mcp/
    opencode.json
```

No MCP directory receives a `bin/` directory or copied compiled runtime.

`dist-local/` includes equivalent MCP-only local-installation artifacts for
manual local testing:

```text
dist-local/
  claude-mcp/
    .claude-plugin/
      plugin.json
  codex-mcp/
    .codex-plugin/
      plugin.json
  gemini-mcp/
    .gemini/
      settings.json
  opencode-mcp/
    opencode.json
```

## Auth And Data Flow

1. A user installs or links the platform-native `mcp` artifact.
2. The client discovers a remote MCP server named `nams`.
3. On first use, the client performs native OAuth login against the NAMS MCP
   server metadata.
4. The client stores OAuth tokens in its own credential store.
5. MCP tool calls go directly from the client to
   `https://memory.neo4jlabs.com/mcp`.

NAMS API keys remain valid for hook runtime configuration, but they are not the
generated MCP default. Static bearer-token examples may appear in
troubleshooting documentation only, clearly labeled as a fallback.

## Documentation

README, INSTALL, and DEVELOPMENT should describe `nams-hooks` and `mcp` as
separate products inside `nams-plugins`.

Claude docs show:

```bash
claude plugin marketplace add neo4j-labs/nams-plugins@latest
claude plugin install mcp@nams-plugins
```

They also identify `dist-local/claude-mcp/` as the local MCP plugin artifact.

Codex docs show marketplace installation followed by `/plugins` selection of
`NAMS MCP`, plus the `dist-local/codex-mcp/` local artifact.

Gemini docs explain that `nams-hooks` remains the root extension and that
`nams-mcp` is a separate MCP-only extension/config artifact, with both
`dist-marketplace/gemini-mcp/` and `dist-local/gemini-mcp/` outputs.

OpenCode docs explain that `opencode-mcp/opencode.json` is a config fragment to
merge, that both marketplace and local output roots exist, and that automated
merge/install behavior is deferred to the later
`npx @neo4j-labs/nams-plugins install mcp` workstream.

## Testing

Template tests should cover:

- Claude marketplace exposes both `nams-hooks` and `mcp`.
- Claude `mcp` plugin manifest declares the `nams` remote MCP server.
- Claude `mcp` plugin manifest does not declare hooks, `userConfig`, or static
  authorization headers.
- Claude local MCP artifact declares the same OAuth-first remote MCP server.
- Codex marketplace exposes both `nams-hooks` and `mcp`.
- Codex `mcp` plugin manifest declares a plugin-provided remote MCP server
  named `nams` using the current supported Codex manifest schema.
- Codex `mcp` plugin manifest does not declare hooks, skills, static
  authorization headers, or NAMS credential prompts.
- Codex local MCP artifact declares the same OAuth-first remote MCP server.
- Gemini MCP artifact declares `mcpServers.nams.httpUrl` and includes no hooks,
  commands, or runtime.
- OpenCode MCP artifact declares `mcp.nams.type = "remote"` and includes no
  hook plugin shim.

Distribution checks should cover:

- `dist-marketplace/` contains MCP artifacts for Claude, Codex, Gemini, and
  OpenCode.
- `dist-local/` contains MCP artifacts for Claude, Codex, Gemini, and OpenCode.
- MCP plugin folders do not contain `bin/cli.js`.
- MCP artifacts do not contain `NAMS_API_KEY`, `Authorization`, or
  `__PACKAGE_*` placeholders after rendering.
- `dist/` remains npm-runtime-only and does not include MCP marketplace
  artifacts.

Primary verification remains:

```bash
npm run check
npm run package:check
```

## Open Questions Resolved

- Should MCP be separate from hooks? Yes. `mcp` is a separate integration.
- Should v1 cover all NAMS MCP docs clients? No. v1 covers existing repo
  platforms only.
- Should OAuth or static API key be the generated default? OAuth first.
- Should the local setup command be implemented now? No. Generate local MCP
  artifacts now, but defer the one-command setup and safe merge UX to
  `npx @neo4j-labs/nams-plugins install mcp`.
- Should Gemini and OpenCode pretend to support the same plugin install command
  as Claude? No. Use native declarative artifacts and document the difference.
