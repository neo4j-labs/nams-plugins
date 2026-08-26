import assert from "node:assert/strict";
import { test } from "node:test";
import { namsReplayProvenanceHeaders } from "../src/runtime/provenance.js";

test("Codex replay provenance identifies the command without a hook event", () => {
  const headers = namsReplayProvenanceHeaders();
  assert.equal(headers["X-NAMS-Hooks-Harness"], "codex");
  assert.equal(headers["X-NAMS-Hooks-Command"], "replay");
  assert.equal(headers["X-NAMS-Hooks-Event"], undefined);
});
