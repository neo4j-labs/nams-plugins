import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const opencodeUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "platforms", "opencode", "index.js")).href;
const stateUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "session-state.js")).href;

test("initializes OpenCode session state on session.created without creating a conversation", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-opencode-flow-"));
  try {
    const { OpenCodeAdapter } = await import(opencodeUrl);
    const { loadSessionState } = await import(stateUrl);
    const adapter = new OpenCodeAdapter();

    const result = await adapter.startConversation({
      platform: "opencode",
      event: "SessionStart",
      processCwd: projectDir,
      rawPayload: {
        hook: "event",
        directory: projectDir,
        event: {
          type: "session.created",
          properties: {
            info: {
              id: "session-1",
              directory: projectDir,
            },
          },
        },
      },
    });

    assert.deepEqual(result.stdout, { continue: true, suppressOutput: true });
    const state = await loadSessionState(projectDir, "opencode", "session-1");
    assert.notEqual(state, null);
    assert.equal(state.sessionKey, "session-1");
    assert.equal(state.conversationId, undefined);

    const { lines } = await readSingleSessionLog(projectDir);
    assert.equal(lines[0].kind, "hook.event");
    assert.equal(lines[0].harness, "opencode");
    assert.equal(lines[0].event, "SessionStart");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

async function readSingleSessionLog(projectDir) {
  const logDir = path.join(projectDir, ".nams", "logs");
  const logFiles = (await readdir(logDir)).filter((fileName) => /^session-.*\.jsonl$/.test(fileName));
  assert.equal(logFiles.length, 1, `expected one session log file, got ${logFiles.join(", ")}`);
  const log = await readFile(path.join(logDir, logFiles[0]), "utf8");
  return {
    lines: log.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}
