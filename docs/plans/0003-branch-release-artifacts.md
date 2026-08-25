# Branch Release Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish validated `dist-marketplace/` artifacts from `devel` to `latest`, publish artifacts from every other source branch to `dist/<source-branch>`, and remove stalled generated preview branches after 30 days.

**Architecture:** Expand the Build workflow to verify pushes from every source branch while excluding generated release branches. Let the Release workflow consume successful push-triggered Build runs, derive one target branch from the source branch, and retain tag/GitHub Release updates only for the `latest` target. Keep pull-request Build runs read-only and ineligible for publishing. Add a separate daily cleanup workflow that measures each `dist/**` branch tip's commit time and deletes previews whose last generated commit is more than 30 days old.

**Tech Stack:** GitHub Actions YAML, Bash, Node.js 24, Node's built-in `node:test` runner.

## Global Constraints

- `devel` is the main source branch and publishes generated marketplace artifacts to `latest`.
- A non-`devel` source branch named `<branch>` publishes generated marketplace artifacts to `dist/<branch>`.
- Generated branches `latest` and `dist/**` must not trigger source builds or recursive releases.
- Pull-request builds must not trigger the write-enabled Release job.
- Only `latest` receives the force-updated `latest` tag and recreated GitHub Release.
- A daily cleanup deletes only `dist/**` branches whose tip commit is older than 30 days; it never deletes `latest` or source branches.
- Publish `dist-marketplace/`; do not publish `dist/` or `dist-local/`.
- Do not hand-edit generated distribution output.
- Keep the workflows free of new runtime or development dependencies.

---

### Task 1: Define Branch-Aware Workflow Contracts

**Files:**
- Modify: `test/release-workflow.test.ts`

**Interfaces:**
- Consumes: `.github/workflows/build.yml` and `.github/workflows/release.yml` as UTF-8 text.
- Produces: regression coverage for source-branch build triggers, release eligibility, target-branch mapping, marketplace artifact selection, and latest-only tag/release behavior.

- [x] **Step 1: Replace the release workflow test with branch-aware failing tests**

Replace `test/release-workflow.test.ts` with:

```ts
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
```

- [x] **Step 2: Run the workflow contract tests to verify they fail**

Run:

```bash
node --import=tsx --test test/release-workflow.test.ts
```

Expected: FAIL because Build is restricted to `devel`, Release is restricted to `devel`, and the publish script has no `dist/<source-branch>` mapping or latest-only release guard.

- [x] **Step 3: Commit the failing workflow contracts**

```bash
git add test/release-workflow.test.ts
git commit -m "test: define branch release workflow behavior"
```

### Task 2: Publish Generated Artifacts Per Source Branch

**Files:**
- Modify: `.github/workflows/build.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: successful push-triggered `Build` workflow runs and manually dispatched source-branch refs.
- Produces: `latest` from `devel`, `dist/<source-branch>` from other source branches, and a GitHub tag/release only for `latest`.

- [x] **Step 1: Make Build run on all source branches**

In `.github/workflows/build.yml`, replace:

```yaml
  push:
    branches:
      - devel
```

with:

```yaml
  push:
    branches-ignore:
      - latest
      - "dist/**"
```

This keeps pull-request and manual builds unchanged while preventing generated branches from recursively entering the Build-to-Release chain.

- [x] **Step 2: Replace the Release workflow with branch-aware publishing**

Replace `.github/workflows/release.yml` with:

```yaml
name: Release

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
  group: release-${{ github.event.workflow_run.head_branch || github.ref_name }}
  cancel-in-progress: false

