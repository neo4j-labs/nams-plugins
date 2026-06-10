import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const templatePath = path.join(repoRoot, "templates", "opencode", "plugins", "nams-hooks.js");

interface TemplateFixture {
  directory: string;
  commandPath: string;
  callsPath: string;
  cleanup(): Promise<void>;
}

interface TemplateModule {
  NamsHooks(context: Record<string, any>): Promise<Record<string, any>>;
}

interface TemplateCall {
  args: string[];
  payload: Record<string, any>;
}

interface StubOptions {
  stdoutByCommand?: Record<string, unknown>;
}

test("opencode plugin template exposes NAMS hook handlers", async () => {
  const source = await readFile(templatePath, "utf8");

  assert.match(source, /export const NamsHooks/);
  assert.match(source, /"chat\.message"/);
  assert.match(source, /"experimental\.chat\.system\.transform"/);
  assert.match(source, /"experimental\.text\.complete"/);
  assert.match(source, /"tool\.execute\.after"/);
  assert.match(source, /session\.created/);
  assert.match(source, /nams-hooks/);
});

test("chat.message handler routes through the memory command", async () => {
  const fixture = await createNamsHooksStub();
  try {
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ directory: fixture.directory, project: "project-a", worktree: "worktree-a" });
    const input = { message: { id: "message-1", parts: [{ type: "text", text: "hello" }] } };
    const output = { ok: true };

    const result = await plugin["chat.message"](input, output);

    const calls = await readCalls(fixture.callsPath);
    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["run", "opencode", "--event", "BeforeAgent"]);
    assert.equal(calls[0].payload.hook, "chat.message");
    assert.deepEqual(calls[0].payload.input, input);
    assert.deepEqual(calls[0].payload.output, output);
  } finally {
    await fixture.cleanup();
  }
});

test("chat.message handler logs workspace selection requirement and skips memory", async () => {
  const reason = [
    "NAMS memory is inactive for this turn.",
    "No memory messages were stored. Multiple NAMS workspaces are available, and no workspaceId is configured.",
    "Configure an explicit workspace before memory can resume: nams-hooks workspaces configure opencode --scope project --workspace-id <workspace-id>",
    "Available NAMS workspaces:",
    "1. Engineering (owner, active) - workspace-1",
  ].join("\n");
  const fixture = await createNamsHooksStub({
    stdoutByCommand: {
      run: { namsWorkspaceSelectionRequired: true, reason },
    },
  });
  try {
    const logs: any[] = [];
    const client = {
      app: {
        log: async (entry: Record<string, any>) => {
          logs.push(entry);
        },
      },
    };
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ client, directory: fixture.directory, project: "project-a", worktree: "worktree-a" });
    const input = { message: { id: "message-1", parts: [{ type: "text", text: "hello" }] } };
    const output = { ok: true };

    const result = await plugin["chat.message"](input, output);

    const calls = await readCalls(fixture.callsPath);
    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["run", "opencode", "--event", "BeforeAgent"]);
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0].body, {
      service: "nams-hooks",
      level: "warn",
      message: reason,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("chat.message handler shows workspace selection requirement in OpenCode TUI", async () => {
  const reason = [
    "NAMS memory is inactive for this turn.",
    "No memory messages were stored. Multiple NAMS workspaces are available, and no workspaceId is configured.",
    "Configure an explicit workspace before memory can resume: nams-hooks workspaces configure opencode --scope project --workspace-id <workspace-id>",
  ].join("\n");
  const fixture = await createNamsHooksStub({
    stdoutByCommand: {
      run: { namsWorkspaceSelectionRequired: true, reason },
    },
  });
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

    await plugin["chat.message"]({ sessionID: "session-1" }, { ok: true });

    assert.deepEqual(toasts, [
      {
        body: {
          title: "NAMS memory inactive",
          message: reason,
          variant: "warning",
          duration: 30000,
        },
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("system transform handler surfaces pending workspace selection requirement", async () => {
  const reason = [
    "NAMS memory is inactive for this turn.",
    "No memory messages were stored. Multiple NAMS workspaces are available, and no workspaceId is configured.",
    "Configure an explicit workspace before memory can resume: nams-hooks workspaces configure opencode --scope project --workspace-id <workspace-id>",
    "Available NAMS workspaces:",
    "1. Engineering (owner, active) - workspace-1",
  ].join("\n");
  const fixture = await createNamsHooksStub({
    stdoutByCommand: {
      run: { namsWorkspaceSelectionRequired: true, reason },
    },
  });
  try {
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ directory: fixture.directory, project: "project-a", worktree: "worktree-a" });
    const chatInput = {
      sessionID: "session-1",
      message: { id: "message-1", parts: [{ type: "text", text: "hello" }] },
    };

    await plugin["chat.message"](chatInput, { ok: true });
    const output = { system: [] };
    const result = await plugin["experimental.chat.system.transform"]({ sessionID: "session-1" }, output);

    assert.equal(result, output);
    assert.deepEqual(output.system, [reason]);
    const calls = await readCalls(fixture.callsPath);
    assert.deepEqual(calls.map((call) => call.args), [
      ["run", "opencode", "--event", "BeforeAgent"],
      ["run", "opencode", "--event", "BeforeAgent"],
    ]);
    assert.equal(calls[0].payload.hook, "chat.message");
    assert.equal(calls[1].payload.hook, "experimental.chat.system.transform");
  } finally {
    await fixture.cleanup();
  }
});

test("event handler sends session.created payload to SessionStart", async () => {
  const fixture = await createNamsHooksStub();
  try {
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ directory: fixture.directory, project: "project-session", worktree: "worktree-session" });
    const event = { type: "session.created", properties: { info: { id: "session-1" } } };

    await plugin.event({ event });

    const calls = await readCalls(fixture.callsPath);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["run", "opencode", "--event", "SessionStart"]);
    assert.equal(calls[0].payload.hook, "event");
    assert.deepEqual(calls[0].payload.event, event);
    assert.equal(calls[0].payload.directory, fixture.directory);
    assert.equal(calls[0].payload.project, "project-session");
    assert.equal(calls[0].payload.worktree, "worktree-session");
  } finally {
    await fixture.cleanup();
  }
});

test("system transform handler appends returned memory context with two-argument shape", async () => {
  const fixture = await createNamsHooksStub();
  try {
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ directory: fixture.directory, project: "project-b", worktree: "worktree-b" });
    const input = { sessionID: "session-1" };
    const output = { system: ["existing system"] };

    const result = await plugin["experimental.chat.system.transform"](input, output);

    assert.equal(result, output);
    assert.deepEqual(output.system, ["existing system", "remember this"]);
    const calls = await readCalls(fixture.callsPath);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.hook, "experimental.chat.system.transform");
    assert.deepEqual(calls[0].payload.input, input);
    assert.deepEqual(calls[0].payload.output, { system: ["existing system"] });
  } finally {
    await fixture.cleanup();
  }
});

