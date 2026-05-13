import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const transcriptUrl = pathToFileURL(
  path.join(repoRoot, ".build", "tsc", "platforms", "codex", "transcript.js"),
).href;

test("reads Codex user and assistant messages from nested response items", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nams-codex-transcript-"));
  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        "",
        JSON.stringify({
          item: {
            type: "response_item",
            item: {
              id: "user-1",
              type: "message",
              role: "user",
              content: [{ text: "Remember this requirement." }],
            },
          },
        }),
        JSON.stringify({
          item: {
            type: "response_item",
            item: {
              id: "assistant-1",
              type: "message",
              role: "assistant",
              content: [{ text: "I will keep the parser conservative." }],
            },
          },
        }),
        JSON.stringify({
          type: "response_item",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Compacted summary should not be stored." }],
          },
          summary: "conversation compacted",
        }),
      ].join("\n"),
      "utf8",
    );

    const { readCodexTranscript } = await import(transcriptUrl);
    const entries = await readCodexTranscript(transcriptPath);

    assert.deepEqual(entries, [
      { kind: "user", id: "user-1", content: "Remember this requirement." },
      { kind: "assistant", id: "assistant-1", content: "I will keep the parser conservative." },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reads Codex messages from root response items", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nams-codex-transcript-"));
  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: "response_item",
        item: {
          id: "assistant-root",
          type: "message",
          role: "assistant",
          content: "  Root response works.  ",
        },
      }),
      "utf8",
    );

    const { readCodexTranscript } = await import(transcriptUrl);
    const entries = await readCodexTranscript(transcriptPath);

    assert.deepEqual(entries, [{ kind: "assistant", id: "assistant-root", content: "Root response works." }]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ignores developer system blank and unsupported Codex messages", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nams-codex-transcript-"));
  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "response_item",
          item: { id: "developer-1", type: "message", role: "developer", content: "Do not store." },
        }),
        JSON.stringify({
          type: "response_item",
          item: { id: "system-1", type: "message", role: "system", content: "Do not store." },
        }),
        JSON.stringify({
          type: "response_item",
          item: { id: "blank-1", type: "message", role: "user", content: "   " },
        }),
        JSON.stringify({
          type: "response_item",
          item: { id: "tool-1", type: "function_call", name: "shell", arguments: "{}" },
        }),
        JSON.stringify({
          type: "response_item",
          item: { id: "reasoning-1", type: "reasoning", summary: [{ text: "Do not infer." }] },
        }),
        JSON.stringify({ type: "event_msg", msg: "unsupported" }),
      ].join("\n"),
      "utf8",
    );

    const { readCodexTranscript } = await import(transcriptUrl);
    const entries = await readCodexTranscript(transcriptPath);

    assert.deepEqual(entries, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("joins multiple Codex text parts and omits blank ids", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nams-codex-transcript-"));
  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: "response_item",
        item: {
          id: "  ",
          type: "message",
          role: "user",
          content: [{ text: "First line" }, { type: "image", image_url: "file:///tmp/skip.png" }, { text: "Second line" }],
        },
      }),
      "utf8",
    );

    const { readCodexTranscript } = await import(transcriptUrl);
    const entries = await readCodexTranscript(transcriptPath);

    assert.deepEqual(entries, [{ kind: "user", content: "First line\nSecond line" }]);
    assert.equal(Object.hasOwn(entries[0], "id"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