jobs:
  publish:
    name: Publish generated release branch
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

      - name: Publish generated release branch
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          RELEASE_SOURCE_BRANCH: ${{ github.event.workflow_run.head_branch || github.ref_name }}
          RELEASE_SOURCE_SHA: ${{ github.event.workflow_run.head_sha || github.sha }}
        run: |
          set -euo pipefail

          if [[ "$RELEASE_SOURCE_BRANCH" == "devel" ]]; then
            RELEASE_REF="latest"
          else
            RELEASE_REF="dist/$RELEASE_SOURCE_BRANCH"
          fi

          release_tree="$(mktemp -d)"
          cp -R dist-marketplace/. "$release_tree"/
          release_asset_dir="$(mktemp -d)"
          release_asset="$release_asset_dir/nams-plugins.tar.gz"
          tar -czf "$release_asset" -C "$release_tree" .

          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

          publish_release_tag() {
            git tag -f "$RELEASE_REF"
            git push --force origin "refs/tags/$RELEASE_REF"
          }

          publish_github_release() {
            local notes="Generated release artifacts from ${RELEASE_SOURCE_SHA}."
            gh release delete "$RELEASE_REF" --yes || true
            gh release create "$RELEASE_REF" "$release_asset" \
              --title "$RELEASE_REF" \
              --notes "$notes" \
              --latest \
              --verify-tag
          }

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
            -m "chore: publish ${RELEASE_REF} artifacts from ${RELEASE_SOURCE_SHA}" \
            -m "Co-authored-by: Codex <codex@openai.com>"
          git push origin "HEAD:refs/heads/$RELEASE_REF"

          if [[ "$RELEASE_REF" == "latest" ]]; then
            publish_release_tag
            publish_github_release
          fi
```

- [x] **Step 3: Run the workflow contract tests to verify they pass**

Run:

```bash
node --import=tsx --test test/release-workflow.test.ts
```

Expected: PASS with four passing workflow contract tests.

- [x] **Step 4: Review the workflow diff for event and token boundaries**

Run:

```bash
git diff --check
git diff -- .github/workflows/build.yml .github/workflows/release.yml test/release-workflow.test.ts
```

Expected: no whitespace errors; the diff shows push builds for all non-generated branches, publishing only after successful push Builds or explicit branch dispatches, and latest-only tag/GitHub Release updates.

- [x] **Step 5: Commit the branch-aware workflows**

```bash
git add .github/workflows/build.yml .github/workflows/release.yml
git commit -m "ci: publish artifacts per source branch"
```

### Task 3: Record the Expanded Release Model

**Files:**
- Modify: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: the branch behavior implemented in Task 2.
- Produces: architectural and agent guidance that distinguishes stable `latest` publishing from branch preview publishing.

- [x] **Step 1: Expand the design document branch model**

In `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`, replace the Branch model list with:

```markdown
Branch model:

- `devel`: main source branch containing TypeScript source, templates, docs, the pinned OpenAPI spec, the custom generator, and committed generated TypeScript client source.
- `latest`: generated stable release/distribution branch containing the validated marketplace release artifacts from `dist-marketplace/` built from `devel`.
- `dist/<source-branch>`: generated preview release/distribution branch containing the same validated marketplace release artifacts built from a non-`devel` source branch. Nested source branch names are preserved, so `feature/foo` publishes to `dist/feature/foo`.
```

Replace the sentence beginning `On devel` immediately after that list with:

```markdown
On source branches, `dist/`, `dist-marketplace/`, and `dist-local/` are generated and ignored. `npm run dist` builds all three trees through the split projection scripts: `build-dist-npm.mjs`, `build-dist-marketplace.mjs`, and `build-dist-local.mjs`, with shared helpers in `build-dist-common.mjs`. `dist/` is the npm package artifact. `dist-marketplace/` is the self-contained marketplace release tree for Gemini, Claude Code, Codex, and OpenCode and is the only tree published to generated release branches. `dist-local/` contains project-local configurations that call an installed `nams-hooks` executable. `dist/` and `dist-local/` are generated and verified on source branches but are not published to `latest` or `dist/<source-branch>`.
```

- [x] **Step 2: Expand the manual and CI release rules**

In the same design document, replace the `Manual or CI release flow` list and its following `Rules` list with:

```markdown
Manual or CI release flow:

1. Work on `devel` or another source branch.
2. Run `npm run openapi:fetch` when the NAMS contract needs refreshing.
3. Run `npm run openapi:generate`.
4. Commit `docs/nams-openapi.json` and `src/generated/nams-client.ts` if they changed.
5. Run package verification.
6. Run release preparation to create the marketplace release tree from `dist-marketplace/`.
7. Replace the target generated branch contents with the validated `dist-marketplace/` release tree: `latest` for `devel`, or `dist/<source-branch>` for another source branch.
8. Commit the marketplace release artifact on the target generated branch.
9. When the target is `latest`, force-update the `latest` tag and recreate the GitHub Release named `latest`.

Rules:

- Generated release artifacts are produced from source branches; no hand edits.
- Successful push-triggered Builds publish `devel` to `latest` and every other source branch to `dist/<source-branch>`.
- Pull-request Builds never publish artifacts.
- Generated `latest` and `dist/**` branches do not trigger Build or Release again.
- The `latest` release tag and GitHub Release are created only from `latest`; preview branches do not create tags or GitHub Releases.
- Gemini stable installs use `--ref latest`; preview validation may use the corresponding `dist/<source-branch>` ref.
- Codex, Claude, Gemini, and OpenCode marketplace release artifacts are produced from the same validated source tree.
- `dist/` and `dist-local/` are verification artifacts on source branches; they are not copied to generated release branches.
- `npm run package:check` must verify all generated artifacts: npm package output in `dist/`, self-contained marketplace output in `dist-marketplace/`, local project configuration output in `dist-local/`, and npm dry-run package contents.
```

Replace the final approval-record branch decision with:

```markdown
- Use `devel` as the main source branch; publish its validated `dist-marketplace/` artifacts to `latest`, and publish non-`devel` source branch artifacts to `dist/<source-branch>`. Keep `dist/` and `dist-local/` as generated verification artifacts on source branches.
```

- [x] **Step 3: Align repository agent guidance**

In `AGENTS.md`, replace the `Build And Distribution` bullet list with:

```markdown
## Build And Distribution

- `devel` is the main source branch.
- `devel` publishes validated `dist-marketplace/` artifacts to the generated `latest` branch.
- Every other source branch `<branch>` publishes validated `dist-marketplace/` artifacts to the generated `dist/<branch>` branch.
- Generated `latest` and `dist/**` branches do not trigger another build or release.
- `dist/`, `dist-marketplace/`, and `dist-local/` are generated and ignored on source branches.
- `npm run build` compiles TypeScript into `.build/tsc` for local verification.
- `npm run dist` creates npm, marketplace, and local projections under `dist/`, `dist-marketplace/`, and `dist-local/`.
- In generated artifacts, compiled runtime files live under the target's `bin/` tree.
- Marketplace and local root files are produced from `templates/marketplace/` and `templates/local/`.
- Do not hand-edit generated distribution output as a source change.
- GitHub Actions `Build` runs on pull requests, pushes to all source branches, and manual dispatch. It excludes generated `latest` and `dist/**` branches and runs `npm run check`.
- GitHub Actions `Release` publishes only successful push-triggered Builds or explicit source-branch dispatches. Pull-request Builds never publish.
- Only `devel` publishing updates the `latest` tag and GitHub Release; preview `dist/<branch>` publishing updates a branch only.
```

- [x] **Step 4: Verify the complete change**

Run:

```bash
npm run check
git diff --check
git status --short
```

Expected: `npm run check` passes, `git diff --check` reports no errors, and status lists only the intended workflow, test, design, agent-guidance, and plan changes plus any pre-existing unrelated user files.

- [x] **Step 5: Commit the release-model documentation**

```bash
git add AGENTS.md docs/superpowers/specs/2026-05-10-nams-hooks-design.md docs/plans/0003-branch-release-artifacts.md
git commit -m "docs: define branch release artifacts"
```

### Task 4: Remove Stalled Preview Branches After 30 Days

**Files:**
- Create: `.github/workflows/cleanup.yml`
- Modify: `test/release-workflow.test.ts`
- Modify: `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: remote branch tips under `refs/heads/dist/**` and their commit timestamps.
- Produces: a daily UTC cleanup run that deletes only preview branches whose tip commit timestamp is strictly older than the 30-day cutoff; also supports manual dispatch.

