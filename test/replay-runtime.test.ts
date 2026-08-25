import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  ReplayPlatform,
  ReplayPlatformAdapter,
  ReplayTranscript,
} from "../src/interfaces.js";
import type { NamsConfigDiscovery } from "../src/runtime/config.js";
import { serializeToolInput, serializeToolOutput } from "../src/runtime/memory-service.js";
import { formatReplaySummary, runReplay } from "../src/runtime/replay.js";
import { createNamsFetchMock } from "./support/nams-fetch-mock.js";

const namsEnvironmentKeys = [
  "HOME",
  "NAMS_API_KEY",
  "NAMS_WORKSPACE_ID",
  "NAMS_BASE_URL",
] as const;

async function withNamsEnvironment<T>(
  callback: () => Promise<T>,
  overrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<T> {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-replay-runtime-"));
  const saved = Object.fromEntries(
    namsEnvironmentKeys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof namsEnvironmentKeys)[number], string | undefined>;
  Object.assign(process.env, {
    HOME: fixture,
    NAMS_API_KEY: "key",
    NAMS_WORKSPACE_ID: "workspace-1",
    NAMS_BASE_URL: "https://memory.example.test",
    ...overrides,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
  try {
    return await callback();
  } finally {
    for (const key of namsEnvironmentKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(fixture, { recursive: true, force: true });
  }
}

function adapter(
  platform: ReplayPlatform,
  paths: string[],
  transcripts: Record<string, ReplayTranscript>,
  discoverConfig?: NamsConfigDiscovery,
): ReplayPlatformAdapter {
  return {
    platform,
    ...(discoverConfig !== undefined ? { discoverConfig } : {}),
    async discoverTranscripts() { return paths; },
    async readTranscript(transcriptPath) { return transcripts[transcriptPath]; },
  };
}

function transcript(
  sourceSessionId: string,
  records: ReplayTranscript["records"],
  projectDirectory = "/project",
): ReplayTranscript {
  return {
    sourceSessionId,
    projectDirectory,
    records,
    malformedLineCount: 0,
    unsupportedRecordCount: 0,
  };
}

const noSleep = async (): Promise<void> => undefined;

test("reports replay configuration sources before transcript discovery", async () => {
  await withNamsEnvironment(async () => {
    const configDirectory = path.join(process.env.HOME as string, ".nams");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
      apiKey: "global-key",
      workspaceId: "global-workspace",
      baseUrl: "https://memory.example.test",
    }), "utf8");
    const progress: string[] = [];

    const summary = await runReplay({
      adapter: {
        platform: "codex",
        async discoverTranscripts() {
          assert.deepEqual(progress, [
            "Replay codex: starting; {\"configSources\":{\"apiKey\":\"global:~/.nams/config.json\",\"workspaceId\":\"global:~/.nams/config.json\",\"baseUrl\":\"global:~/.nams/config.json\"}}",
          ]);
          return [];
        },
        async readTranscript() { throw new Error("not reached"); },
      },
      importRoot: "/project",
      sleep: noSleep,
      onProgress: (line) => progress.push(line),
    });

    assert.equal(summary.discovered, 0);
  }, {
    NAMS_API_KEY: undefined,
    NAMS_WORKSPACE_ID: undefined,
    NAMS_BASE_URL: undefined,
  });
});

test("resolves once and writes matching sessions sequentially in source order", async () => {
  await withNamsEnvironment(async () => {
    const nams = createNamsFetchMock()
      .createConversation({ id: "conversation-1" })
      .bulkMessages()
      .reasoningStep({ id: "step-1" })
      .toolCall({ id: "tool-1" });
    let configDiscoveryCalls = 0;
    const matching: ReplayTranscript = {
      sourceSessionId: "session-a",
      projectDirectory: "/project/worktree",
      sourceStartedAt: "2026-08-01T00:00:00.000Z",
      malformedLineCount: 1,
      unsupportedRecordCount: 2,
      records: [
        { kind: "message", role: "user", content: "one" },
        { kind: "message", role: "assistant", content: "two" },
        {
          kind: "tool",
          toolName: "shell",
          input: { command: "pwd", output: "strip" },
          output: "result",
          status: "success",
          reasoningStep: {
            reasoning: "Codex exposed shell from the session transcript.",
            actionTaken: "Ran shell",
          },
        },
        { kind: "message", role: "assistant", content: "three" },
      ],
    };
    const replayAdapter = adapter(
      "codex",
      ["/transcripts/z.jsonl", "/transcripts/a.jsonl", "/transcripts/out.jsonl"],
      {
        "/transcripts/a.jsonl": matching,
        "/transcripts/z.jsonl": {
          ...matching,
          sourceSessionId: "session-z",
          records: [{ kind: "message", role: "user", content: "z" }],
        },
        "/transcripts/out.jsonl": {
          ...matching,
          sourceSessionId: "outside",
          projectDirectory: "/project-old",
        },
      },
      async (receivedEnv) => {
        configDiscoveryCalls += 1;
        assert.equal(receivedEnv, process.env);
        return {};
      },
    );

    const summary = await runReplay({
      adapter: replayAdapter,
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
    });

    assert.equal(configDiscoveryCalls, 1);
    assert.deepEqual(summary, {
      discovered: 3,
      matched: 2,
      imported: 2,
      skipped: 1,
      failed: 0,
      messages: 4,
      toolCalls: 1,
      malformedLines: 3,
      unsupportedRecords: 6,
    });
    assert.deepEqual(nams.requestBodies("createConversation")[0].metadata, {
      harness: "codex",
      projectDirectory: "/project/worktree",
      sourceSessionId: "session-a",
      importSource: "nams-hooks-replay",
      sourceStartedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(
      Object.hasOwn(nams.requestBodies("createConversation")[0].metadata, "title"),
      false,
    );
    assert.deepEqual(
      nams.requestBodies("addMessagesBulk")
        .map((body) => body.messages.map((message: { content: string }) => message.content)),
      [["one", "two"], ["three"], ["z"]],
    );
    assert.deepEqual(nams.requestBodies("addReasoningStep"), [{
      conversationId: "conversation-1",
      reasoning: "Codex exposed shell from the session transcript.",
      actionTaken: "Ran shell",
    }]);
    assert.deepEqual(nams.requestBodies("addToolCall"), [{
      stepId: "step-1",
      toolName: "shell",
      input: "{\"command\":\"pwd\"}",
      output: "result",
      status: "success",
    }]);
    assert.equal(nams.calls("getConversationContext").length, 0);
    assert.equal(nams.calls("searchEntities").length, 0);
  });
});

test("chunks 101 contiguous messages into batches of 100 and one", async () => {
  await withNamsEnvironment(async () => {
    const nams = createNamsFetchMock().createConversation().bulkMessages();
    const records = Array.from({ length: 101 }, (_, index) => ({
      kind: "message" as const,
      role: "user" as const,
      content: `message-${index}`,
    }));

    const summary = await runReplay({
      adapter: adapter("claude", ["/one.jsonl"], { "/one.jsonl": transcript("one", records) }),
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
    });

    assert.deepEqual(nams.requestBodies("addMessagesBulk").map((body) => body.messages.length), [100, 1]);
    assert.equal(summary.messages, 101);
  });
});

test("flushes message batches around tools in timeline order", async () => {
  await withNamsEnvironment(async () => {
    const nams = createNamsFetchMock().createConversation().bulkMessages().reasoningStep().toolCall();
    const progress: string[] = [];

    await runReplay({
      adapter: adapter("codex", ["/one.jsonl"], {
        "/one.jsonl": transcript("one", [
          { kind: "message", role: "user", content: "before" },
          {
            kind: "tool",
            toolName: "shell",
            input: {},
            reasoningStep: { reasoning: "Visible operation", actionTaken: "Ran shell" },
          },
          { kind: "message", role: "assistant", content: "after" },
        ]),
      }),
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
      onProgress: (line) => progress.push(line),
    });

    assert.deepEqual(
      nams.calls().map((call) => new URL(call.url).pathname),
      [
        "/v1/conversations",
        "/v1/conversations/conversation-1/messages/bulk",
        "/v1/reasoning/steps",
        "/v1/reasoning/tool-calls",
        "/v1/conversations/conversation-1/messages/bulk",
      ],
    );
    assert.deepEqual(progress.filter((line) => line.startsWith("  - ")), [
      "  - POST /v1/conversations",
      "  - POST /v1/conversations/{id}/messages/bulk",
      "  - POST /v1/reasoning/steps",
      "  - POST /v1/reasoning/tool-calls",
      "  - POST /v1/conversations/{id}/messages/bulk",
    ]);
  });
});

test("uses live-memory tool sanitization and preserves explicit output", async () => {
  await withNamsEnvironment(async () => {
    const nams = createNamsFetchMock().createConversation().reasoningStep().toolCall();
    const input = {
      command: "x".repeat(5000),
      nested: { tool_output: "secret", responseBody: "secret", keep: true },
    };
    const output = { result: "x".repeat(5000) };

    await runReplay({
      adapter: adapter("claude", ["/one.jsonl"], {
        "/one.jsonl": transcript("one", [{
          kind: "tool",
          toolName: "shell",
          input,
          output,
          reasoningStep: { reasoning: "Visible operation", actionTaken: "Ran shell" },
        }]),
      }),
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
    });

    const body = nams.requestBody("addToolCall");
    assert.equal(body.input, serializeToolInput(input));
    assert.equal(body.input.length, 4000);
    assert.equal(body.output, serializeToolOutput(output));
    assert.ok(body.output.length > 4000);
    assert.equal(body.input.includes("secret"), false);
  });
});

test("omits missing tool output", async () => {
  await withNamsEnvironment(async () => {
    const nams = createNamsFetchMock().createConversation().reasoningStep().toolCall();

    await runReplay({
      adapter: adapter("codex", ["/one.jsonl"], {
        "/one.jsonl": transcript("one", [{
          kind: "tool",
          toolName: "shell",
          input: {},
          reasoningStep: { reasoning: "Visible operation", actionTaken: "Ran shell" },
        }]),
      }),
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
    });

    assert.equal(Object.hasOwn(nams.requestBody("addToolCall"), "output"), false);
  });
});

test("skips unusable cwd, prefix siblings, and eligible empty transcripts", async () => {
  await withNamsEnvironment(async () => {
    const nams = createNamsFetchMock();
    const progress: string[] = [];
    const missing = transcript("missing", [{ kind: "message", role: "user", content: "one" }]);
    delete missing.projectDirectory;

    const summary = await runReplay({
      adapter: adapter("claude", ["/missing", "/relative", "/sibling", "/empty"], {
        "/missing": missing,
        "/relative": transcript("relative", [{ kind: "message", role: "user", content: "one" }], "relative"),
        "/sibling": transcript("sibling", [{ kind: "message", role: "user", content: "one" }], "/project-old"),
        "/empty": transcript("empty", []),
      }),
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
      onProgress: (line) => progress.push(line),
    });

    assert.deepEqual(summary, {
      discovered: 4,
      matched: 1,
      imported: 0,
      skipped: 4,
      failed: 0,
      messages: 0,
      toolCalls: 0,
      malformedLines: 0,
      unsupportedRecords: 0,
    });
    assert.equal(nams.calls("createConversation").length, 0);
    assert.equal(progress.some((line) => line.includes("processing...") || line.startsWith("  - ")), false);
  });
});

test("isolates unreadable transcripts and reads each active transcript once", async () => {
  await withNamsEnvironment(async () => {
    const nams = createNamsFetchMock().createConversation().bulkMessages();
    const reads: string[] = [];
    const progress: string[] = [];
    const replayAdapter: ReplayPlatformAdapter = {
      platform: "codex",
      async discoverTranscripts() { return ["/private/a-secret.jsonl", "/private/b-good.jsonl"]; },
      async readTranscript(transcriptPath) {
        reads.push(transcriptPath);
        if (transcriptPath.endsWith("a-secret.jsonl")) throw new Error("credential at /private/a-secret.jsonl");
        return transcript("good", [{ kind: "message", role: "user", content: "safe" }]);
      },
    };

    const summary = await runReplay({
      adapter: replayAdapter,
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
      onProgress: (line) => progress.push(line),
    });

    assert.deepEqual(reads, ["/private/a-secret.jsonl", "/private/b-good.jsonl"]);
    assert.equal(summary.failed, 1);
    assert.equal(summary.imported, 1);
    assert.equal(progress.some((line) => line.includes("credential at") || line.includes("/private/")), false);
  });
});

test("allows empty discovery after configuration resolution", async () => {
  await withNamsEnvironment(async () => {
    let configCalls = 0;
    let discoveryCalls = 0;
    const summary = await runReplay({
      adapter: {
        platform: "claude",
        async discoverConfig() { configCalls += 1; return {}; },
        async discoverTranscripts() { discoveryCalls += 1; return []; },
        async readTranscript() { throw new Error("not reached"); },
      },
      importRoot: "/missing-corpus",
      sleep: noSleep,
    });

    assert.equal(configCalls, 1);
    assert.equal(discoveryCalls, 1);
    assert.deepEqual(summary, {
      discovered: 0,
      matched: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      messages: 0,
      toolCalls: 0,
      malformedLines: 0,
      unsupportedRecords: 0,
    });
  });
});

test("does not create an unlinked tool call when reasoning has no id", async () => {
  await withNamsEnvironment(async () => {
    const nams = createNamsFetchMock().createConversation().reasoningStep({}).toolCall();
    const summary = await runReplay({
      adapter: adapter("codex", ["/one.jsonl"], {
        "/one.jsonl": transcript("one", [{
          kind: "tool",
          toolName: "shell",
          input: {},
          reasoningStep: { reasoning: "Visible operation", actionTaken: "Ran shell" },
        }]),
      }),
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
    });

    assert.equal(summary.failed, 1);
    assert.equal(summary.toolCalls, 0);
    assert.equal(nams.calls("addToolCall").length, 0);
  });
});

test("retries only a transiently failing tool call after writing reasoning once", async () => {
  await withNamsEnvironment(async () => {
    let attempts = 0;
    const nams = createNamsFetchMock().createConversation().reasoningStep().toolCall(() => {
      attempts += 1;
      return attempts === 1
        ? { status: 503, body: { error: "temporary" } }
        : { status: 201, body: { id: "tool-1" } };
    });
    const delays: number[] = [];

    const summary = await runReplay({
      adapter: adapter("codex", ["/one.jsonl"], {
        "/one.jsonl": transcript("one", [{
          kind: "tool",
          toolName: "shell",
          input: {},
          reasoningStep: { reasoning: "Visible operation", actionTaken: "Ran shell" },
        }]),
      }),
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: async (delay) => { delays.push(delay); },
    });

    assert.equal(summary.failed, 0);
    assert.equal(nams.calls("addReasoningStep").length, 1);
    assert.equal(nams.calls("addToolCall").length, 2);
    assert.deepEqual(delays, [500]);
  });
});

test("keeps successful partial batches counted and continues with later transcripts", async () => {
  await withNamsEnvironment(async () => {
    let bulkCalls = 0;
    const nams = createNamsFetchMock().createConversation().bulkMessages(() => {
      bulkCalls += 1;
      return bulkCalls === 2
        ? { status: 400, body: { error: "bad second batch" } }
        : { status: 201, body: { messages: [] } };
    });
    const firstRecords = Array.from({ length: 101 }, (_, index) => ({
      kind: "message" as const,
      role: "user" as const,
      content: `first-${index}`,
    }));

    const summary = await runReplay({
      adapter: adapter("claude", ["/a.jsonl", "/b.jsonl"], {
        "/a.jsonl": transcript("a", firstRecords),
        "/b.jsonl": transcript("b", [{ kind: "message", role: "user", content: "later" }]),
      }),
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
    });

    assert.equal(bulkCalls, 3);
    assert.deepEqual(summary, {
      discovered: 2,
      matched: 2,
      imported: 1,
      skipped: 0,
      failed: 1,
      messages: 101,
      toolCalls: 0,
      malformedLines: 0,
      unsupportedRecords: 0,
    });
  });
});

test("reports redacted progress and formats a stable summary", async () => {
  await withNamsEnvironment(async () => {
    const nams = createNamsFetchMock().createConversation().bulkMessages();
    const progress: string[] = [];
    const summary = await runReplay({
      adapter: adapter("claude", ["/secret/path.jsonl"], {
        "/secret/path.jsonl": transcript("session-1", [{
          kind: "message",
          role: "user",
          content: "sensitive body",
        }]),
      }),
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
      onProgress: (line) => progress.push(line),
    });

    assert.deepEqual(progress, [
      "Replay claude: starting; {\"configSources\":{\"apiKey\":\"env:NAMS_API_KEY\",\"workspaceId\":\"env:NAMS_WORKSPACE_ID\",\"baseUrl\":\"env:NAMS_BASE_URL\"}}",
      "[1/1] claude session-1: processing...",
      "  - POST /v1/conversations",
      "  - POST /v1/conversations/{id}/messages/bulk",
      "[1/1] claude session-1: imported 1 messages, 0 tools",
    ]);
    assert.equal(progress[4].includes("sensitive body"), false);
    assert.equal(progress[4].includes("/secret/"), false);
    assert.equal(progress[4].includes("key"), false);
    assert.equal(
      formatReplaySummary("claude", summary),
      "Replay claude: discovered 1, matched 1, imported 1, skipped 0, failed 0; messages 1, tools 0, malformed lines 0, unsupported records 0.",
    );
  });
});

test("reports NAMS failure request and response bodies while sanitizing credentials", async () => {
  await withNamsEnvironment(async () => {
    let attempts = 0;
    const nams = createNamsFetchMock().createConversation().bulkMessages(() => {
      attempts += 1;
      return {
        status: 503,
        body: {
          error: "database unavailable",
          requestId: "nams-503",
          apiKey: "super-secret-api-key",
        },
      };
    });
    const progress: string[] = [];

    const summary = await runReplay({
      adapter: adapter("codex", ["/secret/path.jsonl"], {
        "/secret/path.jsonl": transcript("session-1", [{
          kind: "message",
          role: "user",
          content: "sensitive body",
        }]),
      }),
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
      onProgress: (line) => progress.push(line),
    });

    assert.equal(summary.failed, 1);
    assert.equal(attempts, 3);
    assert.deepEqual(progress, [
      "Replay codex: starting; {\"configSources\":{\"apiKey\":\"env:NAMS_API_KEY\",\"workspaceId\":\"env:NAMS_WORKSPACE_ID\",\"baseUrl\":\"env:NAMS_BASE_URL\"}}",
      "[1/1] codex session-1: processing...",
      "  - POST /v1/conversations",
      "  - POST /v1/conversations/{id}/messages/bulk",
      "  - POST /v1/conversations/{id}/messages/bulk",
      "  - POST /v1/conversations/{id}/messages/bulk",
      "[1/1] codex session-1: failed NAMS write failed; HTTP request addMessagesBulk POST /v1/conversations/{id}/messages/bulk; request body {\"messages\":[{\"role\":\"user\",\"content\":\"sensitive body\"}]}; attempts 3; NAMS responses HTTP 503, HTTP 503, HTTP 503; NAMS response body {\"error\":\"database unavailable\",\"requestId\":\"nams-503\",\"apiKey\":\"[REDACTED]\"}",
    ]);
    assert.match(progress[6], /sensitive body|database unavailable|nams-503/);
    assert.doesNotMatch(progress[6], /super-secret-api-key|\/secret\//);
  }, { NAMS_API_KEY: "super-secret-api-key" });
});

test("retries recoverable HTTP failures twice after 500 ms", async () => {
  await withNamsEnvironment(async () => {
    for (const status of [408, 429, 500, 503, 599]) {
      let attempts = 0;
      const nams = createNamsFetchMock().createConversation(() => {
        attempts += 1;
        return attempts <= 2
          ? { status, body: { error: "temporary" } }
          : { status: 201, body: { id: "conversation-1" } };
      }).bulkMessages();
      const delays: number[] = [];
      const summary = await runReplay({
        adapter: adapter("claude", ["/one.jsonl"], {
          "/one.jsonl": transcript("one", [
            { kind: "message", role: "user", content: "one" },
          ]),
        }),
        importRoot: "/project",
        fetch: nams.fetch,
        sleep: async (delay) => { delays.push(delay); },
      });
      assert.equal(summary.failed, 0);
      assert.equal(attempts, 3);
      assert.deepEqual(delays, [500, 500]);
    }
  });
});

test("does not retry other 4xx failures", async () => {
  await withNamsEnvironment(async () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      let attempts = 0;
      const nams = createNamsFetchMock().createConversation(() => {
        attempts += 1;
        return { status, body: { error: "rejected" } };
      });
      const summary = await runReplay({
        adapter: adapter("codex", ["/one.jsonl"], {
          "/one.jsonl": transcript("one", [
            { kind: "message", role: "user", content: "one" },
          ]),
        }),
        importRoot: "/project",
        fetch: nams.fetch,
        sleep: noSleep,
      });
      assert.equal(summary.failed, 1);
      assert.equal(attempts, 1);
    }
  });
});

test("retries a transport TypeError and succeeds on the third attempt", async () => {
  await withNamsEnvironment(async () => {
    let attempts = 0;
    const nams = createNamsFetchMock().createConversation(() => {
      attempts += 1;
      if (attempts <= 2) throw new TypeError("network unavailable");
      return { status: 201, body: { id: "conversation-1" } };
    }).bulkMessages();
    const delays: number[] = [];

    const summary = await runReplay({
      adapter: adapter("claude", ["/one.jsonl"], {
        "/one.jsonl": transcript("one", [{ kind: "message", role: "user", content: "one" }]),
      }),
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: async (delay) => { delays.push(delay); },
    });

    assert.equal(summary.failed, 0);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [500, 500]);
  });
});

test("stops a permanently recoverable response after three attempts", async () => {
  await withNamsEnvironment(async () => {
    let attempts = 0;
    const nams = createNamsFetchMock().createConversation(() => {
      attempts += 1;
      return { status: 503, body: { error: "temporary" } };
    });
    const delays: number[] = [];

    const summary = await runReplay({
      adapter: adapter("codex", ["/one.jsonl"], {
        "/one.jsonl": transcript("one", [{ kind: "message", role: "user", content: "one" }]),
      }),
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: async (delay) => { delays.push(delay); },
    });

    assert.equal(summary.failed, 1);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [500, 500]);
  });
});

