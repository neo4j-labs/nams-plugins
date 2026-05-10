# Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold a buildable TypeScript package that produces `dist/` JavaScript and logs one session-start hook JSON payload for Gemini, Claude, and Codex.

**Architecture:** Keep the walking skeleton narrow. `src/cli.ts` parses `nams-hooks run <harness> --event SessionStart`, reads JSON from stdin as an opaque payload, dispatches to a platform adapter through shared interfaces, and emits hook-safe JSON on stdout. Platform adapters write JSONL diagnostics into `.nams/logs/`.

**Tech Stack:** Node.js 26 for verification, TypeScript as a dev dependency, Node built-ins only for runtime, Node's built-in `node:test` runner for tests.

---

### Task 1: Package And Build Skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

- [x] **Step 1: Create package metadata and scripts**

Create `package.json` with `build`, `test`, and `check` scripts. `build` runs `tsc`; `test` runs compiled test files with `node --test`; `check` runs build then test.

- [x] **Step 2: Create TypeScript config**

Create `tsconfig.json` that emits ESM JavaScript from `src/` and `test/` into `dist/`, with strict checking and no runtime dependencies.

- [x] **Step 3: Ignore generated local files**

Create `.gitignore` for `node_modules/`, `.nams/`, transient logs, and TypeScript build info.

### Task 2: TDD For Session JSON Logging

**Files:**
- Create: `test/cli-session-start.test.js`
- Create: `src/cli.ts`

- [x] **Step 1: Write failing test**

Create a JavaScript test that runs `dist/cli.js run gemini --event SessionStart` in a temporary project directory, sends JSON on stdin, and asserts:

- stdout is valid hook JSON
- `.nams/logs/gemini-session-start.jsonl` exists
- the log entry includes `harness: "gemini"` and the original payload

- [x] **Step 2: Verify red**

Run `npm run build` and `npm test`. Expected: failure because `src/cli.ts` does not exist yet.

- [x] **Step 3: Implement minimal CLI**

Implement `src/cli.ts` with:

- `run <harness> --event SessionStart` command
- harness validation for `gemini`, `claude`, `codex`
- typed event validation for `SessionStart`
- stdin JSON parsing
- dispatch through the static platform adapter registry
- JSONL append to `.nams/logs/<harness>-session-start.jsonl`
- stdout JSON of `{ "continue": true, "suppressOutput": true }`

- [x] **Step 4: Verify green**

Run `npm run build` and `npm test`. Expected: pass.

### Task 3: Platform Session-Start Templates

**Files:**
- Create: `gemini-extension.json`
- Create: `hooks/hooks.json`
- Create: `templates/claude/settings.local.json`
- Create: `templates/codex/hooks.json`

- [x] **Step 1: Add Gemini extension metadata**

Create `gemini-extension.json` with extension name, version, description, and a sensitive `NAMS_API_KEY` setting.

- [x] **Step 2: Add Gemini SessionStart hook**

Create `hooks/hooks.json` with a `SessionStart` command hook that runs `node ${extensionPath}/dist/cli.js run gemini --event SessionStart`.

- [x] **Step 3: Add Claude SessionStart template**

Create `templates/claude/settings.local.json` with a `SessionStart` command hook that runs `nams-hooks run claude --event SessionStart`.

- [x] **Step 4: Add Codex SessionStart template**

Create `templates/codex/hooks.json` with a `SessionStart` command hook that runs `nams-hooks run codex --event SessionStart`.

### Task 4: Verification And Commit

**Files:**
- Modify: generated `dist/` files from `npm run build`
- Commit all scaffold files

- [x] **Step 1: Install dev dependency**

Run `npm install` to install TypeScript and create `package-lock.json`.

- [x] **Step 2: Run verification**

Run `npm run check`. Expected: TypeScript build succeeds and node tests pass.

- [x] **Step 3: Smoke test CLI manually**

Run `printf '{"session_id":"manual","hook_event_name":"SessionStart","cwd":"%s"}\n' "$PWD" | node dist/cli.js run gemini --event SessionStart` and verify `.nams/logs/gemini-session-start.jsonl` receives a line.

- [x] **Step 4: Commit**

Commit with message `feat: scaffold hook runtime walking skeleton`.
