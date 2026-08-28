---
status: accepted
---

# Import Codex sessions through a temporary outbox

Session history import supports Codex only. It discovers active and archived rollout JSONL files beneath `CODEX_HOME`, filters them by their first absolute session cwd, and groups every matching root and subagent rollout with the same Codex `session_id` into one NAMS conversation per import run.

A persisted `reasoning` response item is an Agent Step boundary, not reasoning content. The importer keeps step assembly local to one thread and turn, discards boundaries with no tool calls, and attaches every subsequent response-level `custom_tool_call` or `function_call` to that step until the next boundary. Hidden and encrypted reasoning is never stored. Root-stream message events form the canonical conversation message stream: older Codex rollouts use direct `event_msg.user_message` and `event_msg.agent_message` records, while newer rollouts use completed `UserMessage` and `AgentMessage` items. Injected response-role user content and subagent assistant messages do not enter the canonical stream.

Calls pair with outputs by explicit `call_id`. Every output record and every textual output part is appended in source order before concatenation. The response-level call is canonical; nested command, file-change, and collaboration events may inform parsing diagnostics but are not emitted as duplicate tool calls.

The importer assembles the filtered corpus in memory, then writes every logical NAMS operation to a private JSONL outbox in a unique OS temporary directory. It does not read or update live hook session state and persists no checkpoint, cursor, deduplication key, conversation ID, or Agent Step ID. The sender holds remote IDs only in memory, sends sequentially, performs no retry, and stops at the first failure. A handled exit removes the temporary directory; an abrupt exit leaves it for OS cleanup.

Restarting rebuilds the outbox from source and begins again. Duplicate and partial NAMS data are acceptable. Delivery is best-effort with at-least-once behavior when an operator restarts after failure.

This ADR and its implementation remain Codex-specific. [ADR 0003](0003-claude-session-outbox-replay.md) later adds Claude replay through separate Claude model, collector, outbox, sender, and runner modules; it does not generalize or change the Codex pipeline. Claude and Codex live hooks remain unaffected.

Replay progress intentionally writes full processed rollout paths and their `imported` or `skipped` classification to stderr. After creating the private temporary outbox, it also writes the full outbox path before delivery begins. These paths are operator-visible diagnostics; the outbox still uses private permissions and is removed after a handled run, so the logged path may no longer exist when replay exits. Progress never includes rollout contents, outbox contents, tool inputs or outputs, or credentials.
