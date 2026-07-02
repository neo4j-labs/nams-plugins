# Gemini Dedupe-Key Invariant Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the asymmetric lookup/mark key sets in `geminiToolCallDedupeKeys` survivable at 3am: state the invariant in a doc comment and pin it with three unit tests, so a future refactor that breaks cross-payload dedupe fails a test instead of silently double-writing tool calls to NAMS.

**Architecture:** `geminiToolCallDedupeKeys` (`src/platforms/gemini/index.ts:357-383`) deliberately returns *different* key sets for lookup and mark. The invariant, currently documented nowhere: **the same tool call must dedupe across payload variants (id-bearing hook payload vs. id-less transcript replay, in either order), while two distinct id-bearing calls with identical input must NOT dedupe.** The `idFallbackKey` exists solely to let an id-bearing mark be found by a later id-less lookup without collapsing distinct id-bearing calls that share input. This plan exports the function (it is pure), documents the invariant where the code lives, and adds a focused test file. No behavior changes.

**Tech Stack:** TypeScript, Node built-in test runner via tsx.

**Ordering note:** Independent of the other review plans. If the memory-turn extraction plan has already run, `geminiToolCallDedupeKeys` is unchanged by it — the steps below apply identically.

## Global Constraints

- No behavior changes: the function body must be byte-identical except for the added `export` keyword and comment.
- Test files may import concrete adapter modules (the archunit registry rule only scans `src/**`).
- Run tests with `npm test` from the repo root.

---

### Task 1: Pin the invariant with unit tests

**Files:**
- Modify: `src/platforms/gemini/index.ts:357` (add `export` to `geminiToolCallDedupeKeys`)
- Test: `test/gemini/gemini-dedupe-keys.test.ts` (create)

**Interfaces:**
- Consumes: `geminiToolCallDedupeKeys(sessionKey: string, toolName: string, input: unknown, geminiToolCallId?: string): { lookupKeys: string[]; markKeys: string[] }` from `src/platforms/gemini/index.ts`; `hasSeenAny(seen: string[], keys: string[]): boolean` and `markSeen(seen: string[], keys: string[]): void` from `src/platforms/dedupe.ts`.
- Produces: a test file that fails if the lookup/mark asymmetry is "simplified" away.

- [ ] **Step 1: Write the failing tests**

Create `test/gemini/gemini-dedupe-keys.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasSeenAny, markSeen } from "../../src/platforms/dedupe.js";
import { geminiToolCallDedupeKeys } from "../../src/platforms/gemini/index.js";

const sessionKey = "session-1";
const toolName = "read_file";
const input = { path: "/tmp/a.txt" };

test("an id-less mark dedupes a later id-bearing replay of the same call", () => {
  const seen: string[] = [];
  markSeen(seen, geminiToolCallDedupeKeys(sessionKey, toolName, input).markKeys);

  const withId = geminiToolCallDedupeKeys(sessionKey, toolName, input, "call-1");

  assert.equal(hasSeenAny(seen, withId.lookupKeys), true);
});

test("an id-bearing mark dedupes a later id-less replay of the same call", () => {
  const seen: string[] = [];
  markSeen(seen, geminiToolCallDedupeKeys(sessionKey, toolName, input, "call-1").markKeys);

  const withoutId = geminiToolCallDedupeKeys(sessionKey, toolName, input);

  assert.equal(hasSeenAny(seen, withoutId.lookupKeys), true);
});

test("a second id-bearing call with identical input is not deduped", () => {
  const seen: string[] = [];
  markSeen(seen, geminiToolCallDedupeKeys(sessionKey, toolName, input, "call-1").markKeys);

  const secondCall = geminiToolCallDedupeKeys(sessionKey, toolName, input, "call-2");

  assert.equal(hasSeenAny(seen, secondCall.lookupKeys), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --import=tsx --test test/gemini/gemini-dedupe-keys.test.ts`
Expected: FAIL — `geminiToolCallDedupeKeys` is not exported.

- [ ] **Step 3: Export the function**

In `src/platforms/gemini/index.ts`, change:

```ts
function geminiToolCallDedupeKeys(
```

to:

```ts
export function geminiToolCallDedupeKeys(
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --import=tsx --test test/gemini/gemini-dedupe-keys.test.ts test/architecture.test.ts`
Expected: PASS. All three tests pass against the current implementation — they encode existing behavior, not new behavior.

- [ ] **Step 5: Commit**

```bash
git add src/platforms/gemini/index.ts test/gemini/gemini-dedupe-keys.test.ts
git commit -m "test: pin gemini tool-call dedupe cross-payload invariant"
```

---

### Task 2: Document the invariant at the definition site

**Files:**
- Modify: `src/platforms/gemini/index.ts` (doc comment above `geminiToolCallDedupeKeys`)

**Interfaces:**
- Consumes: nothing.
- Produces: the invariant, readable where the code lives.

- [ ] **Step 1: Add the doc comment**

Immediately above `export function geminiToolCallDedupeKeys(`:

```ts
/**
 * Lookup and mark key sets are deliberately asymmetric.
 *
 * Invariant: one tool call must dedupe across Gemini's two payload variants —
 * the id-bearing hook payload and the id-less transcript replay — in either
 * arrival order, while two DISTINCT id-bearing calls that happen to share
 * identical input must NOT dedupe.
 *
 * How the keys achieve that:
 * - id-less mark writes `fallback:` + bare hash; an id-bearing lookup includes
 *   `fallback:`, so it finds the earlier mark.
 * - id-bearing mark writes `gemini-id:` + `gemini-id-fallback:` (NOT
 *   `fallback:`); an id-less lookup includes `gemini-id-fallback:`, so it
 *   finds the earlier mark. A second id-bearing call with a different id looks
 *   up `gemini-id:<other>` + `fallback:` — neither was marked — so it records.
 * - the bare hash in lookup keys accepts marks written by older builds.
 *
 * Pinned by test/gemini/gemini-dedupe-keys.test.ts — keep the tests and this
 * comment in sync with any key-shape change, and keep new key shapes findable
 * by the previous version's marks (state files outlive upgrades).
 */
```

- [ ] **Step 2: Verify the suite still passes and commit**

Run: `npm run build && node --import=tsx --test test/gemini/*.test.ts`
Expected: PASS.

```bash
git add src/platforms/gemini/index.ts
git commit -m "docs: explain gemini dedupe key asymmetry at definition site"
```
