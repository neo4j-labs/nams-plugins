# Slash Workspace Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Tier 1 slash workspace UX for Claude Code and OpenCode while documenting Gemini and Codex as designed but deferred.

**Architecture:** Keep the existing `nams-hooks workspaces configure <platform> --scope session ...` command as the source of truth. Add thin platform wrappers in Claude plugin skill assets and the OpenCode plugin shim; those wrappers parse `/nams-hooks workspaces use <selector>`, obtain the current session ID, and delegate to the shared CLI. Update user-facing notices and docs to advertise the slash command where deterministic and keep the explicit shell command for every platform.

**Tech Stack:** TypeScript, Node.js built-ins, Node `node:test`, Claude plugin skill templates, OpenCode plugin template JavaScript, generated `dist/` checks.

---

## Source Documents

- Design: `docs/superpowers/specs/2026-06-11-slash-workspace-command-design.md`
- Research: `docs/session-workspace-command-support.md`
- Existing session configure design: `docs/superpowers/specs/2026-06-10-session-workspace-selection-design.md`
- Architecture rules: `AGENTS.md`
- Claude skills reference: `https://code.claude.com/docs/en/skills`
- OpenCode plugin and command references: `https://opencode.ai/docs/plugins/`, `https://opencode.ai/docs/commands/`

## Scope

Implement now:

- Claude Code slash-invocable skill asset packaged with the Claude plugin.
- OpenCode command interception in the existing plugin shim.
- User-facing notices and docs that include the slash command where relevant and keep the shell command.
- Packaging checks that ensure Claude skill assets are present in `dist/`.

Defer:

- Gemini custom command and session bridge.
- Codex deterministic slash command. Keep Codex on hook notices and explicit shell command.

## File Structure

- Create `templates/claude/plugins/nams-hooks/skills/nams-hooks/SKILL.md`
  - Claude plugin skill entrypoint. Defines `/nams-hooks`, disables model invocation, and injects deterministic shell output from the helper script.
- Create `templates/claude/plugins/nams-hooks/skills/nams-hooks/scripts/workspace-use.mjs`
  - Built-in-only helper script. Parses `workspaces use <selector>`, validates `CLAUDE_SESSION_ID`, resolves plugin root from `CLAUDE_SKILL_DIR`, and spawns bundled `bin/cli.js`.
- Modify `test/claude-template.test.ts`
  - Tests the Claude skill template, helper script behavior, and failure modes.
- Modify `scripts/check-dist.mjs`
  - Ensures `dist/` and packed packages contain Claude skill files.
- Modify `templates/opencode/plugins/nams-hooks.js`
  - Adds `command.execute.before` handler plus helper functions for parsing slash arguments and spawning the shared configure command.
- Modify `test/opencode/opencode-template.test.ts`
  - Tests OpenCode command interception, selectors with spaces, ignored commands, missing selectors, missing session IDs, and failed CLI output.
- Modify `src/platforms/workspace-selection.ts`
  - Adds slash command guidance for Claude/OpenCode while preserving the explicit shell command for all platforms.
- Modify memory-flow and template tests that assert workspace selection notices:
  - `test/claude/claude-memory-flow.test.ts`
  - `test/gemini/gemini-memory-flow.test.ts`
  - `test/opencode/opencode-memory-flow.test.ts`
  - `test/opencode/opencode-template.test.ts`
  - `test/codex/codex-memory-flow.test.ts`
- Modify `README.md` and `INSTALL.md`
  - Documents Claude/OpenCode slash UX and keeps explicit shell configure commands for all platforms.

---

### Task 1: Update Workspace Selection Notices

**Files:**
- Modify: `src/platforms/workspace-selection.ts`
- Modify: `test/claude/claude-memory-flow.test.ts`
- Modify: `test/gemini/gemini-memory-flow.test.ts`
- Modify: `test/opencode/opencode-memory-flow.test.ts`
- Modify: `test/codex/codex-memory-flow.test.ts`

- [ ] **Step 1: Write failing expectations for slash guidance**

Update each multi-workspace notice test to check the new platform-specific behavior.

In `test/claude/claude-memory-flow.test.ts`, find the test named `Claude BeforeAgent skips memory when multiple listed workspaces require selection` and add:

