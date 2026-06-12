import { spawn } from "node:child_process";

const command = process.env.NAMS_HOOKS_COMMAND ?? "nams-hooks";
const workspaceConfigureTimeoutMs = readPositiveInteger(
  process.env.NAMS_HOOKS_WORKSPACE_CONFIGURE_TIMEOUT_MS,
  30000,
);

export const NamsHooks = async ({ client, directory, project, worktree }) => {
  const pendingWorkspaceSelectionContexts = new Map();

  async function run(event, payload) {
    try {
      return await invokeNams(event, { directory, project, worktree, ...payload });
    } catch {
      await logDiagnostic(client, `NAMS OpenCode hook ${event} failed`);
      return undefined;
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "session.created") {
        return;
      }

      await run("SessionStart", { hook: "event", event });
    },

    "command.execute.before": async (input) => {
      const parsed = parseWorkspaceUseCommand(input);
      if (parsed === undefined) {
        return undefined;
      }

      if (parsed.selector === "") {
        await showCommandResult(client, {
          code: 1,
          stdout: "",
          stderr: "Usage: /nams:workspace use <workspace-id-or-name>",
        });
        return { stop: true };
      }

      const sessionId = typeof input?.sessionID === "string" ? input.sessionID.trim() : "";
      if (sessionId === "") {
        await showCommandResult(client, {
          code: 1,
          stdout: "",
          stderr: [
            "OpenCode session id is unavailable.",
            `Configure manually after replacing <session-id>: nams-hooks workspaces configure opencode --scope session --session-id <session-id> --workspace ${shellQuote(parsed.selector)}`,
          ].join("\n"),
        });
        return { stop: true };
      }

      const result = await invokeWorkspaceConfigure(sessionId, parsed.selector, directory);
      await showCommandResult(client, result);
      return { stop: true };
    },

    "chat.message": async (input, output) => {
      const memoryResult = await run("BeforeAgent", { hook: "chat.message", input, output });
      if (memoryResult?.namsWorkspaceSelectionRequired === true) {
        const reason = memoryResult.reason ?? "NAMS workspace selection required";
        rememberWorkspaceSelectionContext(input, reason);
        await logDiagnostic(client, reason);
        await showWarning(client, reason);
        return;
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const result = await run("BeforeAgent", { hook: "experimental.chat.system.transform", input, output });
      appendSystemContext(output, takeWorkspaceSelectionContext(input));
      appendSystemContext(output, result?.hookSpecificOutput?.additionalContext);
      return output;
    },

    "experimental.text.complete": async (input, output) => {
      await run("AfterAgent", { hook: "experimental.text.complete", input, output });
    },

    "tool.execute.after": async (input, output) => {
      await run("AfterTool", { hook: "tool.execute.after", input, output });
    },
  };

  function rememberWorkspaceSelectionContext(input, context) {
    if (typeof context !== "string" || context.trim() === "") {
      return;
    }
    pendingWorkspaceSelectionContexts.set(opencodeContextKey(input), context);
  }

  function takeWorkspaceSelectionContext(input) {
    const key = opencodeContextKey(input);
    const context = pendingWorkspaceSelectionContexts.get(key) ?? pendingWorkspaceSelectionContexts.get("__default__");
    pendingWorkspaceSelectionContexts.delete(key);
    if (key !== "__default__") {
      pendingWorkspaceSelectionContexts.delete("__default__");
    }
    return context;
  }
};

export default NamsHooks;

async function invokeWorkspaceConfigure(sessionId, workspaceSelector, directory) {
  return await new Promise((resolve) => {
    const cwd = typeof directory === "string" && directory.trim() !== "" ? directory : undefined;
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
        ...(cwd === undefined ? {} : { cwd }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout = setTimeout(() => {
      finish({
        code: 1,
        stdout,
        stderr: `nams-hooks workspace configure timed out after ${workspaceConfigureTimeoutMs}ms`,
      });
      child.kill();
    }, workspaceConfigureTimeoutMs);

    function finish(value) {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      resolve(value);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      finish({ code: code ?? 1, stdout, stderr });
    });
  });
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function invokeNams(event, payload) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, ["run", "opencode", "--event", event], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    function finish(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || `nams-hooks exited with status ${code}`));
        return;
      }

      const trimmed = stdout.trim();
      if (trimmed === "") {
        finish(undefined, undefined);
        return;
      }

      try {
        finish(undefined, JSON.parse(trimmed));
      } catch (error) {
        finish(error);
      }
    });
    child.stdin.on("error", () => {});

    try {
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      finish(error);
    }
  });
}

async function logDiagnostic(client, message) {
  try {
    await client?.app?.log?.({ body: { service: "nams-hooks", level: "warn", message } });
  } catch {}
}

async function showWarning(client, message) {
  try {
    await client?.tui?.showToast?.({
      body: {
        title: "NAMS memory inactive",
        message,
        variant: "warning",
        duration: 30000,
      },
    });
  } catch {}
}

function parseWorkspaceUseCommand(input) {
  if (input?.command !== "nams:workspace") {
    return undefined;
  }

  const parts = commandArgumentParts(input?.arguments);
  if (parts[0] !== "use") {
    return undefined;
  }

  return { selector: workspaceSelectorFromArguments(input?.arguments) };
}

function commandArgumentParts(argumentValue) {
  if (Array.isArray(argumentValue)) {
    return argumentValue.map((part) => String(part).trim());
  }
  if (typeof argumentValue === "string") {
    const trimmed = argumentValue.trim();
    return trimmed === "" ? [] : trimmed.split(/\s+/);
  }
  return [];
}

function workspaceSelectorFromArguments(argumentValue) {
  if (Array.isArray(argumentValue)) {
    return argumentValue
      .slice(1)
      .map((part) => String(part))
      .join(" ")
      .trim();
  }
  if (typeof argumentValue === "string") {
    const match = argumentValue.match(/^\s*use(?:\s+([\s\S]*?))?\s*$/);
    return match?.[1]?.trim() ?? "";
  }
  return "";
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_/:=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function showCommandResult(client, result) {
  const success = result.code === 0;
  const message = (success ? result.stdout : result.stderr || result.stdout).trim();
  try {
    await client?.tui?.showToast?.({
      body: {
        title: success ? "NAMS workspace selected" : "NAMS workspace selection failed",
        message: message || (success ? "Workspace configured." : "Workspace selection failed."),
        variant: success ? "success" : "danger",
        duration: success ? 10000 : 30000,
      },
    });
  } catch {}
}

function appendSystemContext(output, context) {
  if (typeof context !== "string" || context.trim() === "") {
    return;
  }
  if (!Array.isArray(output.system)) {
    output.system = [];
  }
  output.system.push(context);
}

function opencodeContextKey(input) {
  for (const candidate of [
    input?.sessionID,
    input?.sessionId,
    input?.message?.sessionID,
    input?.message?.sessionId,
  ]) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
  }
  return "__default__";
}
