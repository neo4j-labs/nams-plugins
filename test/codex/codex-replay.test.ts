import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  codexReplayAdapter,
  discoverCodexReplayTranscripts,
  readCodexReplayTranscript,
} from "../../src/platforms/codex/replay.js";

test("discovers active archived and subagent Codex rollouts", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-replay-"));
  try {
    const active = path.join(fixture, "sessions", "2026", "08", "rollout-b.jsonl");
    const child = path.join(fixture, "sessions", "2026", "08", "subagents", "rollout-a.jsonl");
    const archived = path.join(fixture, "archived_sessions", "rollout-c.jsonl");
    const defaultTranscript = path.join(fixture, "home", ".codex", "sessions", "rollout-default.jsonl");
    await mkdir(path.dirname(active), { recursive: true });
    await mkdir(path.dirname(child), { recursive: true });
    await mkdir(path.dirname(archived), { recursive: true });
    await mkdir(path.dirname(defaultTranscript), { recursive: true });
    await Promise.all([active, child, archived, defaultTranscript].map((file) => writeFile(file, "{}\n", "utf8")));
    assert.deepEqual(await discoverCodexReplayTranscripts({ CODEX_HOME: fixture }), [archived, child, active].sort());
    assert.deepEqual(await discoverCodexReplayTranscripts({ HOME: path.join(fixture, "home") }), [defaultTranscript]);
    assert.equal(codexReplayAdapter.platform, "codex");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("normalizes Codex messages and canonical tool variants without reasoning", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-replay-"));
  try {
    const transcriptPath = path.join(fixture, "rollout-fallback.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({
        timestamp: "2026-08-02T09:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-session-1", cwd: "/workspaces/nams-hooks/worktrees/replay", timestamp: "2026-08-02T09:00:00.000Z", source: { subagent: "review" } },
      }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Import this." }, { type: "input_image", text: "do not import", image_url: "data:image/png;base64,skip" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Running shell." }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "shell", arguments: "{\"command\":\"pwd\",\"output\":\"strip\"}" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "exec_command_end", call_id: "call-1", output: "mirror" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: { content: "/workspaces/nams-hooks", success: true } } }),
      JSON.stringify({ type: "response_item", payload: { type: "web_search_call", id: "web-1", status: "completed", action: { type: "search", query: "NAMS" } } }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ text: "private" }], encrypted_content: "ciphertext" } }),
      JSON.stringify({ type: "compacted", payload: { message: "private summary" } }),
      "{malformed",
    ].join("\n"), "utf8");

    const transcript = await readCodexReplayTranscript(transcriptPath);
    assert.equal(transcript.sourceSessionId, "codex-session-1");
    assert.equal(transcript.projectDirectory, path.normalize("/workspaces/nams-hooks/worktrees/replay"));
    assert.equal(transcript.sourceStartedAt, "2026-08-02T09:00:00.000Z");
    assert.equal(transcript.malformedLineCount, 1);
    assert.deepEqual(transcript.records, [
      { kind: "message", role: "user", content: "Import this." },
      { kind: "message", role: "assistant", content: "Running shell." },
      {
        kind: "tool",
        toolName: "shell",
        input: { command: "pwd", output: "strip" },
        output: { content: "/workspaces/nams-hooks", success: true },
        status: "success",
        reasoningStep: {
          reasoning: "Codex exposed shell from the session transcript.",
          actionTaken: "Ran shell",
          result: "Codex transcript recorded status: success.",
        },
      },
      {
        kind: "tool",
        toolName: "web_search",
        input: { type: "search", query: "NAMS" },
        status: "completed",
        reasoningStep: {
          reasoning: "Codex exposed web_search from the session transcript.",
          actionTaken: "Ran web_search",
          result: "Codex transcript recorded status: completed.",
        },
      },
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("does not replace an unusable first Codex cwd with a later cwd", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-replay-"));
  try {
    const transcriptPath = path.join(fixture, "rollout.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "relative", id: "session-1" } }),
      JSON.stringify({ type: "turn_context", payload: { cwd: "/later/absolute" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "keep parsed content" } }),
    ].join("\n"), "utf8");
    const transcript = await readCodexReplayTranscript(transcriptPath);
    assert.equal(transcript.projectDirectory, undefined);
    assert.equal(transcript.records.length, 1);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("normalizes remaining canonical Codex tool shapes and ignores orphan outputs", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-replay-"));
  try {
    const transcriptPath = path.join(fixture, "rollout-tools.jsonl");
    const responseItem = (payload: Record<string, unknown>) => JSON.stringify({ type: "response_item", payload });
    await writeFile(transcriptPath, [
      JSON.stringify({ type: "session_meta", payload: { id: "tools", cwd: "/project" } }),
      responseItem({ type: "custom_tool_call", call_id: "custom-1", namespace: "apps", name: "render", input: "raw input", status: "in_progress" }),
      responseItem({ type: "custom_tool_call_output", call_id: "custom-1", output: { content: "done", success: false } }),
      responseItem({ type: "local_shell_call", call_id: "shell-1", status: "completed", action: { type: "exec", command: ["pwd"] }, duration_ms: 12 }),
      responseItem({ type: "tool_search_call", call_id: "search-1", status: "in_progress", execution: "client", arguments: { query: "diagram" } }),
      responseItem({ type: "tool_search_output", call_id: "search-1", status: "completed", execution: "client", tools: [{ name: "imagegen" }] }),
      responseItem({ type: "image_generation_call", id: "image-1", status: "completed", revised_prompt: "A graph", result: "base64-result" }),
      responseItem({ type: "function_call_output", call_id: "orphan", output: "ignore" }),
      responseItem({ type: "function_call", call_id: "unmatched", name: "shell", arguments: "{}" }),
    ].join("\n"), "utf8");

    const tools = (await readCodexReplayTranscript(transcriptPath)).records.filter((record) => record.kind === "tool");
    assert.equal(tools.length, 5);
    assert.deepEqual(tools.map(({ reasoningStep: _step, ...tool }) => tool), [
      { kind: "tool", toolName: "render", input: { namespace: "apps", input: "raw input" }, output: { content: "done", success: false }, status: "error" },
      { kind: "tool", toolName: "local_shell", input: { type: "exec", command: ["pwd"] }, status: "completed", durationMs: 12 },
      { kind: "tool", toolName: "tool_search", input: { execution: "client", arguments: { query: "diagram" } }, output: [{ name: "imagegen" }], status: "completed" },
      { kind: "tool", toolName: "image_generation", input: { revisedPrompt: "A graph" }, output: "base64-result", status: "completed" },
      { kind: "tool", toolName: "shell", input: {} },
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
