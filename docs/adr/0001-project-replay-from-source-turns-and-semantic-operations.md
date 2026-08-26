---
status: superseded
superseded-by: 0002-codex-session-outbox-replay.md
---

# Project replay from source turns and semantic operations

> Superseded by [ADR 0002](0002-codex-session-outbox-replay.md). Replay is now Codex-only, groups rollout files by `session_id`, records response-level call wrappers under explicit reasoning boundaries, and delivers through a temporary fail-fast outbox.

Session replay records one NAMS Agent Step for an explicit harness step boundary and attaches every semantic tool operation in that boundary to the same step. Codex uses `turn_id` as its source-turn identity, retains an explicit incoming `agent_message` (or otherwise the user message) as source-message provenance, and projects nested semantic items such as command executions and file changes instead of duplicating the outer Code Mode `exec` container. Claude uses `prompt_id` as source-turn identity when present, the prompt's user-message UUID as source-message provenance, one assistant message UUID as the Agent Step identity, and the message's `tool_use` blocks as its semantic tool operations.

This favors graph parity with live hooks and explicit harness identities over the simpler one-tool/one-step projection. Replay retains exact outer container call IDs as turn-level source provenance, but must not turn the containers into additional tool usages or infer a 1:1 container-to-operation relationship from adjacency.

Source message, turn, step, and operation identities remain part of replay normalization. The pinned NAMS contract links Agent Steps to Conversations and Tool Calls to Agent Steps but has no Message-to-Agent Step field, so replay must not fabricate that remote edge; persisting it requires a separate NAMS API contract decision.
