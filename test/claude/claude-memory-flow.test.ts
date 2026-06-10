import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ClaudeAdapter } from "../../src/platforms/claude/index.js";
import { sessionStatePath } from "../../src/runtime/paths.js";
import { loadSessionState } from "../../src/runtime/session-state.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";
import { readSingleSessionLog } from "../support/runtime-home.js";

type TestEnvOverrides = Record<string, string | undefined>;
interface TestEnv extends TestEnvOverrides {
  HOME: string;
  USERPROFILE: string;
}

function testEnv(projectDir: string, overrides: TestEnvOverrides = {}): TestEnv {
  const homeDir = path.join(projectDir, "home");
  const env = { HOME: homeDir, USERPROFILE: homeDir, ...overrides };
  for (const key of [
    "HOME",
    "USERPROFILE",
    "NAMS_API_KEY",
    "NAMS_WORKSPACE_ID",
    "NAMS_BASE_URL",
    "CLAUDE_PLUGIN_OPTION_NAMS_API_KEY",
    "CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID",
    "CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL",
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  return env;
}

function hookSpecificOutput(result: { stdout: Record<string, unknown> }): Record<string, any> {
  return result.stdout.hookSpecificOutput as Record<string, any>;
}

test("initializes Claude session state on SessionStart without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock().all({ error: "unexpected NAMS call" }, 500);
    const env = testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();
    const payload = {
      session_id: "session-1",
      cwd: projectDir,
      transcript_path: path.join(projectDir, "transcript.jsonl"),
    };

    const result = await adapter.startSession({
      platform: "claude",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: payload,
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const state = (await loadSessionState("claude", "session-1"))!;
    assert.notEqual(state, null);
    assert.equal(state.harness, "claude");
    assert.equal(state.harnessSessionId, "session-1");
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.projectDirectory, projectDir);
    assert.equal(state.conversationId, undefined);
    assert.equal(nams.calls().length, 0);

    const statePath = sessionStatePath("claude", "session-1", state.createdAt);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);

    const { lines } = await readSingleSessionLog(env.HOME, "claude");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].harness, "claude");
    assert.equal(lines[0].event, "SessionStart");
    assert.equal(lines[0].kind, "hook.event");
    assert.deepEqual(lines[0].payload, payload);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("creates Claude conversation, recalls memory, injects additionalContext, and stores UserPromptSubmit prompt", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const prompt = "Please remember that I prefer fixture-driven tests.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User prefers fixture-driven tests." }] })
      .searchEntities({
        entities: [{ name: "Fixture-driven tests", description: "User prefers fixture-driven tests." }],
      })
      .message();
    const env = testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, true);
    assert.equal(Object.hasOwn(result.stdout, "additionalContext"), false);
    assert.equal(hookSpecificOutput(result).hookEventName, "UserPromptSubmit");
    assert.match(hookSpecificOutput(result).additionalContext, /User prefers fixture-driven tests\./);
    assert.match(hookSpecificOutput(result).additionalContext, /Fixture-driven tests: User prefers fixture-driven tests\./);
    assert.deepEqual(nams.requestBody("createConversation"), {
      metadata: {
        harness: "claude",
        projectDirectory: projectDir,
      },
    });
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: prompt,
    });

    const { lines } = await readSingleSessionLog(env.HOME, "claude");
    assert.equal(lines[0].kind, "hook.event");
    const workspaceDiagnostics = lines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS workspace loaded from config",
    );
    assert.equal(workspaceDiagnostics.length, 1);
    assert.deepEqual(workspaceDiagnostics[0].payload.configSources, {
      apiKey: "env:NAMS_API_KEY",
      workspaceId: "env:NAMS_WORKSPACE_ID",
      baseUrl: "env:NAMS_BASE_URL",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Claude BeforeAgent auto-selects a single listed workspace when config workspaceId is missing", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const prompt = "Resolve my workspace before memory.";
    const nams = createNamsFetchMock()
      .workspaces({
        workspaces: [{ id: "workspace-1", name: "Engineering", role: "owner", status: "active" }],
      })
      .createConversation()
      .context()
      .searchEntities()
      .message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 1);
    const createHeaders = nams.calls("createConversation")[0].options.headers as Record<string, string>;
    assert.equal(createHeaders["x-workspace-id"], "workspace-1");
    const state = (await loadSessionState("claude", "session-1"))!;
    assert.equal(state.workspace?.id, "workspace-1");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Claude BeforeAgent skips memory when multiple listed workspaces require selection", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock()
      .workspaces({
        workspaces: [
          { id: "workspace-1", name: "Engineering", role: "owner", status: "active" },
          { id: "workspace-2", name: "Research", role: "member", status: "active" },
        ],
      })
      .all({ error: "unexpected memory call" }, 500);
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "This should not create memory yet.",
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, false);
    assert.match(String(result.stdout.systemMessage), /NAMS memory is inactive for this turn/);
    assert.match(
      String(result.stdout.systemMessage),
      /nams-hooks workspaces configure claude --scope project --workspace-id/,
    );
    assert.equal(Object.hasOwn(result.stdout, "additionalContext"), false);
    assert.equal(hookSpecificOutput(result).hookEventName, "UserPromptSubmit");
    assert.match(hookSpecificOutput(result).additionalContext, /NAMS memory is inactive for this turn/);
    assert.match(hookSpecificOutput(result).additionalContext, /No memory messages were stored/);
    assert.match(hookSpecificOutput(result).additionalContext, /Multiple NAMS workspaces are available/);
    assert.match(
      hookSpecificOutput(result).additionalContext,
      /nams-hooks workspaces configure claude --scope project --workspace-id/,
    );
    assert.match(hookSpecificOutput(result).additionalContext, /workspace-2/);
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 0);
    const state = (await loadSessionState("claude", "session-1"))!;
    assert.equal(state.workspace, undefined);
    assert.equal(state.conversationId, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not store duplicate Claude UserPromptSubmit prompt twice through BeforeAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const prompt = "Remember this only once.";
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();
    const invocation = {
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    } as const;

    await adapter.beforeAgent(invocation);
    await adapter.beforeAgent(invocation);

    assert.equal(nams.calls("addMessage").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("stores Claude Stop last_assistant_message as an assistant message through AfterAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Please remember the assistant reply.",
      },
    });

    const result = await adapter.afterAgent({
      platform: "claude",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: projectDir,
        last_assistant_message: "Hello!",
      },
    });

    assert.deepEqual(nams.requestBodies("addMessage").at(-1), {
      role: "assistant",
      content: "Hello!",
    });
    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not duplicate Claude Stop assistant messages through AfterAgent", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Please remember the assistant reply once.",
      },
    });
    const invocation = {
      platform: "claude",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: projectDir,
        last_assistant_message: "Hello!",
      },
    } as const;

    await adapter.afterAgent(invocation);
    await adapter.afterAgent(invocation);

    const assistantMessages = nams
      .requestBodies("addMessage")
      .filter((body) => body.role === "assistant");
    assert.equal(assistantMessages.length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("continues when Claude NAMS apiKey is missing and logs sanitized config diagnostic", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const env = testEnv(projectDir);
    const adapter = new ClaudeAdapter();

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Hello",
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const { lines } = await readSingleSessionLog(env.HOME, "claude");
    const log = JSON.stringify(lines);
    const diagnostics = lines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS apiKey missing",
    );
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0].payload.configSources, {
      apiKey: "missing",
      workspaceId: "missing",
      baseUrl: "missing",
    });
    assert.doesNotMatch(log, /Authorization|Bearer|secret|NAMS_API_KEY/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("continues when Claude project config cannot be read and logs sanitized config diagnostic", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const prompt = "secret prompt should stay out of config diagnostics";
    await mkdir(path.join(projectDir, ".nams", "config.json"), { recursive: true });
    const nams = createNamsFetchMock().all({ error: "unexpected NAMS call" }, 500);
    const env = testEnv(projectDir, {
      NAMS_API_KEY: "secret-api-key",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.equal(nams.calls().length, 0);
    const { lines } = await readSingleSessionLog(env.HOME, "claude");
    const diagnostics = lines.filter(
      (entry) => entry.kind === "diagnostic" && entry.payload.message === "NAMS config invalid",
    );
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0].payload, {
      message: "NAMS config invalid",
      configSources: {
        apiKey: "missing",
        workspaceId: "missing",
        baseUrl: "missing",
      },
      errorSource: "project:.nams/config.json",
    });
    assert.doesNotMatch(
      JSON.stringify(diagnostics),
      /secret prompt|secret-api-key|memory\.example|NAMS_API_KEY|EISDIR|illegal operation|is a directory/i,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Claude BeforeAgent uses entity search context when conversation recall fails and still stores prompt", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const prompt = "Persist this even if conversation recall is unavailable.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ error: "context unavailable" }, 503)
      .searchEntities({
        entities: [{ name: "Autonomo", description: "User is exploring autonomo setup in Spain." }],
      })
      .message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    const result = await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, true);
    assert.equal(Object.hasOwn(result.stdout, "additionalContext"), false);
    assert.equal(hookSpecificOutput(result).hookEventName, "UserPromptSubmit");
    assert.match(hookSpecificOutput(result).additionalContext, /Autonomo: User is exploring autonomo setup in Spain\./);
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: prompt,
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("records Claude PostToolUse as reasoning step and tool call", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-post-tool-1" })
      .toolCall();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Run a shell command.",
      },
    });

    const result = await adapter.afterTool({
      platform: "claude",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        cwd: projectDir,
        tool_use_id: "tool-use-1",
        tool_name: "Bash",
        tool_input: {
          command: "printf hello",
          output: "raw output from input",
          nested: {
            responseBody: "raw response body",
            keep: "metadata",
          },
        },
        tool_response: "hello",
        duration_ms: 37,
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    assert.deepEqual(nams.requestBody("addReasoningStep"), {
      conversationId: "conversation-1",
      reasoning: "Claude Code ran Bash with the provided tool input.",
      actionTaken: "Ran Bash",
    });

    const toolBody = nams.requestBody("addToolCall");
    assert.equal(toolBody.toolName, "Bash");
    assert.equal(toolBody.stepId, "step-post-tool-1");
    assert.equal(toolBody.status, "success");
    assert.equal(toolBody.durationMs, 37);
    assert.equal(toolBody.output, "hello");
    assert.match(toolBody.input, /"command":"printf hello"/);
    assert.match(toolBody.input, /"keep":"metadata"/);
    assert.doesNotMatch(toolBody.input, /raw output from input|raw response body/);
    assert.doesNotMatch(toolBody.input, /"output"|"responseBody"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("does not duplicate Claude PostToolUse records for the same tool_use_id", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-post-tool-1" })
      .toolCall();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Run one tool once.",
      },
    });

    const invocation = {
      platform: "claude",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        cwd: projectDir,
        tool_use_id: "tool-use-1",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
        tool_response: "project directory",
        duration_ms: 12,
      },
    } as const;

    await adapter.afterTool(invocation);
    await adapter.afterTool(invocation);

    assert.equal(nams.calls("addToolCall").length, 1);
    assert.equal(nams.calls("addReasoningStep").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("records Claude PostToolUse with tool_use_id after matching no-id fallback call", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-claude-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context()
      .searchEntities()
      .message()
      .reasoningStep({ id: "step-post-tool-1" })
      .toolCall();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const adapter = new ClaudeAdapter();

    await adapter.beforeAgent({
      platform: "claude",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Run the same tool twice.",
      },
    });

    const toolInput = { command: "pwd" };

    await adapter.afterTool({
      platform: "claude",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        cwd: projectDir,
        tool_name: "Bash",
        tool_input: toolInput,
        tool_response: "project directory",
        duration_ms: 12,
      },
    });

    await adapter.afterTool({
      platform: "claude",
      event: "AfterTool",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        cwd: projectDir,
        tool_use_id: "tool-use-1",
        tool_name: "Bash",
        tool_input: toolInput,
        tool_response: "project directory",
        duration_ms: 12,
      },
    });

    assert.equal(nams.calls("addToolCall").length, 2);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