```ts
assert.match(String(result.stdout.systemMessage), /\/nams-hooks workspaces use <workspace-id-or-name>/);
assert.match(
  String(result.stdout.systemMessage),
  /nams-hooks workspaces configure claude --scope session --session-id session-1 --workspace <workspace-id-or-name>/,
);
```

In `test/opencode/opencode-memory-flow.test.ts`, find the test named `OpenCode chat.message reports inactive memory when multiple workspaces are available` and add:

```ts
assert.match(String(result.stdout.reason), /\/nams-hooks workspaces use <workspace-id-or-name>/);
assert.match(
  String(result.stdout.reason),
  /nams-hooks workspaces configure opencode --scope session --session-id session-1 --workspace <workspace-id-or-name>/,
);
```

In `test/gemini/gemini-memory-flow.test.ts`, find the test named `Gemini BeforeAgent notifies and continues when multiple workspaces are available` and add:

```ts
assert.doesNotMatch(String(result.stdout.systemMessage), /\/nams-hooks workspaces use/);
assert.match(
  String(result.stdout.systemMessage),
  /nams-hooks workspaces configure gemini --scope session --session-id session-1 --workspace <workspace-id-or-name>/,
);
```

In `test/codex/codex-memory-flow.test.ts`, find the multi-workspace inactive-memory test and add:

```ts
assert.doesNotMatch(String(result.stdout.systemMessage), /\/nams-hooks workspaces use/);
assert.match(
  String(result.stdout.systemMessage),
  /nams-hooks workspaces configure codex --scope session --session-id session-1 --workspace <workspace-id-or-name>/,
);
```

- [ ] **Step 2: Run notice tests to verify they fail**

Run:

```bash
node --import=tsx --test \
  test/claude/claude-memory-flow.test.ts \
  test/gemini/gemini-memory-flow.test.ts \
  test/opencode/opencode-memory-flow.test.ts \
  test/codex/codex-memory-flow.test.ts
```

Expected: Claude and OpenCode tests fail because slash guidance is not present yet. Gemini and Codex expectations should keep passing or fail only if the test name/location needs a small adjustment.

- [ ] **Step 3: Implement platform-aware notice formatting**

Replace `formatWorkspaceSelectionNotice` in `src/platforms/workspace-selection.ts` with:

```ts
import type { Platform } from "../interfaces.js";
import type { PublicWorkspaceSummary } from "../runtime/workspace-resolution.js";

export function formatWorkspaceSelectionNotice(
  platform: Platform,
  workspaces: PublicWorkspaceSummary[],
  sessionId?: string,
): string {
  const commandSessionId = sessionId?.trim() || "<session-id>";
  return [
    "NAMS memory is inactive for this turn.",
    "No memory messages were stored. Multiple NAMS workspaces are available, and no workspaceId is configured.",
    ...slashCommandLines(platform),
    `Configure a session workspace before memory can resume with the shell command: nams-hooks workspaces configure ${platform} --scope session --session-id ${commandSessionId} --workspace <workspace-id-or-name>`,
    "Available NAMS workspaces:",
    ...workspaces.map((workspace, index) => {
      const name = workspace.name?.trim() || "(unnamed workspace)";
      const role = workspace.role?.trim() || "unknown-role";
      const status = workspace.status?.trim() || "unknown-status";
      return `${index + 1}. ${name} (${role}, ${status}) - ${workspace.id}`;
    }),
  ].join("\n");
}

function slashCommandLines(platform: Platform): string[] {
  if (platform !== "claude" && platform !== "opencode") {
    return [];
  }
  return [
    "In Claude Code or OpenCode sessions with the NAMS command installed, you can select a workspace with: /nams-hooks workspaces use <workspace-id-or-name>",
  ];
}
```

- [ ] **Step 4: Run notice tests to verify they pass**

Run:

```bash
node --import=tsx --test \
  test/claude/claude-memory-flow.test.ts \
  test/gemini/gemini-memory-flow.test.ts \
  test/opencode/opencode-memory-flow.test.ts \
  test/codex/codex-memory-flow.test.ts
```

Expected: PASS. The notices include slash guidance only for Claude and OpenCode, and all platforms still show the explicit shell command.

- [ ] **Step 5: Commit notice updates**

Run:

```bash
git add src/platforms/workspace-selection.ts \
  test/claude/claude-memory-flow.test.ts \
  test/gemini/gemini-memory-flow.test.ts \
  test/opencode/opencode-memory-flow.test.ts \
  test/codex/codex-memory-flow.test.ts
git commit -m "feat: mention slash workspace command in notices" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 2: Add Claude Slash Skill

**Files:**
- Create: `templates/claude/plugins/nams-hooks/skills/nams-hooks/SKILL.md`
- Create: `templates/claude/plugins/nams-hooks/skills/nams-hooks/scripts/workspace-use.mjs`
- Modify: `test/claude-template.test.ts`
- Modify: `scripts/check-dist.mjs`

- [ ] **Step 1: Add failing Claude skill template tests**

Add these imports to `test/claude-template.test.ts`:

```ts
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
```

If `readFile` is already imported, merge the import so it is not duplicated.

Add constants near the top:

```ts
const claudeSkillPath = "templates/claude/plugins/nams-hooks/skills/nams-hooks/SKILL.md";
const claudeSkillScriptPath = "templates/claude/plugins/nams-hooks/skills/nams-hooks/scripts/workspace-use.mjs";
```

Add this test after `Claude plugin template invokes the bundled CLI through plugin root`:

```ts
test("Claude plugin template packages slash workspace skill", async () => {
  const skill = await readFile(claudeSkillPath, "utf8");
  const script = await readFile(claudeSkillScriptPath, "utf8");

  assert.match(skill, /name: nams-hooks/);
  assert.match(skill, /argument-hint: workspaces use <workspace-id-or-name>/);
  assert.match(skill, /disable-model-invocation: true/);
  assert.match(skill, /workspace-use\.mjs/);
  assert.match(skill, /\$ARGUMENTS/);
  assert.match(script, /CLAUDE_SESSION_ID/);
  assert.match(script, /CLAUDE_SKILL_DIR/);
  assert.match(script, /workspaces/);
  assert.match(script, /configure/);
  assert.match(script, /claude/);
});
```

Add this test after the template test:

```ts
test("Claude slash workspace helper delegates to bundled cli", async () => {
  const fixture = await createClaudeSkillFixture();
  try {
    const result = spawnSync(process.execPath, [fixture.scriptPath, "workspaces use Engineering Team"], {
      cwd: fixture.directory,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: "claude-session-1",
        CLAUDE_SKILL_DIR: fixture.skillDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "configured\n");
    const call = JSON.parse(await readFile(fixture.callsPath, "utf8")) as Record<string, any>;
    assert.deepEqual(call.args, [
      "workspaces",
      "configure",
      "claude",
      "--scope",
      "session",
      "--session-id",
      "claude-session-1",
      "--workspace",
      "Engineering Team",
    ]);
  } finally {
    await fixture.cleanup();
  }
});
```

Add this test after the delegation test:

```ts
test("Claude slash workspace helper rejects missing selector and session id", async () => {
  const fixture = await createClaudeSkillFixture();
  try {
    const missingSelector = spawnSync(process.execPath, [fixture.scriptPath, "workspaces use"], {
      cwd: fixture.directory,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: "claude-session-1",
        CLAUDE_SKILL_DIR: fixture.skillDir,
      },
    });
    assert.equal(missingSelector.status, 1);
    assert.match(missingSelector.stderr, /Usage: \/nams-hooks workspaces use <workspace-id-or-name>/);

    const missingSession = spawnSync(process.execPath, [fixture.scriptPath, "workspaces use Engineering"], {
      cwd: fixture.directory,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_SKILL_DIR: fixture.skillDir,
      },
    });
    assert.equal(missingSession.status, 1);
    assert.match(missingSession.stderr, /Claude session id is unavailable/);
    assert.match(
      missingSession.stderr,
      /nams-hooks workspaces configure claude --scope session --session-id <session-id> --workspace Engineering/,
    );
  } finally {
    await fixture.cleanup();
  }
});
```

Add these helpers before `commandFor`:

```ts
async function createClaudeSkillFixture(): Promise<{
  directory: string;
  skillDir: string;
  scriptPath: string;
  callsPath: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nams-claude-skill-"));
  const pluginDir = path.join(directory, "plugin");
  const skillDir = path.join(pluginDir, "skills", "nams-hooks");
  const scriptsDir = path.join(skillDir, "scripts");
  const binDir = path.join(pluginDir, "bin");
  const callsPath = path.join(directory, "calls.json");
  const scriptPath = path.join(scriptsDir, "workspace-use.mjs");
  const cliPath = path.join(binDir, "cli.js");

  await mkdir(scriptsDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(scriptPath, await readFile(claudeSkillScriptPath, "utf8"), "utf8");
  await writeFile(
    cliPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args: process.argv.slice(2) }));