- [x] **Step 1: Add a failing cleanup workflow contract test**

Append this test to `test/release-workflow.test.ts`:

```ts
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
```

- [x] **Step 2: Run the cleanup contract test to verify it fails**

Run:

```bash
node --import=tsx --test test/release-workflow.test.ts
```

Expected: FAIL with `ENOENT` for `.github/workflows/cleanup.yml` while the four release tests continue to pass.

- [x] **Step 3: Create the daily cleanup workflow**

Create `.github/workflows/cleanup.yml` with:

```yaml
name: Cleanup stale preview branches

on:
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: cleanup-dist-branches
  cancel-in-progress: false

jobs:
  cleanup:
    name: Delete stalled dist branches
    runs-on: ubuntu-latest

    steps:
      - name: Check out repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Delete preview branches older than 30 days
        shell: bash
        run: |
          set -euo pipefail

          if ! git ls-remote --exit-code --heads origin 'refs/heads/dist/*' >/dev/null; then
            echo "No dist preview branches found."
            exit 0
          fi

          git fetch --no-tags --prune --depth=1 origin \
            '+refs/heads/dist/*:refs/remotes/origin/dist/*'

          cutoff_epoch="$(date -u -d '30 days ago' +%s)"

          while IFS=$'\t' read -r remote_ref commit_epoch expected_sha; do
            if [[ -z "$remote_ref" || -z "$commit_epoch" || -z "$expected_sha" ]]; then
              continue
            fi

            branch="${remote_ref#origin/}"
            if (( commit_epoch < cutoff_epoch )); then
              echo "Deleting stale preview branch $branch."
              if ! git push --force-with-lease="refs/heads/$branch:$expected_sha" origin ":refs/heads/$branch"; then
                echo "::warning::Skipped $branch because its remote tip changed or deletion was rejected."
              fi
            else
              echo "Keeping active preview branch $branch."
            fi
          done < <(
            git for-each-ref --format='%(refname:short)%09%(committerdate:unix)%09%(objectname)' refs/remotes/origin/dist/
          )
```

The non-round cron minute avoids the most common top-of-hour scheduling load. `git ls-remote` makes an empty preview namespace a successful no-op. The fetch refspec and `for-each-ref` scope ensure the deletion loop cannot enumerate `latest` or ordinary source branches. The explicit force-with-lease SHA prevents cleanup from deleting a preview branch that a concurrent release refreshed after cleanup fetched it.

- [x] **Step 4: Run the workflow contract tests to verify cleanup passes**

Run:

```bash
node --import=tsx --test test/release-workflow.test.ts
```

Expected: PASS with five passing workflow contract tests.

- [x] **Step 5: Document preview retention**

In the `Rules` list under `Manual or CI release flow` in `docs/superpowers/specs/2026-05-10-nams-hooks-design.md`, insert this bullet immediately after the rule excluding generated branches from Build and Release:

```markdown
- A daily UTC cleanup removes generated `dist/**` branches whose tip commit is older than 30 days. The cleanup does not target `latest` or source branches and may also be run through manual dispatch.
```

In the `Build And Distribution` section of `AGENTS.md`, insert this bullet immediately after the generated-branch recursion rule:

```markdown
- GitHub Actions runs a daily cleanup that deletes generated `dist/**` branches whose tip commit is older than 30 days; it never targets `latest` or source branches.
```

- [x] **Step 6: Verify the complete release and cleanup change**

Run:

```bash
npm run check
git diff --check
git status --short
```

Expected: `npm run check` passes, `git diff --check` reports no errors, and status lists only the intended Build, Release, cleanup, test, design, agent-guidance, and plan changes plus any pre-existing unrelated user files.

- [x] **Step 7: Commit the cleanup workflow and retention policy**

```bash
git add .github/workflows/cleanup.yml test/release-workflow.test.ts AGENTS.md docs/superpowers/specs/2026-05-10-nams-hooks-design.md docs/plans/0003-branch-release-artifacts.md
git commit -m "ci: clean up stale preview branches"
```
