import assert from "node:assert/strict";
import { test } from "node:test";
import { namsReplayProvenanceHeaders } from "../src/runtime/provenance.js";

test("replay provenance identifies the command without simulating a hook event", () => {
  const headers = namsReplayProvenanceHeaders("claude");
  assert.equal(headers["X-NAMS-Hooks-Harness"], "claude");
  assert.equal(headers["X-NAMS-Hooks-Command"], "replay");
  assert.equal(headers["X-NAMS-Hooks-Event"], undefined);
});
