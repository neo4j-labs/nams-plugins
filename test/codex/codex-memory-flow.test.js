import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNamsFetchMock } from "../support/nams-fetch-mock.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const codexUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "codex", "index.js")).href;
const stateUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "session-state.js")).href;

test("initializes Codex session state on SessionStart without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const { CodexAdapter } = await import(codexUrl);
    const { loadSessionState } = await import(stateUrl);
    const adapter = new CodexAdapter();

    const result = await adapter.startConversation({
      platform: "codex",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const state = await loadSessionState(projectDir, "codex", "session-1");
    assert.notEqual(state, null);
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.conversationId, undefined);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("creates Codex conversation, recalls memory, returns context, and stores UserPromptSubmit prompt", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const prompt = "Please remember that I prefer fixture-driven tests.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User prefers fixture-driven tests." }] })
      .searchEntities({
        entities: [{ name: "Fixture-driven tests", description: "User prefers fixture-driven tests." }],
      })
      .message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

    const result = await adapter.beforeAgent({
      platform: "codex",
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
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /User prefers fixture-driven tests\./);
    assert.equal(result.stdout.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.deepEqual(nams.requestBody("createConversation"), {
      metadata: {
        harness: "codex",
        projectDirectory: projectDir,
      },
    });
    assert.deepEqual(nams.requestBody("searchEntities"), {
      query: prompt,
      limit: 5,
    });
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: prompt,
    });

    const { lines } = await readSingleSessionLog(projectDir);
    assert.equal(lines[0].kind, "hook.event");
    const requestEntries = lines.filter((entry) => entry.kind === "nams.request");
    assert.deepEqual(
      requestEntries.map((entry) => entry.payload.operation),
      ["createConversation", "getConversationContext", "searchEntities", "addMessage"],
    );
    assert.deepEqual(
      requestEntries.map((entry) => ({
        method: entry.payload.method,
        path: entry.payload.path,
        status: entry.payload.status,
        ok: entry.payload.ok,
      })),
      [
        { method: "POST", path: "/v1/conversations", status: 201, ok: true },
        { method: "GET", path: "/v1/conversations/{id}/context", status: 200, ok: true },
        { method: "POST", path: "/v1/entities/search", status: 200, ok: true },
        { method: "POST", path: "/v1/conversations/{id}/messages", status: 201, ok: true },
      ],
    );
    for (const entry of requestEntries) {
      assert.equal(typeof entry.payload.durationMs, "number");
    }
    assert.match(JSON.stringify(requestEntries), /fixture-driven tests/);
    assert.doesNotMatch(JSON.stringify(requestEntries), /Authorization|Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("duplicate Codex beforeAgent prompt stores one user message", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const prompt = "Remember this only once.";
    const nams = createNamsFetchMock().createConversation().context().searchEntities().message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });
    const invocation = {
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt,
      },
    };

    await adapter.beforeAgent(invocation);
    await adapter.beforeAgent(invocation);

    assert.equal(nams.calls("addMessage").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("missing Codex NAMS_API_KEY returns allow output and sanitized log", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({ env: {} });

    const result = await adapter.beforeAgent({
      platform: "codex",
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
    const { log } = await readSingleSessionLog(projectDir);
    assert.match(log, /NAMS_API_KEY missing/);
    assert.doesNotMatch(log, /Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex recall failure still stores prompt and can return entity search context", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const prompt = "Persist this even if conversation recall is unavailable.";
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ error: "context unavailable" }, 503)
      .searchEntities({
        entities: [{ name: "Autonomo", description: "User is exploring autonomo setup in Spain." }],
      })
      .message();
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

    const result = await adapter.beforeAgent({
      platform: "codex",
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
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /Autonomo: User is exploring autonomo setup in Spain\./);
    assert.equal(result.stdout.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.deepEqual(nams.requestBody("addMessage"), {
      role: "user",
      content: prompt,
    });
    const { lines, log } = await readSingleSessionLog(projectDir);
    assert.match(log, /NAMS request failed/);
    const diagnostics = lines.filter((entry) => entry.kind === "diagnostic");
    assert.deepEqual(diagnostics.map((entry) => entry.payload), [{ message: "NAMS request failed" }]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /context unavailable|Authorization|Bearer|key/);
    assert.doesNotMatch(log, /Authorization|Bearer|key/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex message failure returns recalled additional context and fails open", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const nams = createNamsFetchMock()
      .createConversation()
      .context({ observations: [{ content: "User wants concise updates." }] })
      .searchEntities()
      .message({ error: "message write unavailable" }, 503);
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({
      env: {
        NAMS_API_KEY: "key",
        NAMS_BASE_URL: "https://memory.example.test",
      },
      fetch: nams.fetch,
    });

    const result = await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "Hello",
      },
    });

    assert.equal(result.stdout.continue, true);
    assert.equal(result.stdout.suppressOutput, true);
    assert.match(result.stdout.hookSpecificOutput.additionalContext, /User wants concise updates\./);
    assert.equal(result.stdout.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(nams.calls("addMessage").length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("raw Codex hook logs are session-scoped and include raw UserPromptSubmit payload fields", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({ env: {} });

    await adapter.startConversation({
      platform: "codex",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: {
        session_id: "session-1",
        cwd: projectDir,
        source: "startup",
      },
    });
    await adapter.beforeAgent({
      platform: "codex",
      event: "BeforeAgent",
      processCwd: projectDir,
      rawPayload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: projectDir,
        prompt: "raw prompt text",
        source: "codex-cli",
        model: "gpt-5",
        permission_mode: "ask",
      },
    });

    const { fileName, lines, log } = await readSingleSessionLog(projectDir);
    assert.match(fileName, /^session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-[a-f0-9]{8}\.jsonl$/);
    assert.ok(lines.length >= 3);
    assert.equal(lines[0].kind, "hook.event");
    assert.match(log, /session-1/);
    assert.match(log, new RegExp(escapeRegExp(projectDir)));
    assert.match(log, /"event":"SessionStart"/);
    assert.match(log, /"event":"BeforeAgent"/);
    assert.match(log, /"hook_event_name":"UserPromptSubmit"/);
    assert.match(log, /"prompt":"raw prompt text"/);
    assert.match(log, /"source":"codex-cli"/);
    assert.match(log, /"model":"gpt-5"/);
    assert.match(log, /"permission_mode":"ask"/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Codex observability log write failure does not block response", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-codex-flow-"));
  try {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await writeFile(path.join(projectDir, ".nams", "logs"), "not a directory", "utf8");

    const { CodexAdapter } = await import(codexUrl);
    const adapter = new CodexAdapter({ env: {} });

    const result = await adapter.beforeAgent({
      platform: "codex",
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
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

async function readSingleSessionLog(projectDir) {
  const logDir = path.join(projectDir, ".nams", "logs");
  const fileNames = await readdir(logDir);
  const sessionFileNames = fileNames.filter((fileName) => fileName.startsWith("session-"));
  assert.equal(sessionFileNames.length, 1);
  const fileName = sessionFileNames[0];
  const log = await readFile(path.join(logDir, fileName), "utf8");
  const lines = log
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  return { fileName, lines, log };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
