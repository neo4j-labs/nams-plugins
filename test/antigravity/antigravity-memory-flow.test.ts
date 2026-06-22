import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { antigravityMemoryAdapter } from "../../src/platforms/antigravity/index.js";
import { loadSessionState } from "../../src/runtime/session-state.js";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";
import { readSingleSessionLog as readRuntimeSingleSessionLog } from "../support/runtime-home.js";

type TestEnvOverrides = Record<string, string | undefined>;
interface TestEnv extends TestEnvOverrides {
  HOME: string;
  USERPROFILE: string;
}

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));

function testEnv(projectDir: string, overrides: TestEnvOverrides = {}): TestEnv {
  const env = { HOME: path.join(projectDir, "home"), USERPROFILE: path.join(projectDir, "home"), ...overrides };
  for (const key of [
    "HOME",
    "USERPROFILE",
    "NAMS_API_KEY",
    "NAMS_WORKSPACE_ID",
    "NAMS_BASE_URL",
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  return env;
}

async function copyBeforeAgentTranscript(projectDir: string): Promise<string> {
  const transcriptPath = path.join(projectDir, "transcript-before-agent.jsonl");
  const fixturePath = path.join(fixtureDirectory, "fixtures", "transcript-before-agent.jsonl");
  await writeFile(transcriptPath, await readFile(fixturePath, "utf8"), "utf8");
  return transcriptPath;
}

async function copyHiddenReasoningTranscript(projectDir: string): Promise<string> {
  const transcriptPath = path.join(projectDir, "transcript-hidden-reasoning-user.jsonl");
  const fixturePath = path.join(fixtureDirectory, "fixtures", "transcript-hidden-reasoning-user.jsonl");
  await writeFile(transcriptPath, await readFile(fixturePath, "utf8"), "utf8");
  return transcriptPath;
}

async function writeTranscript(projectDir: string, lines: Array<Record<string, unknown>>): Promise<string> {
  const transcriptPath = path.join(projectDir, "transcript.jsonl");
  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return transcriptPath;
}

async function readSingleSessionLog(homeParentDir: string): Promise<{
  logPath: string;
  lines: Array<Record<string, any>>;
  log: string;
}> {
  const { logPath, lines } = await readRuntimeSingleSessionLog(path.join(homeParentDir, "home"), "antigravity");
  return { logPath, lines, log: await readFile(logPath, "utf8") };
}

function antigravityPayload(
  projectDir: string,
  sessionId: string,
  transcriptPath?: string,
): Record<string, unknown> {
  return {
    conversationId: sessionId,
    workspacePaths: [projectDir],
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
  };
}

function injectedMessage(result: { stdout: Record<string, any> }): string {
  return injectSteps(result)[0].ephemeralMessage;
}

function injectSteps(result: { stdout: Record<string, unknown> }): Array<{ ephemeralMessage: string }> {
  return result.stdout.injectSteps as Array<{ ephemeralMessage: string }>;
}

test("initializes Antigravity session state on synthetic SessionStart without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    testEnv(projectDir);

    const result = await antigravityMemoryAdapter.startSession({
      platform: "antigravity",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1"),
    });

    assert.deepEqual(result.stdout, {});
    const state = (await loadSessionState("antigravity", "session-1"))!;
    assert.notEqual(state, null);
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.conversationId, undefined);

    const { lines } = await readSingleSessionLog(projectDir);
    assert.equal(lines[0].kind, "hook.event");
    assert.equal(lines[0].harness, "antigravity");
    assert.equal(lines[0].event, "SessionStart");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity BeforeAgent uses transcript user prompt for memory flow and injects recalled context", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const transcriptPrompt = "Please remember that I prefer fixture-driven tests.";
    const transcriptPath = await copyBeforeAgentTranscript(projectDir);
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User prefers fixture-driven tests." }] })
      .searchEntities({
        entities: [{ name: "Fixture-driven tests", description: "User prefers fixture-driven tests." }],
      })
      .message();
    testEnv(projectDir, {
      NAMS_API_KEY: "secret-api-key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });

    const result = await antigravityMemoryAdapter.beforeAgent({
      platform: "antigravity",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        ...antigravityPayload(projectDir, "session-1", transcriptPath),
        prompt: "raw payload prompt must be ignored",
      },
    });

    assert.deepEqual(Object.keys(result.stdout), ["injectSteps"]);
    assert.deepEqual(injectSteps(result).map((step) => Object.keys(step)), [
      ["ephemeralMessage"],
    ]);
    assert.match(injectedMessage(result), /User prefers fixture-driven tests\./);
    assert.equal(Object.hasOwn(result.stdout, "hookSpecificOutput"), false);
    assert.deepEqual(nams.requestBody("createConversation"), {
      metadata: {
        harness: "antigravity",
        projectDirectory: projectDir,
      },
    });
    assert.deepEqual(nams.requestBody("searchEntities"), {
      query: transcriptPrompt,
      limit: 5,
    });
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: transcriptPrompt,
    });

    const { lines, log } = await readSingleSessionLog(projectDir);
    assert.equal(lines[0].kind, "hook.event");
    const requestEntries = lines.filter((entry) => entry.kind === "nams.request");
    assert.deepEqual(
      requestEntries.map((entry) => entry.payload.operation),
      ["createConversation", "getConversationContext", "searchEntities", "addMessage"],
    );
    assert.deepEqual(requestEntries[0].payload.request.body, {
      metadata: {
        harness: "antigravity",
        projectDirectory: projectDir,
      },
    });
    assert.deepEqual(requestEntries[2].payload.request.body, {
      query: transcriptPrompt,
      limit: 5,
    });
    assert.deepEqual(requestEntries[3].payload.request.body, {
      role: "user",
      content: transcriptPrompt,
    });
    assert.doesNotMatch(log, /Authorization|Bearer|secret-api-key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity BeforeAgent auto-selects a single workspace and writes memory", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const transcriptPrompt = "Remember the auto-selected Antigravity workspace.";
    const transcriptPath = await writeTranscript(projectDir, [
      { id: "user-content-1", role: "user", content: transcriptPrompt, status: "completed" },
    ]);
    const nams = createNamsFetchMock()
      .workspaces({
        workspaces: [{ id: "workspace-auto", name: "Engineering", role: "owner", status: "active" }],
      })
      .createConversation()
      .context()
      .searchEntities()
      .message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_BASE_URL: "https://memory.example.test",
    });

    const result = await antigravityMemoryAdapter.beforeAgent({
      platform: "antigravity",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });

    assert.deepEqual(result.stdout, {});
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 1);
    assert.equal(nams.calls("addMessage").length, 1);
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: transcriptPrompt,
    });

    const state = (await loadSessionState("antigravity", "session-1"))!;
    assert.equal(state.workspace?.id, "workspace-auto");
    assert.equal(state.workspace?.source, "runtime-single-workspace");
    assert.equal(typeof state.workspace?.selectedAt, "string");
    assert.doesNotThrow(() => new Date(String(state.workspace?.selectedAt)).toISOString());
    assert.equal(state.conversationId, "conversation-1");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity BeforeAgent stores a duplicate transcript-derived user message only once", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const transcriptPath = await copyBeforeAgentTranscript(projectDir);
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const invocation = {
      platform: "antigravity" as const,
      event: "BeforeAgent" as const,
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    };

    await antigravityMemoryAdapter.beforeAgent(invocation);
    await antigravityMemoryAdapter.beforeAgent(invocation);

    assert.equal(nams.calls("createConversation").length, 1);
    assert.equal(nams.calls("getConversationContext").length, 1);
    assert.equal(nams.calls("searchEntities").length, 1);
    assert.equal(nams.calls("addMessage").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity BeforeAgent ignores hidden reasoning-shaped user records and content parts", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const transcriptPath = await copyHiddenReasoningTranscript(projectDir);
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });

    await antigravityMemoryAdapter.beforeAgent({
      platform: "antigravity",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });

    assert.deepEqual(nams.requestBody("searchEntities"), {
      query: "Visible user prompt.",
      limit: 5,
    });
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: "Visible user prompt.",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity BeforeAgent ignores old prompts outside the bounded transcript tail", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const oldPrompt = "This old prompt must stay outside the bounded tail.";
    const transcriptPath = await writeTranscript(projectDir, [
      { id: "old-user-1", role: "user", text: oldPrompt, status: "completed" },
      ...Array.from({ length: 260 }, (_, index) => ({
        id: `tail-noise-${index}`,
        role: "assistant",
        content: `Recent non-user transcript noise ${index}.`,
      })),
    ]);
    const nams = createNamsFetchMock().all({ error: "unexpected NAMS call" }, 500);
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });

    const result = await antigravityMemoryAdapter.beforeAgent({
      platform: "antigravity",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });

    assert.deepEqual(result.stdout, {});
    assert.equal(nams.calls().length, 0);
    assert.equal((await loadSessionState("antigravity", "session-1"))!.conversationId, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity BeforeAgent with no transcript path or clean prompt saves state and does not call NAMS", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const nams = createNamsFetchMock().all({ error: "unexpected NAMS call" }, 500);
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });

    const noTranscriptResult = await antigravityMemoryAdapter.beforeAgent({
      platform: "antigravity",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        ...antigravityPayload(projectDir, "session-1"),
        prompt: "raw payload prompt must not be used",
      },
    });
    const transcriptWithoutPrompt = await writeTranscript(projectDir, [
      { id: "assistant-1", role: "assistant", content: "No user message here." },
      { id: "draft-1", role: "user", content: "unfinished", status: "in_progress" },
      { id: "reasoning-1", type: "reasoning", text: "hidden reasoning is not a prompt" },
    ]);
    const noPromptResult = await antigravityMemoryAdapter.beforeAgent({
      platform: "antigravity",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-2", transcriptWithoutPrompt),
    });

    assert.deepEqual(noTranscriptResult.stdout, {});
    assert.deepEqual(noPromptResult.stdout, {});
    assert.equal(nams.calls().length, 0);
    assert.equal((await loadSessionState("antigravity", "session-1"))!.conversationId, undefined);
    assert.equal((await loadSessionState("antigravity", "session-2"))!.conversationId, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity BeforeAgent returns sanitized workspace selection notices through injectSteps without writing memory", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const transcriptPath = await writeTranscript(projectDir, [
      { id: "user-content-1", type: "user", content: [{ text: "Remember the selected workspace." }] },
    ]);
    const nams = createNamsFetchMock().workspaces({
      workspaces: [
        { id: "workspace-1", name: "Default", role: "owner", status: "active" },
        { id: "workspace-2", name: "Secondary", role: "owner", status: "active" },
      ],
    });
    testEnv(projectDir, {
      NAMS_API_KEY: "secret-api-key",
      NAMS_BASE_URL: "https://memory.example.test",
    });

    const result = await antigravityMemoryAdapter.beforeAgent({
      platform: "antigravity",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });

    const message = injectedMessage(result);
    assert.match(message, /NAMS memory is inactive/);
    assert.match(message, /No memory messages were stored/);
    assert.match(message, /nams-hooks workspaces configure antigravity --scope session --session-id session-1 --workspace <workspace-id-or-name>/);
    assert.match(message, /workspace-1/);
    assert.match(message, /workspace-2/);
    assert.doesNotMatch(message, /secret-api-key|Authorization|Bearer/);
    assert.equal(Object.hasOwn(result.stdout, "hookSpecificOutput"), false);
    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(nams.calls("createConversation").length, 0);
    assert.equal(nams.calls("addMessage").length, 0);
    assert.equal((await loadSessionState("antigravity", "session-1"))!.conversationId, undefined);
    assert.equal((await loadSessionState("antigravity", "session-1"))!.workspace, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity AfterAgent stores completed assistant text from transcript after a conversation exists", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const assistantResponse = "I'll keep the Antigravity assistant response.";
    const transcriptPath = await writeTranscript(projectDir, [
      { id: "user-content-1", role: "user", content: "Remember the assistant response.", status: "completed" },
      { id: "assistant-content-1", role: "assistant", content: assistantResponse, status: "completed" },
    ]);
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });

    await antigravityMemoryAdapter.beforeAgent({
      platform: "antigravity",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });
    const result = await antigravityMemoryAdapter.afterAgent({
      platform: "antigravity",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });

    assert.deepEqual(result.stdout, {});
    const assistantMessages = nams.requestBodies("addMessage").filter((body) => body.role === "assistant");
    assert.deepEqual(assistantMessages, [{ role: "assistant", content: assistantResponse }]);
    assert.equal((await loadSessionState("antigravity", "session-1"))!.seenTranscriptEntryIds.includes("assistant-content-1"), true);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity AfterAgent does not write when assistant transcript response is missing or blank", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const transcriptPath = await writeTranscript(projectDir, [
      { id: "user-content-1", role: "user", content: "Create a conversation first.", status: "completed" },
      { id: "assistant-blank", role: "assistant", content: "   ", status: "completed" },
      { id: "assistant-draft", role: "assistant", content: "Draft response must not persist.", status: "in_progress" },
    ]);
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });

    await antigravityMemoryAdapter.beforeAgent({
      platform: "antigravity",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });
    const result = await antigravityMemoryAdapter.afterAgent({
      platform: "antigravity",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });

    assert.deepEqual(result.stdout, {});
    assert.deepEqual(nams.requestBodies("addMessage").filter((body) => body.role === "assistant"), []);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity AfterAgent suppresses duplicate assistant transcript entries across replayed reads", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const transcriptPath = await writeTranscript(projectDir, [
      { id: "user-content-1", role: "user", content: "Create a conversation for replay testing.", status: "completed" },
      { id: "assistant-content-1", role: "assistant", content: "Only the first replayed content stores.", status: "completed" },
    ]);
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const afterInvocation = {
      platform: "antigravity" as const,
      event: "AfterAgent" as const,
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    };

    await antigravityMemoryAdapter.beforeAgent({
      platform: "antigravity",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });
    await antigravityMemoryAdapter.afterAgent(afterInvocation);
    await writeTranscript(projectDir, [
      { id: "user-content-1", role: "user", content: "Create a conversation for replay testing.", status: "completed" },
      { id: "assistant-content-1", role: "assistant", content: "Mutated replay content must not store.", status: "completed" },
    ]);
    await antigravityMemoryAdapter.afterAgent(afterInvocation);

    const assistantMessages = nams.requestBodies("addMessage").filter((body) => body.role === "assistant");
    assert.deepEqual(assistantMessages, [
      { role: "assistant", content: "Only the first replayed content stores." },
    ]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity AfterAgent stores identical assistant text from distinct transcript entry ids", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const repeatedResponse = "Repeated assistant response.";
    const transcriptPath = await writeTranscript(projectDir, [
      { id: "user-content-1", role: "user", content: "Create a conversation for repeated assistant text.", status: "completed" },
      { id: "assistant-content-1", role: "assistant", content: repeatedResponse, status: "completed" },
    ]);
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });
    const afterInvocation = {
      platform: "antigravity" as const,
      event: "AfterAgent" as const,
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    };

    await antigravityMemoryAdapter.beforeAgent({
      platform: "antigravity",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });
    await antigravityMemoryAdapter.afterAgent(afterInvocation);
    await writeTranscript(projectDir, [
      { id: "user-content-1", role: "user", content: "Create a conversation for repeated assistant text.", status: "completed" },
      { id: "assistant-content-1", role: "assistant", content: repeatedResponse, status: "completed" },
      { id: "assistant-content-2", role: "assistant", content: repeatedResponse, status: "completed" },
    ]);
    await antigravityMemoryAdapter.afterAgent(afterInvocation);

    const assistantMessages = nams.requestBodies("addMessage").filter((body) => body.role === "assistant");
    assert.deepEqual(assistantMessages, [
      { role: "assistant", content: repeatedResponse },
      { role: "assistant", content: repeatedResponse },
    ]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity AfterAgent filters hidden reasoning text from assistant transcript content", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const transcriptPath = await writeTranscript(projectDir, [
      { id: "user-content-1", role: "user", content: "Create a conversation for filtering.", status: "completed" },
      { id: "assistant-reasoning-1", role: "assistant", type: "reasoning", content: "hidden chain text", status: "completed" },
      {
        id: "assistant-content-1",
        role: "assistant",
        content: [
          { type: "thought", text: "hidden thought text" },
          { text: "Visible assistant answer." },
        ],
        status: "completed",
      },
    ]);
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });

    await antigravityMemoryAdapter.beforeAgent({
      platform: "antigravity",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });
    await antigravityMemoryAdapter.afterAgent({
      platform: "antigravity",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });

    const assistantMessages = nams.requestBodies("addMessage").filter((body) => body.role === "assistant");
    assert.deepEqual(assistantMessages, [{ role: "assistant", content: "Visible assistant answer." }]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Antigravity AfterAgent with no conversation returns empty stdout and does not call NAMS", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-antigravity-flow-"));
  try {
    const transcriptPath = await writeTranscript(projectDir, [
      { id: "assistant-content-1", role: "assistant", content: "No conversation exists.", status: "completed" },
    ]);
    const nams = createNamsFetchMock().all({ error: "unexpected NAMS call" }, 500);
    testEnv(projectDir, {
      NAMS_API_KEY: "key",
      NAMS_WORKSPACE_ID: "workspace-1",
      NAMS_BASE_URL: "https://memory.example.test",
    });

    const result = await antigravityMemoryAdapter.afterAgent({
      platform: "antigravity",
      event: "AfterAgent",
      processCwd: projectDir,
      rawPayload: antigravityPayload(projectDir, "session-1", transcriptPath),
    });

    assert.deepEqual(result.stdout, {});
    assert.equal(nams.calls().length, 0);
    assert.equal((await loadSessionState("antigravity", "session-1"))!.conversationId, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