test("experimental.text.complete handler sends assistant completion payload to AfterAgent", async () => {
  const fixture = await createNamsHooksStub();
  try {
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ directory: fixture.directory, project: "project-assistant", worktree: "worktree-assistant" });
    const input = { sessionID: "session-1", messageID: "assistant-1", partID: "part-1" };
    const output = { text: "Hello!" };

    const result = await plugin["experimental.text.complete"](input, output);

    const calls = await readCalls(fixture.callsPath);
    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["run", "opencode", "--event", "AfterAgent"]);
    assert.equal(calls[0].payload.hook, "experimental.text.complete");
    assert.deepEqual(calls[0].payload.input, input);
    assert.deepEqual(calls[0].payload.output, output);
  } finally {
    await fixture.cleanup();
  }
});

test("tool.execute.after handler sends tool payload to AfterTool", async () => {
  const fixture = await createNamsHooksStub();
  try {
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ directory: fixture.directory, project: "project-tool", worktree: "worktree-tool" });
    const input = { sessionID: "session-1", callID: "call-1", tool: "bash", args: { command: "npm test" } };
    const output = { title: "npm test", output: "100 tests pass" };

    const result = await plugin["tool.execute.after"](input, output);

    const calls = await readCalls(fixture.callsPath);
    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["run", "opencode", "--event", "AfterTool"]);
    assert.equal(calls[0].payload.hook, "tool.execute.after");
    assert.deepEqual(calls[0].payload.input, input);
    assert.deepEqual(calls[0].payload.output, output);
  } finally {
    await fixture.cleanup();
  }
});

async function createNamsHooksStub(options: StubOptions = {}): Promise<TemplateFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nams-opencode-template-"));
  const commandPath = path.join(directory, "nams-hooks-stub.js");
  const callsPath = path.join(directory, "calls.jsonl");
  const stdoutByCommand = options.stdoutByCommand ?? {};
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
  const payload = JSON.parse(stdin);
  appendFileSync(callsPath, JSON.stringify({ args, payload }) + "\\n");
  if (Object.hasOwn(stdoutByCommand, commandName)) {
    const output = stdoutByCommand[commandName];
    if (output !== undefined) {
      process.stdout.write(JSON.stringify(output));
    }
    return;
  }
  if (commandName === "run" && payload.hook === "experimental.chat.system.transform") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "remember this" } }));
  }
});
`,
    "utf8",
  );
  await chmod(commandPath, 0o755);
  return {
    callsPath,
    commandPath,
    directory,
    cleanup: async () => {
      await rm(directory, { force: true, recursive: true });
    },
  };
}

async function importTemplateWithCommand(commandPath: string): Promise<TemplateModule> {
  const previousCommand = process.env.NAMS_HOOKS_COMMAND;
  process.env.NAMS_HOOKS_COMMAND = commandPath;
  try {
    return (await import(`${pathToFileURL(templatePath).href}?test=${Date.now()}-${Math.random()}`)) as TemplateModule;
  } finally {
    restoreEnv("NAMS_HOOKS_COMMAND", previousCommand);
  }
}

async function readCalls(callsPath: string): Promise<TemplateCall[]> {
  const source = await readFile(callsPath, "utf8");
  return source
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TemplateCall);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
