import { spawn } from "node:child_process";

const command = process.env.NAMS_HOOKS_COMMAND ?? "nams-hooks";

export const NamsHooks = async ({ client, directory, project, worktree }) => {
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

    "chat.message": async (input, output) => {
      await run("BeforeAgent", { hook: "chat.message", input, output });
    },

    "experimental.chat.system.transform": async (input, output) => {
      const result = await run("BeforeAgent", { hook: "experimental.chat.system.transform", input, output });
      const additionalContext = result?.hookSpecificOutput?.additionalContext;
      if (typeof additionalContext === "string" && additionalContext.trim() !== "") {
        if (!Array.isArray(output.system)) {
          output.system = [];
        }
        output.system.push(additionalContext);
      }
      return output;
    },

    "experimental.text.complete": async (input, output) => {
      await run("AfterAgent", { hook: "experimental.text.complete", input, output });
    },

    "tool.execute.after": async (input, output) => {
      await run("AfterTool", { hook: "tool.execute.after", input, output });
    },
  };
};

export default NamsHooks;

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
