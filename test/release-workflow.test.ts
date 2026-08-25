import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("release workflow publishes marketplace dist artifacts to latest", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
  const publishStepStart = workflow.indexOf("      - name: Publish ");
  const nextStepStart =
    publishStepStart === -1 ? -1 : workflow.indexOf("\n      - name: ", publishStepStart + 1);
  const publishStep =
    publishStepStart === -1
      ? ""
      : workflow.slice(publishStepStart, nextStepStart === -1 ? undefined : nextStepStart);

  assert.ok(publishStep, "expected release workflow publish step to be present");
  assert.match(publishStep, /\bcp -R dist-marketplace\/\. "\$release_tree"\/$/m);
  assert.doesNotMatch(publishStep, /\bcp -R dist\/\. "\$release_tree"\/$/m);
});

test("npm release workflow does not execute workflow_run code with write access", async () => {
  const workflow = await readFile(".github/workflows/release-npm.yml", "utf8");

  assert.doesNotMatch(workflow, /^\s+workflow_run:/m);
  assert.doesNotMatch(workflow, /github\.event\.workflow_run/);
  assert.match(
    workflow,
    /^  push:\n    branches-ignore:\n      - latest\n      - "dist\/\*\*"$/m,
  );
});