process.stdout.write("configured\\n");
`,
    "utf8",
  );
  await chmod(cliPath, 0o755);

  return {
    callsPath,
    directory,
    scriptPath,
    skillDir,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 2: Run Claude template tests to verify they fail**

Run:

```bash
node --import=tsx --test test/claude-template.test.ts
```

Expected: FAIL because `templates/claude/plugins/nams-hooks/skills/nams-hooks/SKILL.md` and `scripts/workspace-use.mjs` do not exist.

- [ ] **Step 3: Create the Claude skill template**

Create `templates/claude/plugins/nams-hooks/skills/nams-hooks/SKILL.md`:

```markdown
---
name: nams-hooks
description: Select the NAMS workspace for this Claude Code session.
argument-hint: workspaces use <workspace-id-or-name>
disable-model-invocation: true
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_SKILL_DIR}/scripts/workspace-use.mjs" "$ARGUMENTS"`
```

- [ ] **Step 4: Create the Claude helper script**

Create `templates/claude/plugins/nams-hooks/skills/nams-hooks/scripts/workspace-use.mjs`:

```js
#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";

const usage = "Usage: /nams-hooks workspaces use <workspace-id-or-name>";
const rawArguments = process.argv.slice(2).join(" ").trim();
const parsed = parseWorkspaceUse(rawArguments);

if (parsed.status !== "ok") {
  process.stderr.write(`${parsed.message}\n`);
  process.exitCode = 1;
} else {
  const sessionId = process.env.CLAUDE_SESSION_ID?.trim();
  if (!sessionId) {
    process.stderr.write(
      [
        "Claude session id is unavailable; cannot configure a session workspace automatically.",
        `Run manually: nams-hooks workspaces configure claude --scope session --session-id <session-id> --workspace ${parsed.selector}`,
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
  } else {
    const skillDir = process.env.CLAUDE_SKILL_DIR?.trim();
    if (!skillDir) {
      process.stderr.write("CLAUDE_SKILL_DIR is unavailable; cannot locate bundled nams-hooks runtime.\n");
      process.exitCode = 1;
    } else {
      const pluginRoot = path.resolve(skillDir, "..", "..");
      const cliPath = path.join(pluginRoot, "bin", "cli.js");
      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "workspaces",
          "configure",
          "claude",
          "--scope",
          "session",
          "--session-id",
          sessionId,
          "--workspace",
          parsed.selector,
        ],
        { encoding: "utf8" },
      );

      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
      if (result.error) {
        process.stderr.write(`Failed to run bundled nams-hooks CLI: ${result.error.message}\n`);
        process.exitCode = 1;
      } else {
        process.exitCode = result.status ?? 1;
      }
    }
  }
}

function parseWorkspaceUse(input) {
  const match = /^workspaces\s+use(?:\s+(.+))?$/.exec(input);
  if (match === null) {
    return {
      status: "error",
      message: `${usage}\nReceived: ${input || "(empty)"}`,
    };
  }

  const selector = match[1]?.trim();
  if (!selector) {
    return {
      status: "error",
      message: usage,
    };
  }

  return {
    status: "ok",
    selector,
  };
}
```

- [ ] **Step 5: Run Claude template tests to verify they pass**

Run:

```bash
node --import=tsx --test test/claude-template.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add dist package checks for Claude skill files**

In `scripts/check-dist.mjs`, update `verifyClaudePluginFiles()` after `await access(claudePluginHooksPath);`:

```js
  await access(path.join(claudePluginDir, "skills", "nams-hooks", "SKILL.md"));
  await access(path.join(claudePluginDir, "skills", "nams-hooks", "scripts", "workspace-use.mjs"));
```

Update `claudePackedFiles(packageDir)` to include the two skill files:

```js
function claudePackedFiles(packageDir) {
  const prefix = packageDir === root ? "dist/" : "";
  return [
    `${prefix}.claude-plugin/marketplace.json`,
    `${prefix}plugins/nams-hooks/.claude-plugin/plugin.json`,
    `${prefix}plugins/nams-hooks/hooks/hooks.json`,
    `${prefix}plugins/nams-hooks/skills/nams-hooks/SKILL.md`,
    `${prefix}plugins/nams-hooks/skills/nams-hooks/scripts/workspace-use.mjs`,
    `${prefix}plugins/nams-hooks/bin/cli.js`,
  ];
}
```

- [ ] **Step 7: Run dist build and check**

Run:

```bash
npm run dist && npm run dist:check
```

Expected: PASS. The generated `dist/plugins/nams-hooks/skills/nams-hooks/` tree exists and package dry-runs include both skill files.

- [ ] **Step 8: Commit Claude skill work**

Run:

```bash
git add templates/claude/plugins/nams-hooks/skills/nams-hooks/SKILL.md \
  templates/claude/plugins/nams-hooks/skills/nams-hooks/scripts/workspace-use.mjs \
  test/claude-template.test.ts \
  scripts/check-dist.mjs
git commit -m "feat: add claude slash workspace skill" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 3: Add OpenCode Command Interception

**Files:**
- Modify: `templates/opencode/plugins/nams-hooks.js`
- Modify: `test/opencode/opencode-template.test.ts`

- [ ] **Step 1: Extend the OpenCode command stub for configure calls**

In `test/opencode/opencode-template.test.ts`, extend `TemplateCall`:

```ts
interface TemplateCall {
  args: string[];
  payload?: Record<string, any>;
  stdin: string;
}
```

Replace the stub body inside `createNamsHooksStub()` with:

```ts
  await writeFile(
    commandPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const callsPath = ${JSON.stringify(callsPath)};
const stdoutByCommand = ${JSON.stringify(stdoutByCommand)};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const commandName = args[0];
  let payload;
  if (stdin.trim() !== "") {
    payload = JSON.parse(stdin);
  }
  appendFileSync(callsPath, JSON.stringify({ args, payload, stdin }) + "\\n");
  if (commandName === "workspaces" && stdoutByCommand.configureFailure === true) {
    process.stderr.write("workspace failed\\n");
    process.exitCode = 2;
    return;
  }
  if (commandName === "workspaces") {
    process.stdout.write("workspace configured\\n");
    return;
  }
  if (Object.hasOwn(stdoutByCommand, commandName)) {
    const output = stdoutByCommand[commandName];
    if (output !== undefined) {
      process.stdout.write(JSON.stringify(output));
    }
    return;
  }
  if (commandName === "run" && payload?.hook === "experimental.chat.system.transform") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "remember this" } }));
  }
});
`,
    "utf8",
  );
```

- [ ] **Step 2: Add failing OpenCode command tests**

Add these tests before `chat.message handler routes through the memory command`:

```ts
test("command.execute.before configures OpenCode session workspace", async () => {
  const fixture = await createNamsHooksStub();
  try {
    const toasts: any[] = [];
    const client = {
      tui: {
        showToast: async (entry: Record<string, any>) => {
          toasts.push(entry);
        },
      },
    };
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ client, directory: fixture.directory, project: "project-a", worktree: "worktree-a" });

    const result = await plugin["command.execute.before"]({
      command: "nams-hooks",
      sessionID: "opencode-session-1",
      arguments: ["workspaces", "use", "Engineering Team"],
    });

    const calls = await readCalls(fixture.callsPath);
    assert.deepEqual(result, { stop: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "workspaces",
      "configure",
      "opencode",
      "--scope",
      "session",
      "--session-id",
      "opencode-session-1",
      "--workspace",
      "Engineering Team",
    ]);
    assert.equal(calls[0].stdin, "");
    assert.deepEqual(toasts, [
      {
        body: {
          title: "NAMS workspace selected",
          message: "workspace configured",
          variant: "success",
          duration: 10000,
        },
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
});
```

Add this test after it:

