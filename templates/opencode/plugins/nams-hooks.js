import { spawn } from "node:child_process";
import process from "node:process";

export const NamsHooksPlugin = async ({ directory, worktree }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.created") {
        return;
      }

      await runNamsHook({
        event,
        cwd: directory,
        directory,
        worktree,
      });
    },
  };
};

async function runNamsHook(payload) {
  await new Promise((resolve) => {
    const child = spawn("nams-hooks", ["run", "opencode", "--event", "SessionStart"], {
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
    });

    child.on("error", () => {
      resolve();
    });
    child.on("close", () => {
      resolve();
    });
    child.stdin.on("error", () => {
      resolve();
    });
    try {
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    } catch {
      resolve();
    }
  });
}
