import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const keys = [
  "HOME",
  "CODEX_HOME",
  "NAMS_API_KEY",
  "NAMS_WORKSPACE_ID",
  "NAMS_BASE_URL",
] as const;

export async function withNamsReplayEnvironment<T>(
  callback: (fixture: string) => Promise<T>,
  overrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<T> {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-codex-replay-env-"));
  const saved = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof keys)[number], string | undefined>;
  Object.assign(process.env, {
    HOME: fixture,
    CODEX_HOME: path.join(fixture, ".codex"),
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