```ts
test("command.execute.before ignores unrelated OpenCode commands", async () => {
  const fixture = await createNamsHooksStub();
  try {
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ directory: fixture.directory, project: "project-a", worktree: "worktree-a" });

    assert.equal(await plugin["command.execute.before"]({ command: "other", sessionID: "session-1", arguments: ["workspaces", "use", "Engineering"] }), undefined);
    assert.equal(await plugin["command.execute.before"]({ command: "nams-hooks", sessionID: "session-1", arguments: ["workspaces", "list"] }), undefined);

    await assert.rejects(readCalls(fixture.callsPath), /ENOENT/);
  } finally {
    await fixture.cleanup();
  }
});
```

Add this test after it:

```ts
test("command.execute.before reports invalid OpenCode workspace command forms", async () => {
  const fixture = await createNamsHooksStub();
  try {
    const toasts: any[] = [];
    const client = {
      tui: {
        showToast: async (entry: Record<string, any>) => {
          toasts.push(entry);
        },
      },
    };
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ client, directory: fixture.directory, project: "project-a", worktree: "worktree-a" });

    assert.deepEqual(
      await plugin["command.execute.before"]({ command: "nams-hooks", sessionID: "session-1", arguments: ["workspaces", "use"] }),
      { stop: true },
    );
    assert.deepEqual(
      await plugin["command.execute.before"]({ command: "nams-hooks", arguments: ["workspaces", "use", "Engineering"] }),
      { stop: true },
    );

    await assert.rejects(readCalls(fixture.callsPath), /ENOENT/);
    assert.equal(toasts.length, 2);
    assert.match(toasts[0].body.message, /Usage: \/nams-hooks workspaces use <workspace-id-or-name>/);
    assert.match(toasts[1].body.message, /OpenCode session id is unavailable/);
  } finally {
    await fixture.cleanup();
  }
});
```

Add this test after it:

```ts
test("command.execute.before surfaces failed workspace configure output", async () => {
  const fixture = await createNamsHooksStub({ stdoutByCommand: { configureFailure: true } });
  try {
    const toasts: any[] = [];
    const client = {
      tui: {
        showToast: async (entry: Record<string, any>) => {
          toasts.push(entry);
        },
      },
    };
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ client, directory: fixture.directory, project: "project-a", worktree: "worktree-a" });

    const result = await plugin["command.execute.before"]({
      command: "nams-hooks",
      sessionID: "opencode-session-1",
      arguments: "workspaces use Engineering",
    });

    assert.deepEqual(result, { stop: true });
    assert.equal(toasts.length, 1);
    assert.deepEqual(toasts[0].body, {
      title: "NAMS workspace selection failed",
      message: "workspace failed",
      variant: "danger",
      duration: 30000,
    });
  } finally {
    await fixture.cleanup();
  }
});
```

- [ ] **Step 3: Run OpenCode template tests to verify they fail**

Run:

```bash
node --import=tsx --test test/opencode/opencode-template.test.ts
```

Expected: FAIL because `plugin["command.execute.before"]` is undefined.

- [ ] **Step 4: Implement command interception in the plugin template**

In `templates/opencode/plugins/nams-hooks.js`, add this handler inside the object returned by `NamsHooks`, before `"chat.message"`:

```js
    "command.execute.before": async (input) => {
      const command = parseWorkspaceUseCommand(input);
      if (command.status === "ignored") {
        return undefined;
      }
      if (command.status === "error") {
        await showCommandResult(client, {
          title: "NAMS workspace selection failed",
          message: command.message,
          variant: "danger",
          duration: 30000,
        });
        return { stop: true };
      }

      const result = await invokeWorkspaceConfigure(input.sessionID, command.selector);
      const message = (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim();
      await showCommandResult(client, {
        title: result.code === 0 ? "NAMS workspace selected" : "NAMS workspace selection failed",
        message: message || (result.code === 0 ? "NAMS workspace configured." : "NAMS workspace selection failed."),
        variant: result.code === 0 ? "success" : "danger",
        duration: result.code === 0 ? 10000 : 30000,
      });
      return { stop: true };
    },
```

Add this function after `invokeNams`:

```js
async function invokeWorkspaceConfigure(sessionId, workspaceSelector) {
  return await new Promise((resolve) => {
    const child = spawn(
      command,
      [
        "workspaces",
        "configure",
        "opencode",
        "--scope",
        "session",
        "--session-id",
        sessionId,
        "--workspace",
        workspaceSelector,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
```

Add these functions near the other helpers:

