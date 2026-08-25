# NAMS Hooks

NAMS Hooks persists agent-harness work in Neo4j Agent Memory while preserving the boundaries and vocabulary of each harness.

## Language

### Memory Lifecycle

**Agent Harness**:
An agent application, such as Gemini CLI, Claude Code, Codex, or OpenCode, that exposes session, message, response, or tool activity to NAMS Hooks.
_Avoid_: NAMS client, agent model

**Harness Session**:
One continuous unit of work identified by an agent harness and associated with at most one active NAMS conversation at a time.
_Avoid_: Process lifetime, prompt-response cycle

**Native Hook Event**:
An event named and emitted by an agent harness, with that harness's payload and output conventions.
_Avoid_: Memory lifecycle event, workspace lifecycle event

**Memory Lifecycle Event**:
A platform-neutral memory event to which a native hook event is explicitly translated: `SessionStart`, `BeforeAgent`, `AfterAgent`, or `AfterTool`.
_Avoid_: NAMS lifecycle event, native hook event, inferred event

**Workspace Lifecycle Event**:
A platform-neutral workspace-selection or command event dispatched independently of memory lifecycle events: `BeforeAgent`, `InstallConfigure`, `UserPromptExpansion`, `CommandExecuteBefore`, or `CustomCommand`.
_Avoid_: NAMS lifecycle event, memory lifecycle event, inferred event

**Session Memory Lifecycle**:
The memory activity associated with one harness session, including initialization, at-most-once recall, lazy conversation creation, and persistence of eligible messages and tool activity.
_Avoid_: Memory turn, per-turn memory lifecycle

**Memory Hook**:
A harness-triggered NAMS Hooks action that initializes session memory, recalls context, or persists eligible conversation and tool activity.
_Avoid_: Workspace command, agent-directed memory write

**Deterministic Memory Persistence**:
The rule that NAMS Hooks, rather than the agent, decides when eligible memory is written from observed memory lifecycle events.
_Avoid_: Agent-managed memory, discretionary memory write

**NAMS Conversation**:
The remote NAMS container for the memory stream belonging to one harness session in one effective workspace.
_Avoid_: Harness transcript, workspace

**Lazy Conversation Creation**:
Creation of a NAMS conversation only when the first eligible user message arrives, never merely because a harness session started.
_Avoid_: Eager conversation creation, empty startup conversation

**Core Memory Stream**:
The authored user messages and cleanly exposed assistant responses that form the reliable conversational record in NAMS.
_Avoid_: Raw transcript, reasoning trace

**Recalled Memory Context**:
Relevant prior NAMS memory recalled at most once for a harness session and supplied as concise supporting context before agent work.
_Avoid_: User-authored prompt text, transcript replay

**Context Injection**:
Delivery of recalled memory through a harness-supported context surface without rewriting it as user-authored content.
_Avoid_: Prompt mutation, visible memory narration

**Pending Memory Context**:
Recalled memory temporarily held between the hook that retrieves it and the harness surface that can inject it, then consumed once.
_Avoid_: Session memory, durable workspace selection

**Exposed Assistant Response**:
Assistant-authored text made available by a supported hook payload or an unambiguous transcript record and therefore eligible for best-effort persistence.
_Avoid_: Inferred response, compacted summary

**Exposed Tool Trace**:
The tool name, sanitized input, optional step identity, status, duration, and cleanly exposed output for one observed tool invocation.
_Avoid_: Raw tool transcript, inferred tool activity

**Operational Trace**:
A safe, tool-linked summary of observable agent activity, paired with sanitized tool metadata when available. It may be persisted as a NAMS reasoning step without preserving or reconstructing hidden reasoning. Raw or summarized model reasoning is excluded.
_Avoid_: Chain-of-thought, thinking trace, operational reasoning step

**Exposed Thought Summary**:
A harness-provided subject and description of agent activity that is explicitly visible in persisted harness records and may be stored as an operational trace.
_Avoid_: Hidden reasoning, inferred thought

**Transcript Fallback**:
Conservative use of persisted harness records to recover eligible messages or tool traces that a current hook payload did not expose cleanly.
_Avoid_: Transcript-first capture, transcript replay

**Duplicate Suppression**:
Local recognition of a previously persisted message, reasoning step, or tool trace so hook replay and transcript fallback do not write it again.
_Avoid_: Remote deduplication, content deletion

