# Npm Dist Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Publish the validated npm/npx distribution from dist/ for every source branch to dist/bin/<source-branch> through a separate GitHub Actions workflow.

**Architecture:** Keep the existing Release workflow dedicated to plugin marketplace artifacts. Add an independent write-enabled Release npm distribution workflow that consumes the same successful push-triggered Build runs and explicit source-branch dispatches, rebuilds and validates all package projections, then replaces dist/bin/<source-branch> with the contents of dist/. The existing cleanup workflow already enumerates dist/** and therefore expires these generated branches under the same 30-day policy.

**Tech Stack:** GitHub Actions YAML, Bash, Node.js 24, Node's built-in node:test runner.

## Global Constraints

- The existing .github/workflows/release.yml remains the plugin marketplace publisher.
- Every source branch named <branch>, including devel, publishes validated dist/ artifacts to dist/bin/<branch>.
- The npm distribution branch contains the contents of dist/ at its root so its package.json and bin/cli.js are directly usable as an npm/npx Git dependency.
- The npm distribution workflow runs only for successful push-triggered Build runs and explicit source-branch dispatches.
- Pull-request Builds must not publish npm distribution artifacts.
- Generated latest and dist/** branches must not trigger source Builds or either Release workflow recursively.
- Npm distribution branches do not create or update Git tags or GitHub Releases.
- The existing daily cleanup covers dist/bin/** and deletes those branches when their tip commit is older than 30 days.
- Publish dist/ in the new workflow; do not publish dist-marketplace/ or dist-local/.
- Keep the workflows free of new runtime or development dependencies.
- The dist/bin/** namespace is reserved for npm distribution branches. Source branches named bin or bin/** are not supported because their marketplace preview refs would collide with npm distribution refs.
- The workflow_run listener becomes active only after the new workflow file is present on the default devel branch.

---

### Task 1: Define Npm Distribution Workflow Contracts

**Files:**
- Modify: test/release-workflow.test.ts

**Interfaces:**
- Consumes: .github/workflows/release-npm.yml and .github/workflows/cleanup.yml as UTF-8 text.
- Produces: regression coverage for release eligibility, source-to-generated-branch mapping, dist-only publication, absence of tag/release operations, and cleanup namespace coverage.

- [x] **Step 1: Append failing npm distribution workflow tests**

Append these tests to test/release-workflow.test.ts:

~~~ts
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
~~~

- [x] **Step 2: Run the focused workflow contracts to verify RED**

Run:

~~~bash
node --import=tsx --test test/release-workflow.test.ts
~~~

Expected: FAIL. The existing six contracts pass and the three new contracts fail with ENOENT because .github/workflows/release-npm.yml does not exist.

- [x] **Step 3: Commit the failing contracts**

Run:

~~~bash
git add test/release-workflow.test.ts
git commit -m "test: define npm dist release behavior"
~~~

### Task 2: Publish Npm Distribution Per Source Branch

**Files:**
- Create: .github/workflows/release-npm.yml

**Interfaces:**
- Consumes: successful push-triggered Build workflow runs and manually dispatched source-branch refs.
- Produces: dist/bin/<source-branch> containing the validated contents of dist/ at the branch root.

- [x] **Step 1: Create the npm distribution workflow**

Create .github/workflows/release-npm.yml with:

~~~yaml
name: Release npm distribution

on:
  workflow_run:
    workflows:
      - Build
    types:
      - completed
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: release-npm-${{ github.event.workflow_run.head_branch || github.ref_name }}
  cancel-in-progress: false

jobs:
  publish:
    name: Publish generated npm distribution branch
    runs-on: ubuntu-latest
    if: >-
      (github.event_name == 'workflow_dispatch' &&
       startsWith(github.ref, 'refs/heads/') &&
       github.ref != 'refs/heads/latest' &&
       !startsWith(github.ref, 'refs/heads/dist/')) ||
      (github.event_name == 'workflow_run' &&
       github.event.workflow_run.conclusion == 'success' &&
       github.event.workflow_run.event == 'push' &&
       github.event.workflow_run.head_branch != 'latest' &&
       !startsWith(github.event.workflow_run.head_branch, 'dist/'))

    steps:
      - name: Check out repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.workflow_run.head_sha || github.sha }}

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run default checks
        run: npm run check

      - name: Build and verify release artifacts
        run: npm run package:check

      - name: Publish npm dist branch
        shell: bash
        env:
          RELEASE_SOURCE_BRANCH: ${{ github.event.workflow_run.head_branch || github.ref_name }}
          RELEASE_SOURCE_SHA: ${{ github.event.workflow_run.head_sha || github.sha }}
        run: |
          set -euo pipefail

          RELEASE_REF="dist/bin/$RELEASE_SOURCE_BRANCH"
          release_tree="$(mktemp -d)"
          cp -R dist/. "$release_tree"/

          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

          git fetch origin "refs/heads/$RELEASE_REF:refs/remotes/origin/$RELEASE_REF" || true
          if git rev-parse --verify "origin/$RELEASE_REF" >/dev/null 2>&1; then
            git switch --track -c "$RELEASE_REF" "origin/$RELEASE_REF"
          else
            git switch --orphan "$RELEASE_REF"
          fi

          find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
          cp -R "$release_tree"/. .
          git add -A

          git commit \
            --allow-empty \
            -m "chore: publish $RELEASE_REF artifacts from $RELEASE_SOURCE_SHA"
          git push origin "HEAD:refs/heads/$RELEASE_REF"
~~~

- [x] **Step 2: Run the focused workflow contracts to verify GREEN**

Run:

~~~bash
node --import=tsx --test test/release-workflow.test.ts
~~~

Expected: PASS with nine passing workflow contract tests.

- [x] **Step 3: Review the workflow boundary**

Run:

~~~bash
git diff --check
git diff -- .github/workflows/release-npm.yml test/release-workflow.test.ts
~~~

Expected: no whitespace errors. The workflow accepts only successful push Builds or explicit source-branch dispatches, always maps to dist/bin/<source-branch>, copies only dist/, and contains no tag or GitHub Release operations.

- [x] **Step 4: Run the full repository check**

Run:

~~~bash
npm run check
~~~

Expected: PASS with all tests green.

- [x] **Step 5: Commit the workflow**

Run:

~~~bash
git add .github/workflows/release-npm.yml
git commit -m "ci: publish npm dist per source branch"
~~~

### Task 3: Record the Npm Distribution Release Channel

**Files:**
- Modify: docs/superpowers/specs/2026-05-10-nams-hooks-design.md
- Modify: AGENTS.md
- Create: docs/plans/0004-npm-dist-release.md

**Interfaces:**
- Consumes: the npm distribution workflow implemented in Task 2.
- Produces: an architectural branch model and repository guidance distinguishing plugin marketplace branches from npm/npx distribution branches.

- [x] **Step 1: Expand the design branch model**

In docs/superpowers/specs/2026-05-10-nams-hooks-design.md, replace the Branch model list and the following source-artifact paragraph with:

~~~markdown
Branch model:

- devel: main source branch containing TypeScript source, templates, docs, the pinned OpenAPI spec, the custom generator, and committed generated TypeScript client source.
- latest: generated stable plugin marketplace branch containing validated dist-marketplace/ artifacts built from devel.
- dist/<source-branch>: generated preview plugin marketplace branch containing validated dist-marketplace/ artifacts built from a non-devel source branch. Nested source branch names are preserved, so feature/foo publishes to dist/feature/foo.
- dist/bin/<source-branch>: generated npm/npx distribution branch containing validated dist/ artifacts built from any source branch, including devel. Nested names are preserved, so feature/foo publishes to dist/bin/feature/foo.

The dist/bin/** namespace is reserved for npm distribution branches. Source branches named bin or bin/** are not supported because their plugin marketplace target would collide with an npm distribution target.

On source branches, dist/, dist-marketplace/, and dist-local/ are generated and ignored. npm run dist builds all three trees through the split projection scripts: build-dist-npm.mjs, build-dist-marketplace.mjs, and build-dist-local.mjs, with shared helpers in build-dist-common.mjs. dist/ is the npm package artifact and is published to dist/bin/<source-branch>. dist-marketplace/ is the self-contained plugin marketplace release tree for Gemini, Claude Code, Codex, and OpenCode and is published to latest or dist/<source-branch>. dist-local/ contains project-local configurations that call an installed nams-hooks executable and remains a source-branch verification artifact only.
~~~

- [x] **Step 2: Expand the manual and CI release flow**

Replace the Manual or CI release flow and Rules lists with:

~~~markdown
Manual or CI release flow:

1. Work on devel or another source branch.
2. Run npm run openapi:fetch when the NAMS contract needs refreshing.
3. Run npm run openapi:generate.
4. Commit docs/nams-openapi.json and src/generated/nams-client.ts if they changed.
5. Run package verification.
6. Run release preparation to create the npm, marketplace, and local verification trees.
7. Replace the plugin target branch with validated dist-marketplace/ contents: latest for devel, or dist/<source-branch> for another source branch.
8. Replace dist/bin/<source-branch> with the validated dist/ contents for every source branch, including devel.
9. Commit each generated artifact tree on its target branch.
10. When the plugin target is latest, force-update the latest tag and recreate the GitHub Release named latest.

Rules:

- Generated release artifacts are produced from source branches; no hand edits.
- Successful push-triggered Builds start two independent publishers: plugin marketplace artifacts go from devel to latest or from another source branch to dist/<source-branch>, while npm artifacts go from every source branch to dist/bin/<source-branch>.
- Pull-request Builds never publish artifacts.
- Generated latest and dist/** branches do not trigger Build or Release again.
- The workflow_run publishers become active only after their workflow files are present on the default devel branch.
- A daily UTC cleanup removes generated dist/** branches, including dist/bin/**, whose tip commit is older than 30 days. The cleanup does not target latest or source branches and may also be run through manual dispatch.
- The latest release tag and GitHub Release are created only by the plugin marketplace publisher for latest.
- Npm distribution branches do not create tags or GitHub Releases.
- The dist/bin/** namespace is reserved for npm distribution artifacts; source branches named bin or bin/** are not supported.
- Gemini stable installs use --ref latest; plugin preview validation uses the corresponding dist/<source-branch> ref.
- The package rooted at dist/bin/<source-branch> is the npx-consumable npm distribution for that source branch.
- Codex, Claude, Gemini, and OpenCode plugin marketplace artifacts are produced from the same validated dist-marketplace/ tree.
- dist-local/ remains a verification artifact on source branches and is not copied to generated release branches.
- npm run package:check must verify all generated artifacts: npm package output in dist/, self-contained marketplace output in dist-marketplace/, local project configuration output in dist-local/, and npm dry-run package contents.
~~~

- [x] **Step 3: Update the approval record**

Replace the final approval-record branch decision with:

~~~markdown
- Use devel as the main source branch. Publish validated dist-marketplace/ artifacts to latest from devel and to dist/<source-branch> from non-devel source branches. Publish validated dist/ npm artifacts from every source branch to dist/bin/<source-branch>. Keep dist-local/ as a generated verification artifact on source branches.
~~~

- [x] **Step 4: Align repository agent guidance**

Replace the Build And Distribution bullet list in AGENTS.md with:

~~~markdown
## Build And Distribution

- devel is the main source branch.
- devel publishes validated dist-marketplace/ plugin artifacts to the generated latest branch.
- Every other source branch <branch> publishes validated dist-marketplace/ plugin artifacts to the generated dist/<branch> branch.
- Every source branch <branch>, including devel, publishes validated dist/ npm artifacts to the generated dist/bin/<branch> branch.
- The dist/bin/** namespace is reserved for npm distribution artifacts; do not use bin or bin/** as source branch names.
- Generated latest and dist/** branches do not trigger another build or release.
- GitHub Actions runs a daily cleanup that deletes generated dist/** branches, including dist/bin/**, whose tip commit is older than 30 days; it never targets latest or source branches.
- dist/, dist-marketplace/, and dist-local/ are generated and ignored on source branches.
- npm run build compiles TypeScript into .build/tsc for local verification.
- npm run dist creates npm, marketplace, and local projections under dist/, dist-marketplace/, and dist-local/.
- In generated artifacts, compiled runtime files live under the target's bin/ tree.
- Marketplace and local root files are produced from templates/marketplace/ and templates/local/.
- Do not hand-edit generated distribution output as a source change.
- GitHub Actions Build runs on pull requests, pushes to all source branches, and manual dispatch. It excludes generated latest and dist/** branches and runs npm run check.
- GitHub Actions Release publishes plugin marketplace artifacts only after successful push-triggered Builds or explicit source-branch dispatches.
- GitHub Actions Release npm distribution publishes dist/ only after successful push-triggered Builds or explicit source-branch dispatches.
- Pull-request Builds never publish artifacts.
- Only devel plugin publishing updates the latest tag and GitHub Release; plugin previews and npm distribution publishing update branches only.
- workflow_run-based publishers must be present on the default devel branch before they can trigger automatically.
~~~

- [x] **Step 5: Verify the complete change**

Run:

~~~bash
npm run check
git diff --check
git status --short
~~~

Expected: npm run check passes, git diff --check reports no errors, and status lists only the intended workflow, workflow test, design, agent-guidance, and plan changes plus pre-existing unrelated user files.

- [x] **Step 6: Mark the plan complete and commit the release model**

Mark every completed checkbox in this plan [x], then run:

~~~bash
git add AGENTS.md docs/superpowers/specs/2026-05-10-nams-hooks-design.md docs/plans/0004-npm-dist-release.md
git commit -m "docs: define npm dist release channel"
~~~