```js
function parseWorkspaceUseCommand(input) {
  if (input?.command !== "nams-hooks") {
    return { status: "ignored" };
  }

  const selector = workspaceSelectorFromArguments(input?.arguments);
  if (selector === undefined) {
    return { status: "ignored" };
  }
  if (selector.trim() === "") {
    return { status: "error", message: "Usage: /nams-hooks workspaces use <workspace-id-or-name>" };
  }

  if (typeof input.sessionID !== "string" || input.sessionID.trim() === "") {
    return {
      status: "error",
      message: `OpenCode session id is unavailable; run manually: nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace ${selector}`,
    };
  }

  return { status: "ok", selector };
}

function workspaceSelectorFromArguments(argumentsValue) {
  if (typeof argumentsValue === "string") {
    const match = /^workspaces\s+use(?:\s+(.+))?$/.exec(argumentsValue.trim());
    return match === null ? undefined : (match[1] ?? "").trim();
  }
  if (!Array.isArray(argumentsValue) || argumentsValue[0] !== "workspaces" || argumentsValue[1] !== "use") {
    return undefined;
  }
  return argumentsValue.slice(2).join(" ").trim();
}

async function showCommandResult(client, body) {
  try {
    await client?.tui?.showToast?.({ body });
  } catch {}
}
```

- [ ] **Step 5: Run OpenCode template tests to verify they pass**

Run:

```bash
node --import=tsx --test test/opencode/opencode-template.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run OpenCode memory flow tests**

Run:

```bash
node --import=tsx --test test/opencode/opencode-memory-flow.test.ts test/opencode/opencode-template.test.ts
```

Expected: PASS. Existing memory hook behavior should be unchanged.

- [ ] **Step 7: Commit OpenCode command interception**

Run:

```bash
git add templates/opencode/plugins/nams-hooks.js test/opencode/opencode-template.test.ts
git commit -m "feat: add opencode slash workspace command" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 4: Update User Documentation

**Files:**
- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `docs/session-workspace-command-support.md`

- [ ] **Step 1: Add failing docs assertions**

Create a new test file `test/slash-workspace-docs.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("workspace docs mention slash command and explicit shell command", async () => {
  for (const filePath of ["README.md", "INSTALL.md", "docs/session-workspace-command-support.md"]) {
    const source = await readFile(filePath, "utf8");
    assert.match(source, /\/nams-hooks workspaces use <workspace-id-or-name>/, `${filePath} must mention slash command`);
    assert.match(
      source,
      /nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>|nams-hooks workspaces configure opencode --scope session --session-id session-1 --workspace Engineering/,
      `${filePath} must keep explicit configure command`,
    );
  }
});

test("workspace docs describe Gemini and Codex slash command limitations", async () => {
  const install = await readFile("INSTALL.md", "utf8");
  assert.match(install, /Gemini CLI.*slash command.*deferred/is);
  assert.match(install, /Codex.*explicit shell command/is);
});
```

- [ ] **Step 2: Run docs test to verify it fails**

Run:

```bash
node --import=tsx --test test/slash-workspace-docs.test.ts
```

Expected: FAIL because README and INSTALL do not mention `/nams-hooks workspaces use <workspace-id-or-name>` yet.

- [ ] **Step 3: Update README runtime configuration section**

Replace the sentence beginning `The quickest fix is a session-scoped selection;` in `README.md` with:

```markdown
The quickest deterministic fix is a session-scoped selection. In Claude Code
and OpenCode, use `/nams-hooks workspaces use <workspace-id-or-name>` when the
plugin command is installed. All platforms can use the explicit shell command
shown in hook notices:
`nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>`.
Hook notices include the current session ID when the harness exposes it, so
usually only `--workspace <workspace-id-or-name>` needs editing.
```

Keep the durable project/user configure example already present later in the paragraph.

- [ ] **Step 4: Update INSTALL workspace selection section**

In `INSTALL.md`, replace the paragraph and code block under `For multi-workspace inactive memory notices, the recommended quick fix is a session selection.` with:

````markdown
For multi-workspace inactive memory notices, the recommended quick fix is a
session selection. In Claude Code and OpenCode, use the slash command:

```text
/nams-hooks workspaces use <workspace-id-or-name>
```

The slash command is a wrapper around the explicit shell command. Keep using the
shell command for Gemini, Codex, scripts, and troubleshooting:

```bash
nams-hooks workspaces configure <platform> --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```

For example:

```bash
nams-hooks workspaces configure opencode --scope session --session-id session-1 --workspace Engineering
```
````

- [ ] **Step 5: Add platform notes to INSTALL**

In the Claude Code section, after the paragraph about environment variable overrides, add:

````markdown
When multiple workspaces are available, select one for the current Claude
session with:

```text
/nams-hooks workspaces use <workspace-id-or-name>
```

The same selection remains available as an explicit shell command:

```bash
nams-hooks workspaces configure claude --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```
````

In the Codex section, after the credential configuration paragraph, add:

````markdown
Codex does not currently expose a deterministic `/nams-hooks workspaces use`
command. Use the explicit shell command from the hook notice when you need a
session-local workspace selection:

```bash
nams-hooks workspaces configure codex --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```
````

In the Gemini CLI section, after the configuration paragraph, add:

````markdown
Gemini CLI slash-command support for session workspace selection is designed but
deferred until the current Gemini session ID can be resolved deterministically
from a custom command. Use the explicit shell command from the hook notice:

```bash
nams-hooks workspaces configure gemini --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```
````

Add a new OpenCode section before `## Verify Runtime Logs`:

````markdown
## OpenCode

OpenCode uses the project plugin shim in `templates/opencode/plugins/nams-hooks.js`.
When multiple workspaces are available, select one for the current OpenCode
session with:

```text
/nams-hooks workspaces use <workspace-id-or-name>
```

The same selection remains available as an explicit shell command:

```bash
nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>
```
````

- [ ] **Step 6: Update research note status**

In `docs/session-workspace-command-support.md`, add a short note under `## Remaining UX Work`:

```markdown
After the Tier 1 slash-command implementation, Claude Code and OpenCode expose
`/nams-hooks workspaces use <workspace-id-or-name>` as the ergonomic wrapper.
The explicit `nams-hooks workspaces configure ... --scope session ...` command
remains documented for all platforms and for troubleshooting.
```

- [ ] **Step 7: Run docs test to verify it passes**

Run:

```bash
node --import=tsx --test test/slash-workspace-docs.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit docs updates**

Run:

```bash
git add README.md INSTALL.md docs/session-workspace-command-support.md test/slash-workspace-docs.test.ts
git commit -m "docs: document slash workspace command" -m "Co-authored-by: Codex <codex@openai.com>"
```

---

### Task 5: Full Verification And Package Check

**Files:**
- Verify only. No source edits expected.

- [ ] **Step 1: Run default verification**

Run:

```bash
npm run check
```

Expected: PASS. Output should include successful OpenAPI generation, TypeScript build, test typecheck, and `285+` passing tests with `0` failures.

- [ ] **Step 2: Run package verification**

Run:

```bash
npm run package:check
```

Expected: PASS. Output should include `npm run check`, `npm run dist`, and `npm run dist:check`. `dist:check` should verify Claude skill files are included in generated and packed artifacts.

- [ ] **Step 3: Inspect final git status**

Run:

```bash
git status --short
```

Expected: no output. Generated `.build/` and `dist/` are ignored and should not appear.

- [ ] **Step 4: Record final commit list**

Run:

```bash
git log --oneline --decorate --max-count=8
```

Expected: top commits include:

```text
docs: document slash workspace command
feat: add opencode slash workspace command
feat: add claude slash workspace skill
feat: mention slash workspace command in notices
```

Do not create a final empty commit.

## Self-Review Checklist

- Spec coverage: The plan covers Tier 1 Claude and OpenCode implementation, docs/readme updates, user-facing notices, explicit shell command preservation, packaging, and full verification. Gemini and Codex stay deferred and documented.
- Runtime dependency policy: The new Claude helper and OpenCode shim use only Node built-ins.
- Adapter boundary: `src/cli.ts` and shared workspace validation remain unchanged; wrappers delegate to the existing configure command.
- Placeholder scan: This plan contains no placeholder tokens, incomplete task, or "similar to" instruction.
- Type consistency: The plan uses `sessionID` for OpenCode command events, `CLAUDE_SESSION_ID` and `CLAUDE_SKILL_DIR` for Claude, and the existing `--workspace` selector flag everywhere.
