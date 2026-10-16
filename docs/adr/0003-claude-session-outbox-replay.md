---
status: accepted
---

# Import Claude sessions through an isolated temporary outbox

Claude session history import is implemented independently from Codex replay. It discovers transcript JSONL beneath `CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`, filters sessions by the first usable absolute cwd in the root stream, and groups the root plus linked sidechain streams with one transcript `sessionId` into one NAMS conversation per import run.

Each transcript file is a stream, not a conversation. The root stream is identified by `isSidechain:false`; a sidechain stream uses `agent:<agentId>`. Adjacent subagent metadata relates `toolUseId` to the parent `Agent` call. The importer retains the parent delegation call and the child stream's internal tools but does not flatten child prompts or assistant responses into the root message stream.

Claude transcript files are append-only graphs. For each stream, the importer starts at the final UUID-bearing record and follows `parentUuid` to select the active spine. Authored messages and assistant response groups come from that spine. Direct tool results still pair by explicit call ID even when parallel results appear as sibling graph branches.

Only active root user records with `origin.kind:"human"` become user messages. Human slash-command wrappers are normalized from `command-name` and `command-args`; command expansions, local controls, interruption notices, tool results, and task notifications are excluded. Active root assistant `text` blocks grouped by `message.id` become assistant messages. Sidechain messages never enter the canonical conversation stream.

An assistant `message.id`, scoped by source session and stream, is the Agent Step boundary. A grouped response creates a step only when it contains one or more `tool_use` blocks. Visible text in the same response is a safe operational summary. Empty thinking, redacted thinking, signatures, and inferred chain-of-thought are never stored.

Every `tool_use` is attached to its response step. Direct output pairs through `tool_result.tool_use_id` and appends every visible content item in source order. Root task notifications pair through their embedded `tool-use-id` and add late asynchronous completion output and status. The importer does not duplicate top-level `toolUseResult`; it uses that representation only for async state and persisted-output metadata.

When Claude externalizes a large result, the importer resolves only the recorded basename inside the selected session's local `tool-results` directory, rejects symlinks and size mismatches, and replaces the preview with the complete companion content. It never follows the original machine's arbitrary absolute path. Missing or invalid companions fall back to model-visible output and count as unsupported.

Claude collection happens completely in memory before delivery. The importer writes logical operations to a private `outbox.jsonl` in a unique `nams-hooks-claude-replay-*` OS temporary directory, with directory mode `0700` and file mode `0600`. It never reads or updates live hook state and persists no checkpoint, cursor, deduplication key, sent marker, remote conversation ID, or remote Agent Step ID.

The sender validates the entire outbox and its local references before configuration or network access, resolves one NAMS destination, sends sequentially, performs no retry, and stops at the first error. Remote IDs exist only in memory. Handled success or failure removes the temporary directory; an abrupt termination may leave it for OS cleanup. Restarting rebuilds and resends the complete outbox, so duplicate and partial remote data are acceptable under best-effort at-least-once delivery.

Claude replay progress writes full imported/skipped transcript paths and the temporary outbox path to stderr. The aggregate summary is written to stdout. Progress never contains transcript content, outbox content, tool input/output, or credentials.

No replay abstraction is shared with Codex. Claude owns separate model, collector, outbox, sender, runner, fixture, environment, and test modules. Existing platform-neutral runtime services remain reusable, and live Claude/Codex hook behavior is unchanged.
