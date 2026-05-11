import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transcriptUrl = pathToFileURL(
  path.join(repoRoot, ".build", "tsc", "platforms", "gemini", "transcript.js"),
).href;

test("reads Gemini transcript messages, thoughts, and tool metadata", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nams-transcript-"));
  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "session-1", kind: "main" }),
        JSON.stringify({ id: "user-1", type: "user", content: [{ text: "Research autonomo" }] }),
        JSON.stringify({ $set: { lastUpdated: "2026-05-11T12:11:51.396Z" } }),
        JSON.stringify({
          id: "gemini-1",
          type: "gemini",
          content: "Final answer",
          thoughts: [
            {
              subject: "Researching",
              description: "Searching official guidance",
              timestamp: "2026-05-11T12:11:55.500Z",
            },
          ],
          tokens: { total: 10 },
          toolCalls: [
            {
              id: "google_web_search_1",
              name: "google_web_search",
              args: { query: "autonomo spain" },
              result: [{ functionResponse: { response: { output: "Do not store this" } } }],
              resultDisplay: "Do not store this either",
              status: "success",
              timestamp: "2026-05-11T12:12:10.860Z",
            },
          ],
        }),
      ].join("\n"),
      "utf8",
    );

    const { readGeminiTranscript } = await import(transcriptUrl);
    const entries = await readGeminiTranscript(transcriptPath);

    assert.deepEqual(entries, [
      { kind: "header", sessionId: "session-1" },
      { kind: "user", id: "user-1", content: "Research autonomo" },
      { kind: "assistant", id: "gemini-1", content: "Final answer" },
      {
        kind: "thought",
        id: "gemini-1:thought:0",
        parentTranscriptEntryId: "gemini-1",
        parentTranscriptEntryIndex: 3,
        subject: "Researching",
        description: "Searching official guidance",
        timestamp: "2026-05-11T12:11:55.500Z",
      },
      {
        kind: "toolCall",
        id: "google_web_search_1",
        parentTranscriptEntryId: "gemini-1",
        parentTranscriptEntryIndex: 3,
        name: "google_web_search",
        args: { query: "autonomo spain" },
        status: "success",
        timestamp: "2026-05-11T12:12:10.860Z",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ignores info records and blank Gemini assistant content", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nams-transcript-"));
  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "info", message: "Do not return this" }),
        JSON.stringify({ id: "gemini-blank", type: "gemini", content: "   " }),
      ].join("\n"),
      "utf8",
    );

    const { readGeminiTranscript } = await import(transcriptUrl);
    const entries = await readGeminiTranscript(transcriptPath);

    assert.deepEqual(entries, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("omits thought id when Gemini transcript entry has no id", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nams-transcript-"));
  try {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: "gemini",
        thoughts: [{ subject: "Planning", description: "Checking the next step" }],
      }),
      "utf8",
    );

    const { readGeminiTranscript } = await import(transcriptUrl);
    const entries = await readGeminiTranscript(transcriptPath);

    assert.deepEqual(entries, [
      {
        kind: "thought",
        parentTranscriptEntryIndex: 0,
        subject: "Planning",
        description: "Checking the next step",
      },
    ]);
    assert.equal(Object.hasOwn(entries[0], "id"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
