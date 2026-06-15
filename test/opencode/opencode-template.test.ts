import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const templatePath = path.join(repoRoot, "templates", "opencode", ".opencode", "plugins", "nams-hooks.js");
const commandPath = path.join(repoRoot, "templates", "opencode", ".opencode", "commands", "nams:workspace.md");

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
  cwd: string;
  stdin: string;
  payload?: Record<string, any>;
}

interface StubOptions {
  stdoutByCommand?: Record<string, unknown>;
}

interface ImportTemplateOptions {
  commandTimeoutMs?: string;
}

test("opencode plugin template exposes NAMS hook handlers", async () => {
  const source = await readFile(templatePath, "utf8");

  assert.match(source, /export const NamsHooks/);
  assert.match(source, /"command\.execute\.before"/);
  assert.match(source, /"chat\.message"/);
  assert.match(source, /"experimental\.chat\.system\.transform"/);
  assert.match(source, /"experimental\.text\.complete"/);
  assert.match(source, /"tool\.execute\.after"/);
  assert.match(source, /session\.created/);
  assert.match(source, /nams-hooks/);
});

test("opencode template exposes workspace command markdown for TUI discovery", async () => {
  const source = await readFile(commandPath, "utf8");

  assert.match(source, /^---\n/);
  assert.match(source, /description: Select the NAMS workspace for this OpenCode session\./);
  assert.match(source, /\/nams:workspace use <workspace-id-or-name>/);
  assert.match(source, /\$ARGUMENTS/);
  assert.match(source, /OpenCode plugin/);
  assert.doesNotMatch(source, /!\s*`/);
  assert.doesNotMatch(source, /workspaces configure/);
  assert.doesNotMatch(source, /workspaces run/);
});

test("command.execute.before forwards OpenCode workspace command to workspace runtime", async () => {
  const fixture = await createNamsHooksStub();
  try {
    const toasts: any[] = [];
    const client = {
      tui: {
        showToast: async (entry: Record<string, any>) => {
          toasts.push(entry.body);
        },
      },
    };
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ client, directory: fixture.directory, project: "project-a", worktree: "worktree-a" });

    const result = await plugin["command.execute.before"]({
      command: "nams:workspace",
      sessionID: "opencode-session-1",
      arguments: ["use", "Engineering Team"],
    });

    const calls = await readCalls(fixture.callsPath);
    assert.deepEqual(result, { stop: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "workspaces",
      "run",
      "opencode",
      "--event",
      "CommandExecuteBefore",
    ]);
    assert.deepEqual(calls[0].payload, {
      command: "nams:workspace",
      sessionID: "opencode-session-1",
      arguments: ["use", "Engineering Team"],
    });
    assert.deepEqual(toasts, [
      {
        title: "NAMS workspace selected",
        message: "workspace configured",
        variant: "success",
        duration: 10000,
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("command.execute.before forwards string-argument OpenCode workspace command", async () => {
  const fixture = await createNamsHooksStub();
  try {
    const toasts: any[] = [];
    const client = {
      tui: {
        showToast: async (entry: Record<string, any>) => {
          toasts.push(entry.body);
        },
      },
    };
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ client, directory: fixture.directory, project: "project-a", worktree: "worktree-a" });

    const result = await plugin["command.execute.before"]({
      command: "nams:workspace",
      sessionID: "opencode-session-1",
      arguments: "use Engineering Team",
    });

    const calls = await readCalls(fixture.callsPath);
    assert.deepEqual(result, { stop: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "workspaces",
      "run",
      "opencode",
      "--event",
      "CommandExecuteBefore",
    ]);
    assert.deepEqual(calls[0].payload, {
      command: "nams:workspace",
      sessionID: "opencode-session-1",
      arguments: "use Engineering Team",
    });
    assert.deepEqual(toasts, [
      {
        title: "NAMS workspace selected",
        message: "workspace configured",
        variant: "success",
        duration: 10000,
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("command.execute.before runs workspace command in OpenCode directory", async () => {
  const fixture = await createNamsHooksStub();
  try {
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ directory: fixture.directory, project: "project-a", worktree: "worktree-a" });

    const result = await plugin["command.execute.before"]({
      command: "nams:workspace",
      sessionID: "opencode-session-1",
      arguments: ["use", "Engineering"],
    });

    const calls = await readCalls(fixture.callsPath);
    assert.deepEqual(result, { stop: true });
    assert.equal(calls.length, 1);
    assert.equal(await realpath(calls[0].cwd), await realpath(fixture.directory));
    assert.deepEqual(calls[0].args, ["workspaces", "run", "opencode", "--event", "CommandExecuteBefore"]);
  } finally {
    await fixture.cleanup();
  }
});

test("command.execute.before ignores unrelated OpenCode commands", async () => {
  const fixture = await createNamsHooksStub();
  try {
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ directory: fixture.directory, project: "project-a", worktree: "worktree-a" });

    const otherCommand = await plugin["command.execute.before"]({
      command: "other",
      sessionID: "opencode-session-1",
      arguments: ["use", "Engineering Team"],
    });
    const otherSubcommand = await plugin["command.execute.before"]({
      command: "nams:workspace",
      sessionID: "opencode-session-1",
      arguments: ["list"],
    });

    assert.equal(otherCommand, undefined);
    assert.equal(otherSubcommand, undefined);
    const calls = await readCalls(fixture.callsPath);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["workspaces", "run", "opencode", "--event", "CommandExecuteBefore"]);
    assert.deepEqual(calls[0].payload, {
      command: "nams:workspace",
      sessionID: "opencode-session-1",
      arguments: ["list"],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("command.execute.before reports invalid OpenCode workspace command forms", async () => {
  const fixture = await createNamsHooksStub({
    stdoutByCommand: {
      invalidWorkspaceCommands: true,
    },
  });
  try {
    const toasts: any[] = [];
    const client = {
      tui: {
        showToast: async (entry: Record<string, any>) => {
          toasts.push(entry.body);
        },
      },
    };
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ client, directory: fixture.directory, project: "project-a", worktree: "worktree-a" });

    const missingSelector = await plugin["command.execute.before"]({
      command: "nams:workspace",
      sessionID: "opencode-session-1",
      arguments: ["use"],
    });
    const missingSession = await plugin["command.execute.before"]({
      command: "nams:workspace",
      sessionID: " ",
      arguments: ["use", "Engineering Team"],
    });

    assert.deepEqual(missingSelector, { stop: true });
    assert.deepEqual(missingSession, { stop: true });
    assert.equal(toasts.length, 2);
    assert.equal(toasts[0].variant, "danger");
    assert.match(toasts[0].message, /Usage: \/nams:workspace use <workspace-id-or-name>/);
    assert.equal(toasts[1].variant, "danger");
    assert.match(toasts[1].message, /OpenCode session id is unavailable/);
    assert.match(toasts[1].message, /--workspace 'Engineering Team'/);
    const calls = await readCalls(fixture.callsPath);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.args), [
      ["workspaces", "run", "opencode", "--event", "CommandExecuteBefore"],
      ["workspaces", "run", "opencode", "--event", "CommandExecuteBefore"],
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("command.execute.before times out hanging workspace configure", async () => {
  const fixture = await createNamsHooksStub({
    stdoutByCommand: {
      configureHangMs: 1000,
    },
  });
  try {
    const toasts: any[] = [];
    const client = {
      tui: {
        showToast: async (entry: Record<string, any>) => {
          toasts.push(entry.body);
        },
      },
    };
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath, {
      commandTimeoutMs: "50",
    });
    const plugin = await NamsHooks({ client, directory: fixture.directory, project: "project-a", worktree: "worktree-a" });

    const startedAt = Date.now();
    const result = await plugin["command.execute.before"]({
      command: "nams:workspace",
      sessionID: "opencode-session-1",
      arguments: ["use", "Engineering"],
    });
    const durationMs = Date.now() - startedAt;

    assert.deepEqual(result, { stop: true });
    assert.ok(durationMs < 900, `expected timeout before hanging stub exited, took ${durationMs}ms`);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].variant, "danger");
    assert.match(toasts[0].message, /workspace command timed out after 50ms/);
  } finally {
    await fixture.cleanup();
  }
});

test("command.execute.before surfaces failed workspace configure output", async () => {
  const fixture = await createNamsHooksStub({
    stdoutByCommand: {
      configureFailure: true,
    },
  });
  try {
    const toasts: any[] = [];
    const client = {
      tui: {
        showToast: async (entry: Record<string, any>) => {
          toasts.push(entry.body);
        },
      },
    };
    const { NamsHooks } = await importTemplateWithCommand(fixture.commandPath);
    const plugin = await NamsHooks({ client, directory: fixture.directory, project: "project-a", worktree: "worktree-a" });

    const result = await plugin["command.execute.before"]({
      command: "nams:workspace",
      sessionID: "opencode-session-1",
      arguments: "use Engineering",
    });

    const calls = await readCalls(fixture.callsPath);
    assert.deepEqual(result, { stop: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(toasts, [
      {
        title: "NAMS workspace selection failed",
        message: "workspace failed",
        variant: "danger",
        duration: 30000,
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
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
    const payload = requirePayload(calls[0]);
    assert.equal(payload.hook, "chat.message");
    assert.deepEqual(payload.input, input);
    assert.deepEqual(payload.output, output);
  } finally {
    await fixture.cleanup();
  }
});

test("chat.message handler logs workspace selection requirement and skips memory", async () => {
  const reason = [
    "NAMS memory is inactive for this turn.",
    "No memory messages were stored. Multiple NAMS workspaces are available, and no workspaceId is configured.",
    "Configure a session workspace before memory can resume: nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>",
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
    "Configure a session workspace before memory can resume: nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>",
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
    "Configure a session workspace before memory can resume: nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace <workspace-id-or-name>",
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
    assert.equal(requirePayload(calls[0]).hook, "chat.message");
    assert.equal(requirePayload(calls[1]).hook, "experimental.chat.system.transform");
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
    const payload = requirePayload(calls[0]);
    assert.equal(payload.hook, "event");
    assert.deepEqual(payload.event, event);
    assert.equal(payload.directory, fixture.directory);
    assert.equal(payload.project, "project-session");
    assert.equal(payload.worktree, "worktree-session");
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
    const payload = requirePayload(calls[0]);
    assert.equal(payload.hook, "experimental.chat.system.transform");
    assert.deepEqual(payload.input, input);
    assert.deepEqual(payload.output, { system: ["existing system"] });
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
    const payload = requirePayload(calls[0]);
    assert.equal(payload.hook, "experimental.text.complete");
    assert.deepEqual(payload.input, input);
    assert.deepEqual(payload.output, output);
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
    const payload = requirePayload(calls[0]);
    assert.equal(payload.hook, "tool.execute.after");
    assert.deepEqual(payload.input, input);
    assert.deepEqual(payload.output, output);
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
  const trimmedStdin = stdin.trim();
  const payload = trimmedStdin === "" ? undefined : JSON.parse(trimmedStdin);
  appendFileSync(callsPath, JSON.stringify({ args, cwd: process.cwd(), payload, stdin }) + "\\n");
  if (commandName === "workspaces") {
    if (payload?.command === "nams:workspace" && Array.isArray(payload.arguments) && payload.arguments[0] !== "use") {
      process.stdout.write(JSON.stringify({}));
      return;
    }
    if (stdoutByCommand.invalidWorkspaceCommands === true) {
      const argumentValue = payload?.arguments;
      const argumentParts = Array.isArray(argumentValue) ? argumentValue : String(argumentValue ?? "").trim().split(/\\s+/);
      if (argumentParts[0] === "use" && argumentParts.slice(1).join(" ").trim() === "") {
        process.stdout.write(JSON.stringify({
          stop: true,
          code: 1,
          stdout: "",
          stderr: "Usage: /nams:workspace use <workspace-id-or-name>",
        }));
        return;
      }
      if (typeof payload?.sessionID === "string" && payload.sessionID.trim() === "") {
        process.stdout.write(JSON.stringify({
          stop: true,
          code: 1,
          stdout: "",
          stderr: [
            "OpenCode session id is unavailable.",
            "Configure manually after replacing <session-id>: nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace 'Engineering Team'",
          ].join("\\n"),
        }));
        return;
      }
    }
    if (stdoutByCommand.configureFailure === true) {
      process.stdout.write(JSON.stringify({ stop: true, code: 2, stdout: "", stderr: "workspace failed\\n" }));
      return;
    }
    if (typeof stdoutByCommand.configureHangMs === "number") {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ stop: true, code: 0, stdout: "late workspace configured\\n", stderr: "" }));
      }, stdoutByCommand.configureHangMs);
      return;
    }
    process.stdout.write(JSON.stringify({ stop: true, code: 0, stdout: "workspace configured\\n", stderr: "" }));
    return;
  }
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

async function importTemplateWithCommand(commandPath: string, options: ImportTemplateOptions = {}): Promise<TemplateModule> {
  const imported = (await import(`${pathToFileURL(templatePath).href}?test=${Date.now()}-${Math.random()}`)) as TemplateModule;
  return {
    NamsHooks: async (context) => {
      const previousCommand = process.env.NAMS_HOOKS_COMMAND;
      const previousTimeout = process.env.NAMS_HOOKS_WORKSPACE_COMMAND_TIMEOUT_MS;
      process.env.NAMS_HOOKS_COMMAND = commandPath;
      if (options.commandTimeoutMs !== undefined) {
        process.env.NAMS_HOOKS_WORKSPACE_COMMAND_TIMEOUT_MS = options.commandTimeoutMs;
      }
      try {
        return await imported.NamsHooks(context);
      } finally {
        restoreEnv("NAMS_HOOKS_COMMAND", previousCommand);
        restoreEnv("NAMS_HOOKS_WORKSPACE_COMMAND_TIMEOUT_MS", previousTimeout);
      }
    },
  };
}

async function readCalls(callsPath: string): Promise<TemplateCall[]> {
  let source = "";
  try {
    source = await readFile(callsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return source
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TemplateCall);
}

function requirePayload(call: TemplateCall): Record<string, any> {
  assert.ok(call.payload);
  return call.payload;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
