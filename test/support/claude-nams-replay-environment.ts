import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const keys = [
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PLUGIN_OPTION_NAMS_API_KEY",
  "CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID",
  "CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL",
  "NAMS_API_KEY",
  "NAMS_WORKSPACE_ID",
  "NAMS_BASE_URL",
] as const;

export async function withClaudeNamsReplayEnvironment<T>(
  callback: (fixture: string) => Promise<T>,
  overrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<T> {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-claude-replay-env-"));
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<
    (typeof keys)[number],
    string | undefined
  >;
  Object.assign(process.env, {
    HOME: fixture,
    CLAUDE_CONFIG_DIR: path.join(fixture, ".claude"),
    NAMS_API_KEY: "key",
    NAMS_WORKSPACE_ID: "workspace-1",
    NAMS_BASE_URL: "https://memory.example.test",
    ...overrides,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
  try {
    return await callback(fixture);
  } finally {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(fixture, { recursive: true, force: true });
  }
}
