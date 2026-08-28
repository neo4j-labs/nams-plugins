import assert from "node:assert/strict";
import { test } from "node:test";
import {
  namsClaudeReplayProvenanceHeaders,
  namsReplayProvenanceHeaders,
} from "../src/runtime/provenance.js";

test("Codex replay provenance identifies the command without a hook event", () => {
  const headers = namsReplayProvenanceHeaders();
  assert.equal(headers["X-NAMS-Hooks-Harness"], "codex");
  assert.equal(headers["X-NAMS-Hooks-Command"], "replay");
  assert.equal(headers["X-NAMS-Hooks-Event"], undefined);
});

test("Claude replay provenance is separate from Codex replay provenance", () => {
  const headers = namsClaudeReplayProvenanceHeaders();
  assert.equal(headers["X-NAMS-Hooks-Harness"], "claude");
  assert.equal(headers["X-NAMS-Hooks-Command"], "replay");
  assert.equal(headers["X-NAMS-Hooks-Event"], undefined);
  assert.equal(namsReplayProvenanceHeaders()["X-NAMS-Hooks-Harness"], "codex");
});