**Fail-Open Memory Behavior**:
The guarantee that unavailable configuration, unresolved workspace selection, or a failed memory or observability effect does not stop agent execution. Each failed effect is isolated so independent safe memory effects may continue.
_Avoid_: Silent success, fail-closed agent execution, all-or-nothing memory failure

**Memory-Inactive Harness Activity**:
Eligible harness activity that proceeds while NAMS recall and persistence are skipped because no effective workspace or usable connection is available.
_Avoid_: Memory-inactive turn, blocked agent work, memory-free session

### Workspace Selection

**NAMS Workspace**:
A NAMS isolation boundary within which conversations, messages, entities, reasoning steps, and tool traces are stored and queried.
_Avoid_: Harness project, NAMS conversation

**Effective Workspace**:
The single NAMS workspace selected for memory operations in the current harness session after applying session choice, configuration, prior session state, or safe auto-selection.
_Avoid_: Available workspace, default workspace

**Workspace-Scoped Memory Operation**:
A conversation, message, recall, entity-search, reasoning, or tool-trace operation that requires an effective workspace.
_Avoid_: Workspace infrastructure operation

**Workspace Infrastructure Operation**:
An operation about accessible NAMS workspaces themselves, performed before a workspace is selected and therefore outside workspace-scoped memory.
_Avoid_: Workspace-scoped memory operation

**Workspace Discovery**:
Retrieval of the valid NAMS workspaces accessible to the current credential when no higher-priority workspace selection is available.
_Avoid_: Workspace validation, key introspection

**Valid Workspace**:
A discovered workspace summary with a nonblank workspace ID that can participate in selection.
_Avoid_: Raw workspace response, configured workspace

**Workspace List Cardinality**:
The number of valid workspaces returned by discovery, used as the runtime selection signal without inferring credential type.
_Avoid_: Key type, workspace count before validation

**Workspace Auto-Selection**:
Session-local selection of the only valid discovered workspace when no explicit or prior selection exists.
_Avoid_: Default workspace, guessed workspace

**Workspace Selection Required**:
The non-blocking state in which multiple valid workspaces are available but none is effective, so memory is inactive until the user selects one.
_Avoid_: Workspace error, automatic choice

**Workspace Selector**:
A user-supplied workspace ID or exact, unambiguous workspace name used by an explicit configuration command.
_Avoid_: Partial workspace name, guessed workspace

**User Workspace Selection**:
A durable workspace default for the user across projects and harness sessions.
_Avoid_: Global workspace, session selection

**Project Workspace Selection**:
A durable workspace default for one project that takes precedence over the user selection unless a stronger session or runtime selection applies.
_Avoid_: Session selection, project directory

**Session Workspace Selection**:
An explicit workspace choice for one active harness session that overrides environment, platform, project, user, and automatic selections without changing durable configuration.
_Avoid_: Session default, project workspace selection

**Workspace Key**:
A NAMS credential scoped to memory in one current workspace; workspace discovery returns exactly one workspace for it.
_Avoid_: Workspace ID, admin key

**Admin Key**:
A NAMS credential that can access memory and workspace administration across its accessible workspaces; discovery may return one or many workspaces.
_Avoid_: Workspace key, configured key type

**Workspace Command**:
A user-invoked `nams:workspace` command that delegates a session workspace selection to the shared configuration behavior.
_Avoid_: Memory hook, interactive picker

**Control Input**:
A user command that changes NAMS session behavior but is not part of the core memory stream and must not create a conversation or be persisted as a user message.
_Avoid_: User memory input, agent instruction

**Active Workspace Session**:
A recently observed harness session that is eligible to receive a workspace selection from a user-invoked command lacking direct session context.
_Avoid_: Active process, selected workspace

**Active Workspace Session Bridge**:
The short-lived association that lets a workspace command resolve exactly one recent active workspace session without using the harness as mutable storage or guessing among plausible sessions.
_Avoid_: Session state, permanent session registry

### Local Records And Observability

**Session State**:
The local, harness-scoped mapping that relates a harness session to its NAMS conversation, effective workspace, duplicate markers, and pending context.
_Avoid_: Harness session store, transcript

**Session Key**:
The stable local identity used to find session state, preferring the harness session ID and using a project-derived fallback only when necessary.
_Avoid_: Raw filename, conversation ID

