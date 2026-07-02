# Architecture Test Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove architecture tests that assert identifier spellings and ghost types instead of dependency boundaries, so legitimate refactoring stops producing false failures.

**Architecture:** `test/architecture.test.ts` mixes two kinds of tests: archunit dependency-boundary rules (keep — they enforce the adapter black-box design) and regex assertions on names/signatures (delete — they test spelling, not structure). Several regexes guard against types that no longer exist anywhere in `src/` (`MemoryPlatformAdapterOptions`, `RuntimeEnvironment`, `sanitizeNamsRequestLogPayload`). This plan deletes the naming fossils, keeps every dependency rule, and keeps behavior-relevant regexes (no `fetch` in adapters, no hardcoded production URL, no `HOME` lookup outside `paths.ts`).

**Tech Stack:** Node built-in test runner (`node --test` via tsx), archunit (dev dependency).

**Recommended execution order across the review plans:** this plan first — it unblocks the memory-turn extraction plan (`2026-07-02-memory-turn-extraction.md`) from brittle signature assertions.

## Global Constraints

- Zero runtime dependencies: `package.json` `dependencies` stays absent/empty; only `devDependencies` may change (this plan changes none).
- Tests run with `npm test` (which runs `npm run build` first) from the repo root.
- Do NOT delete any test that uses `projectFiles()` (archunit dependency rules) — those are the real boundary enforcement.
- Do NOT touch any file outside `test/architecture.test.ts`.

---

### Task 1: Delete the pure naming-assertion tests

