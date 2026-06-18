# Platform Hooks And Linux Support Matrix

Research date: 2026-06-09

This matrix tracks which agent platforms expose lifecycle hooks suitable for
`nams-hooks`, which platforms support Linux, and which platforms already have a
local adapter in this repository.

Scope note: "hooks" means local lifecycle hooks or equivalent scriptable events
that can observe, block, or enrich an agent session. Generic webhooks, cloud
triggers, and APIs are called out separately because they do not map directly to
the current `nams-hooks run <platform> --event <NAMS event>` runtime model.

Naming note: Windsurf documentation now redirects into Devin Desktop/Cascade
material. The requested "warf" entry is treated as Warp.

| Platform | Hooks support | Linux support | NAMS adapter in this repo | Notes |
| --- | --- | --- | --- | --- |
| Claude Code | Yes | Yes | Yes | Mature lifecycle hooks for session, prompt, tool, stop, file/config, and related events. Linux install is documented. |
| Codex CLI | Yes | Yes | Yes | Hooks are configured with `hooks.json` or inline `config.toml`; Codex CLI supports macOS, Windows, and Linux. |
| Gemini CLI | Yes | Yes | Yes | Gemini CLI documents hook scripts, JSON stdin/stdout contracts, and macOS/Linux shell examples. |
| Antigravity CLI | Yes | Yes | No | Antigravity documents `hooks.json`; Linux desktop and CLI install paths are documented. Good candidate for the next adapter intake. |
| GitHub Copilot CLI | Yes | Yes | No | Hooks are supported in Copilot CLI and Copilot cloud agent. CLI supports Linux, macOS, and Windows. Strong adapter candidate. |
| Cursor | Yes | Yes | No | Cursor has hooks for observing, controlling, and extending the agent loop. Verify exact CLI event coverage before implementation because published and forum-documented behavior has had gaps. |
| Windsurf / Devin Desktop | Yes | Yes | No | Cascade hooks support system, user, and workspace JSON configs. Linux download is supported; current branding is Devin Desktop. |
| Warp | Different / partial | Yes | No | Warp supports third-party CLI agent enhancements and Oz cloud triggers/webhooks/API. I did not find a direct local lifecycle hook stream equivalent to Claude/Codex/Copilot hooks. Treat as an orchestration/API integration target unless a local hook API is confirmed. |

## Current Repo Support

The repository currently defines platform ids in
[`src/interfaces.ts`](../src/interfaces.ts) and registers concrete adapters in
[`src/platforms/index.ts`](../src/platforms/index.ts). At the time of this
research, implemented adapters are:

- `claude`
- `codex`
- `gemini`
- `opencode`

## Adapter Priority

Recommended next implementation targets:

1. GitHub Copilot CLI: strong hook support, Linux support, and a clear CLI-local
   execution model.
2. Antigravity CLI: hook and Linux support are documented, and the existing
   onboarding plan already uses Antigravity-like intake as a worked example.
3. Windsurf / Devin Desktop: hook surface looks useful, but docs and product
   naming are in transition.
4. Cursor: promising, but confirm CLI lifecycle hook coverage before coding.
5. Warp: keep separate from local hook adapters unless a direct hook stream is
   confirmed.

## Sources

- Claude Code hooks: <https://code.claude.com/docs/en/hooks>
- Claude Code install FAQ: <https://support.claude.com/en/articles/14554922-claude-code-user-faq>
- Codex hooks: <https://developers.openai.com/codex/hooks>
- Codex CLI: <https://developers.openai.com/codex/cli>
- Gemini CLI hooks: <https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md>
- Gemini CLI repository/install notes: <https://github.com/google-gemini/gemini-cli>
- Antigravity hooks: <https://www.antigravity.google/docs/hooks>
- Antigravity CLI getting started: <https://www.antigravity.google/docs/cli-getting-started>
- Antigravity downloads: <https://antigravity.google/download?hl=en>
- GitHub Copilot hooks reference: <https://docs.github.com/en/copilot/reference/hooks-reference>
- GitHub Copilot CLI overview: <https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli>
- GitHub Copilot CLI install: <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli>
- Cursor enterprise hooks announcement: <https://cursor.com/blog/enterprise/>
- Cursor CLI installation: <https://docs.cursor.com/en/cli/installation>
- Cursor hooks docs: <https://cursor.com/docs/hooks>
- Windsurf / Devin Desktop Cascade hooks: <https://docs.windsurf.com/windsurf/cascade/hooks>
- Windsurf / Devin Desktop Linux download: <https://windsurf.com/editor/download-linux>
- Warp third-party CLI agents: <https://docs.warp.dev/agent-platform/cli-agents/overview/>
- Warp install / Linux support: <https://docs.warp.dev/getting-started/quickstart/installation-and-setup>
- Warp Oz cloud platform: <https://docs.warp.dev/agent-platform/cloud-agents/platform>