**Project Directory**:
The project root associated with live hook activity and used to scope project configuration and session-command resolution.
_Avoid_: Session working directory, import root

**Session Log**:
The local observability record that keeps hook events, NAMS requests, and sanitized diagnostics for one harness session together.
_Avoid_: Aggregate log, harness transcript

**Hook Event Record**:
A session-log observation containing the raw payload exposed by a native hook event for local debugging.
_Avoid_: NAMS request record, normalized hook payload

**NAMS Request Record**:
A sanitized session-log observation of one NAMS request and its available response, identified by operation and outcome and never containing authorization credentials.
_Avoid_: Hook event record, API key log

### Contract And Distribution

**NAMS API Contract**:
The pinned build-time agreement for the NAMS endpoints and payload shapes that NAMS Hooks supports; it is not discovered while hooks run.
_Avoid_: Live runtime schema, full NAMS SDK

**Hook Runtime Artifact**:
The executable product delivered for hook use, containing only the supported runtime and no build, generation, or test tooling requirements.
_Avoid_: Source tree, development environment

**Umbrella Identity**:
`nams-plugins`, the repository, package, release, and marketplace identity that can contain multiple NAMS integrations.
_Avoid_: Hooks product identity

**Hooks Product**:
`nams-hooks`, the installable hooks plugin and command-line product that connects agent harness activity to NAMS.
_Avoid_: Umbrella identity, NAMS service

**Source Template**:
The canonical platform hook, command, skill, configuration, or marketplace definition from which distributable platform files are generated.
_Avoid_: Generated output, hand-edited artifact

**Distribution Projection**:
A purpose-specific generated view of canonical source templates and runtime content.
_Avoid_: Template copy, combined distribution tree

**npm Package Artifact**:
The installable package projection that provides the `nams-hooks` executable and runtime without marketplace metadata or project-local configuration.
_Avoid_: Marketplace artifact, local configuration artifact

**Marketplace Artifact**:
The self-contained release projection whose platform plugins or extensions bundle the hook runtime needed by their memory hooks.
_Avoid_: npm package artifact, local configuration artifact

**Local Configuration Artifact**:
The project-shaped configuration projection that relies on an installed `nams-hooks` executable and does not bundle runtime code.
_Avoid_: Marketplace artifact, source template

### Session History Import

**Session History Import**:
A one-off, offline ingestion of persisted agent-harness session records into NAMS. It includes safely exposed conversation, tool, and operational trace data supported by the live integration, without running or resuming agents, models, or tools, recalling memory, or simulating hooks.
_Avoid_: Rerun, agent replay

**Imported Conversation**:
A NAMS conversation representing exactly one persisted source session, with that session's eligible records retained as one coherent history.
_Avoid_: Project history conversation, combined session history

**Session Working Directory**:
The first absolute working directory exposed by a persisted source session. Later records do not redefine session ownership and need not repeat this value; a missing or unusable first value leaves the session outside any import scope.
_Avoid_: Per-message working directory

**Import Root**:
The selected working directory that scopes a session history import. Sessions rooted at this directory or beneath it belong to the import, including worktrees stored below it.
_Avoid_: Exact-session directory

**Import Destination**:
The single NAMS workspace selected for one session history import. It is resolved from the import root and receives every conversation produced by that import.
_Avoid_: Per-session destination, historical workspace

**Persisted Session Corpus**:
The source sessions still present in a harness's active or archived transcript storage. Deleted, expired, ephemeral, and otherwise unpersisted sessions are outside the available corpus.
_Avoid_: Active sessions only, deleted history

**Persisted Source Session**:
Any independently persisted Claude or Codex JSONL transcript in the standard corpus whose first working directory belongs to the import root. Subagent, sidechain, fork, active, and archived classifications do not change eligibility; each matching file maps to its own imported conversation.
_Avoid_: Top-level-only session, reconstructed parent history

**Eligible Session Record**:
Only visible user and assistant text and clearly exposed tool activity are eligible. Hidden reasoning, system and developer instructions, compaction records, and ambiguous transcript shapes are not eligible.
_Avoid_: Raw transcript record, every JSONL entry

**Source Session Provenance**:
The available harness, source session identity, session working directory, and source start time associated with an imported conversation. It preserves origin without treating NAMS insertion timestamps as historical timestamps.
_Avoid_: Import timestamp as session time, inferred source time