**Files:**
- Modify: `test/architecture.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a slimmer `test/architecture.test.ts`; later plans (memory-turn extraction) rely on the deleted assertions being gone.

- [ ] **Step 1: Delete the test "memory platform adapter contract is named explicitly"**

Remove this entire test (currently `test/architecture.test.ts:169-177`). It asserts that a type is spelled `MemoryPlatformAdapter` rather than `PlatformAdapter` — a name, not a boundary:

```ts
test("memory platform adapter contract is named explicitly", async () => {
  const interfaceContent = await readFile("src/interfaces.ts", "utf8");
  const registryContent = await readFile("src/platforms/index.ts", "utf8");

  assert.match(interfaceContent, /\bexport type MemoryPlatformAdapter\b/);
  assert.doesNotMatch(interfaceContent, /\bexport type PlatformAdapter\b/);
  assert.match(registryContent, /\bgetMemoryPlatformAdapter\b/);
  assert.doesNotMatch(registryContent, /\bgetPlatformAdapter\b/);
});
```

- [ ] **Step 2: Delete the test "platform session-start contract names local session initialization"**

Remove this entire test (currently `test/architecture.test.ts:200-216`). It regex-matches an exact function signature string in every adapter — any legitimate signature reformatting breaks it:

```ts
test("platform session-start contract names local session initialization", async () => {
  const interfaceContent = await readFile("src/interfaces.ts", "utf8");
  const cliContent = await readFile("src/cli.ts", "utf8");

  assert.match(interfaceContent, /\bstartSession[:(]/);
  assert.equal(/\bstartConversation\b/.test(interfaceContent), false);
  assert.match(cliContent, /\badapter\.startSession\(/);
  assert.equal(/\badapter\.startConversation\b/.test(cliContent), false);

  for (const platform of ["gemini", "claude", "codex", "opencode"]) {
    const filePath = `src/platforms/${platform}/index.ts`;
    const content = await readFile(filePath, "utf8");

    assert.match(content, /\basync function startSession\(invocation: HookInvocation<"SessionStart">\): Promise<HookResult>/);
    assert.equal(/\bstartConversation\b/.test(content), false);
  }
});
```

- [ ] **Step 3: Delete the test "platform adapters do not manage runtime environment"**

Remove this entire test (currently `test/architecture.test.ts:218-225`). `RuntimeEnvironment` does not exist anywhere in `src/` — this guards against a ghost:

```ts
test("platform adapters do not manage runtime environment", async () => {
  for (const platform of ["gemini", "claude", "codex", "opencode"]) {
    const filePath = `src/platforms/${platform}/index.ts`;
    const content = await readFile(filePath, "utf8");

    assert.equal(/\bRuntimeEnvironment\b|\bruntimeEnvironment\b/.test(content), false, `${filePath} should not manage runtime environment`);
  }
});
```

- [ ] **Step 4: Delete the test "global runtime modules do not accept unused project directory plumbing"**

Remove this entire test (currently `test/architecture.test.ts:227-235`). It regexes for specific parameter plumbing that was removed long ago — another ghost guard:

```ts
test("global runtime modules do not accept unused project directory plumbing", async () => {
  const sessionState = await readFile("src/runtime/session-state.ts", "utf8");
  const logging = await readFile("src/runtime/logging.ts", "utf8");

  assert.equal(/loadSessionState\(\s*\n\s*projectDirectory:/.test(sessionState), false);
  assert.equal(/saveSessionState\(\s*\n\s*projectDirectory:/.test(sessionState), false);
  assert.equal(/\bvoid projectDirectory\b/.test(sessionState), false);
  assert.equal(/\bprojectDirectory: string;/.test(logging), false);
});
```

- [ ] **Step 5: Run the architecture tests to confirm the file still parses and remaining tests pass**

Run: `npm run build && node --import=tsx --test test/architecture.test.ts`
Expected: PASS, with 11 of the original 15 tests remaining in this file.

- [ ] **Step 6: Commit**

```bash
git add test/architecture.test.ts
git commit -m "test: remove naming-assertion architecture tests, keep boundary rules"
```

---

### Task 2: Reduce the mixed tests to their behavior-relevant assertions

**Files:**
- Modify: `test/architecture.test.ts`

**Interfaces:**
- Consumes: Task 1's deletions (line numbers below assume Task 1 is done).
- Produces: final `test/architecture.test.ts` containing only dependency rules and behavior guards.

- [ ] **Step 1: Replace the test "platform adapters do not accept test-only runtime dependencies"**

This test mixes ghost-type assertions (`MemoryPlatformAdapterOptions`, `runtimeEnvironment?:`, `env?:` — none exist in `src/`) with one real boundary: adapters must not call `fetch` directly (all NAMS traffic must go through `runtime/memory-service.ts` so provenance headers and request logging are never bypassed). Replace the whole test:

```ts
test("platform adapters do not accept test-only runtime dependencies", async () => {
  const content = await readFile("src/interfaces.ts", "utf8");

  assert.equal(/\bMemoryPlatformAdapterOptions\b/.test(content), false);
  assert.equal(/\bfetch\?: typeof fetch\b/.test(content), false);
  assert.equal(/\bruntimeEnvironment\?:/.test(content), false);
  assert.equal(/\benv\?:/.test(content), false);

  for (const platform of ["gemini", "claude", "codex", "opencode"]) {
    const filePath = `src/platforms/${platform}/index.ts`;
    const platformContent = await readFile(filePath, "utf8");

    assert.equal(/\bMemoryPlatformAdapterOptions\b/.test(platformContent), false);
    assert.equal(/\bprivate readonly options\b|\bthis\.options\b/.test(platformContent), false);
    assert.equal(/\bfetch\b/.test(platformContent), false);
  }
});
```

with:

```ts
test("platform adapters do not call fetch directly", async () => {
  for (const platform of ["gemini", "claude", "codex", "opencode"]) {
    const filePath = `src/platforms/${platform}/index.ts`;
    const platformContent = await readFile(filePath, "utf8");

    assert.equal(
      /\bfetch\b/.test(platformContent),
      false,
      `${filePath} must route NAMS traffic through runtime/memory-service.ts`,
    );
  }
});
```

- [ ] **Step 2: Replace the test "platform adapters use shared logging wrappers"**

Current version omits `claude` from the platform list (inconsistent) and greps for `sanitizeNamsRequestLogPayload|isSensitiveLogKey|redactSecretValue` — identifiers that exist nowhere in `src/`. Keep the live rule (no locally defined `append*` logging helpers in adapters), cover all four platforms, drop the ghost line. Replace the whole test:

```ts
test("platform adapters use shared logging wrappers", async () => {
  for (const platform of ["gemini", "claude", "codex", "opencode"]) {
    const filePath = `src/platforms/${platform}/index.ts`;
    const content = await readFile(filePath, "utf8");

    assert.equal(
      /async function append(?:NamsConfigDiagnostic|NamsFailureDiagnostic|NamsRequestLog|RawPlatformLog|[A-Z][A-Za-z]+DiagnosticLog)\b/.test(
        content,
      ),
      false,
      `${filePath} should reuse shared runtime logging helpers`,
    );
  }
});
```

- [ ] **Step 3: Run the architecture tests**

Run: `node --import=tsx --test test/architecture.test.ts`
Expected: PASS. Final test list in the file should be exactly:
1. `platform adapters do not import each other`
2. `runtime modules do not import gateway or platform modules`
3. `generated client does not import project runtime modules`
4. `runtime and generated-client source do not hardcode production NAMS service URL`
5. `only the platform registry imports all concrete adapters`
6. `platform adapters do not call fetch directly`
7. `workspace adapter registry is static`
8. `workspace resolution runtime does not format platform hook output`
9. `workspace selection notice formatter does not branch by platform`
10. `runtime environment home lookup stays in paths module`
11. `platform adapters use shared logging wrappers`

- [ ] **Step 4: Run the full suite to confirm nothing else referenced the deleted tests**

Run: `npm test`
Expected: PASS (338 tests minus the 4 deleted = 334, allowing for the renamed test).

- [ ] **Step 5: Commit**

```bash
git add test/architecture.test.ts
git commit -m "test: keep behavior guards, drop ghost-type assertions from architecture tests"
```