test("auto-selects one valid workspace before empty discovery", async () => {
  await withNamsEnvironment(async () => {
    const nams = createNamsFetchMock().workspaces({ workspaces: [{ id: "workspace-auto" }] });
    let discoveries = 0;

    const summary = await runReplay({
      adapter: {
        platform: "claude",
        async discoverTranscripts() { discoveries += 1; return []; },
        async readTranscript() { throw new Error("not reached"); },
      },
      importRoot: "/project",
      fetch: nams.fetch,
      sleep: noSleep,
    });

    assert.equal(nams.calls("listMyWorkspaces").length, 1);
    assert.equal(discoveries, 1);
    assert.equal(summary.discovered, 0);
  }, { NAMS_WORKSPACE_ID: undefined });
});

test("rejects zero or multiple workspaces before transcript discovery", async () => {
  await withNamsEnvironment(async () => {
    for (const fixture of [
      { response: { workspaces: [] }, message: "No NAMS workspace is available for replay" },
      {
        response: { workspaces: [{ id: "one" }, { id: "two" }] },
        message: "NAMS workspace selection is required before replay",
      },
    ]) {
      const nams = createNamsFetchMock().workspaces(fixture.response);
      let discoveries = 0;
      await assert.rejects(
        runReplay({
          adapter: {
            platform: "codex",
            async discoverTranscripts() { discoveries += 1; return []; },
            async readTranscript() { throw new Error("not reached"); },
          },
          importRoot: "/private/import/root",
          fetch: nams.fetch,
          sleep: noSleep,
        }),
        new Error(fixture.message),
      );
      assert.equal(nams.calls("listMyWorkspaces").length, 1);
      assert.equal(discoveries, 0);
    }
  }, { NAMS_WORKSPACE_ID: undefined });
});

test("uses stable path-free discovery and configuration errors", async () => {
  await withNamsEnvironment(async () => {
    await assert.rejects(
      runReplay({
        adapter: {
          platform: "claude",
          async discoverTranscripts() { throw new Error("failed at /secret/transcripts"); },
          async readTranscript() { throw new Error("not reached"); },
        },
        importRoot: "/private/import/root",
        sleep: noSleep,
      }),
      new Error("Unable to discover claude replay transcripts"),
    );
  });

  await withNamsEnvironment(async () => {
    let discoveries = 0;
    await assert.rejects(
      runReplay({
        adapter: {
          platform: "codex",
          async discoverTranscripts() { discoveries += 1; return []; },
          async readTranscript() { throw new Error("not reached"); },
        },
        importRoot: "/private/import/root",
        sleep: noSleep,
      }),
      new Error("NAMS replay configuration unavailable: missing-api-key"),
    );
    assert.equal(discoveries, 0);
  }, { NAMS_API_KEY: undefined });
});
