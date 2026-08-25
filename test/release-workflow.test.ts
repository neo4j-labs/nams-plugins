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

test("cleanup workflow deletes only dist previews older than 30 days on a daily schedule", async () => {
  const workflow = await readFile(".github/workflows/cleanup.yml", "utf8");

  assert.match(workflow, /schedule:\n\s+- cron: "17 3 \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n\s+contents: write/);
  assert.match(workflow, /date -u -d '30 days ago' \+%s/);
  assert.match(
    workflow,
    /\+refs\/heads\/dist\/\*:refs\/remotes\/origin\/dist\/\*/,
  );
  assert.match(
    workflow,
    /git for-each-ref --format='%\(refname:short\)%09%\(committerdate:unix\)%09%\(objectname\)' refs\/remotes\/origin\/dist\//,
  );
  assert.match(
    workflow,
    /--force-with-lease="refs\/heads\/\$branch:\$expected_sha" origin ":refs\/heads\/\$branch"/,
  );
  assert.doesNotMatch(workflow, /refs\/heads\/latest/);
});

test("cleanup workflow treats only ls-remote status 2 as an empty preview namespace", async () => {
  const workflow = await readFile(".github/workflows/cleanup.yml", "utf8");

  assert.match(
    workflow,
    /ls_remote_status=0\n\s+git ls-remote --exit-code --heads origin 'refs\/heads\/dist\/\*' >\/dev\/null \|\| ls_remote_status=\$\?\n\n\s+case "\$ls_remote_status" in\n\s+0\)\n\s+;;\n\s+2\)\n\s+echo "No dist preview branches found\."\n\s+exit 0\n\s+;;\n\s+\*\)\n\s+echo "::error::git ls-remote failed with status \$\{ls_remote_status\}\." >&2\n\s+exit "\$ls_remote_status"\n\s+;;\n\s+esac/,
  );
});

test("npm distribution workflow publishes only successful push builds and manual branch runs", async () => {
  const workflow = await readFile(".github/workflows/release-npm.yml", "utf8");

  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/heads\/'\)/);
  assert.match(workflow, /!startsWith\(github\.event\.workflow_run\.head_branch, 'dist\/'\)/);
  assert.doesNotMatch(workflow, /workflow_run:\n(?:.|\n)*?branches:\n\s+- devel/);
});

test("npm distribution workflow publishes dist under dist bin without tags or releases", async () => {
  const workflow = await readFile(".github/workflows/release-npm.yml", "utf8");
  const publishStep = extractPublishStep(workflow);

  assert.ok(publishStep, "expected npm distribution publish step to be present");
  assert.match(publishStep, /RELEASE_SOURCE_BRANCH:.*head_branch.*github\.ref_name/);
  assert.match(publishStep, /RELEASE_REF="dist\/bin\/\$RELEASE_SOURCE_BRANCH"/);
  assert.match(publishStep, /\bcp -R dist\/\. "\$release_tree"\/$/m);
  assert.doesNotMatch(publishStep, /\bcp -R dist-marketplace\/\. "\$release_tree"\/$/m);
  assert.doesNotMatch(publishStep, /\bcp -R dist-local\/\. "\$release_tree"\/$/m);
  assert.doesNotMatch(publishStep, /publish_release_tag|publish_github_release|gh release/);
});

test("cleanup namespace covers npm distribution branches", async () => {
  const releaseWorkflow = await readFile(".github/workflows/release-npm.yml", "utf8");
  const cleanupWorkflow = await readFile(".github/workflows/cleanup.yml", "utf8");

  assert.match(releaseWorkflow, /RELEASE_REF="dist\/bin\/\$RELEASE_SOURCE_BRANCH"/);
  assert.match(
    cleanupWorkflow,
    /\+refs\/heads\/dist\/\*:refs\/remotes\/origin\/dist\/\*/,
  );
  assert.match(cleanupWorkflow, /refs\/remotes\/origin\/dist\//);
});
