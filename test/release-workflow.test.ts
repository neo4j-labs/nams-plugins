import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

function extractPublishStep(workflow: string): string {
  const publishStepStart = workflow.indexOf("      - name: Publish ");
  const nextStepStart =
    publishStepStart === -1 ? -1 : workflow.indexOf("\n      - name: ", publishStepStart + 1);

  return publishStepStart === -1
    ? ""
    : workflow.slice(publishStepStart, nextStepStart === -1 ? undefined : nextStepStart);
}

test("build workflow verifies every source branch without rebuilding generated branches", async () => {
  const workflow = await readFile(".github/workflows/build.yml", "utf8");

  assert.match(
    workflow,
    /push:\n\s+branches-ignore:\n\s+- latest\n\s+- "dist\/\*\*"/,
  );
  assert.doesNotMatch(workflow, /push:\n\s+branches:\n\s+- devel/);
});

test("release workflow publishes only successful push builds and manual branch runs", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");

  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/heads\/'\)/);
  assert.match(workflow, /!startsWith\(github\.event\.workflow_run\.head_branch, 'dist\/'\)/);
  assert.doesNotMatch(workflow, /workflow_run:\n(?:.|\n)*?branches:\n\s+- devel/);
});

test("release workflow maps devel to latest and other branches under dist", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
  const publishStep = extractPublishStep(workflow);

  assert.ok(publishStep, "expected release workflow publish step to be present");
  assert.match(publishStep, /RELEASE_SOURCE_BRANCH:.*head_branch.*github\.ref_name/);
  assert.match(
    publishStep,
    /if \[\[ "\$RELEASE_SOURCE_BRANCH" == "devel" \]\]; then\n\s+RELEASE_REF="latest"\n\s+else\n\s+RELEASE_REF="dist\/\$RELEASE_SOURCE_BRANCH"/,
  );
});

test("release workflow publishes marketplace artifacts and reserves releases for latest", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
  const publishStep = extractPublishStep(workflow);

  assert.ok(publishStep, "expected release workflow publish step to be present");
  assert.match(publishStep, /\bcp -R dist-marketplace\/\. "\$release_tree"\/$/m);
  assert.doesNotMatch(publishStep, /\bcp -R dist\/\. "\$release_tree"\/$/m);
  assert.match(
    publishStep,
    /if \[\[ "\$RELEASE_REF" == "latest" \]\]; then\n\s+publish_release_tag\n\s+publish_github_release\n\s+fi/,
  );
});
