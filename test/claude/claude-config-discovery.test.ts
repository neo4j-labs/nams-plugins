import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverClaudeNamsConfig } from "../../src/platforms/claude/config.js";
import { loadNamsConfig } from "../../src/runtime/config.js";

type RuntimeEnvOverrides = Record<string, string | undefined>;

interface ConfigFixture {
  homeDir: string;
  projectDir: string;
}

async function withFixture(fn: (fixture: ConfigFixture) => Promise<void>): Promise<void> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "nams-claude-config-"));
  const homeDir = path.join(fixtureDir, "home");
  const projectDir = path.join(fixtureDir, "project");
  try {
    await mkdir(homeDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await fn({ homeDir, projectDir });
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

function useRuntimeEnv(homeDir: string, overrides: RuntimeEnvOverrides = {}): void {
  for (const key of [
    "HOME",
    "USERPROFILE",
    "NAMS_API_KEY",
    "NAMS_WORKSPACE_ID",
    "NAMS_BASE_URL",
    "CLAUDE_PLUGIN_OPTION_NAMS_API_KEY",
    "CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID",
    "CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL",
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, { HOME: homeDir, USERPROFILE: homeDir, ...overrides });
}

async function writeGlobalConfig(homeDir: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(homeDir, ".nams"), { recursive: true });
  await writeFile(path.join(homeDir, ".nams", "config.json"), JSON.stringify(config), "utf8");
}

test("Claude config discovery fills NAMS config from plugin userConfig environment", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    useRuntimeEnv(homeDir, {
      CLAUDE_PLUGIN_OPTION_NAMS_API_KEY: "plugin-key",
      CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID: "plugin-workspace",
      CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL: "https://plugin.example.test",
    });

    const result = await loadNamsConfig(projectDir, discoverClaudeNamsConfig);

    assert.deepEqual(result, {
      ok: true,
      config: {
        apiKey: "plugin-key",
        workspaceId: "plugin-workspace",
        baseUrl: "https://plugin.example.test",
      },
      sources: {
        apiKey: "platform:claude:CLAUDE_PLUGIN_OPTION_NAMS_API_KEY",
        workspaceId: "platform:claude:CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID",
        baseUrl: "platform:claude:CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL",
      },
    });
  });
});

test("Claude config discovery ignores missing or blank plugin userConfig environment", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await writeGlobalConfig(homeDir, {
      apiKey: "global-key",
      workspaceId: "global-workspace",
      baseUrl: "https://global.example.test",
    });
    useRuntimeEnv(homeDir, {
      CLAUDE_PLUGIN_OPTION_NAMS_API_KEY: "",
      CLAUDE_PLUGIN_OPTION_NAMS_WORKSPACE_ID: "  ",
      CLAUDE_PLUGIN_OPTION_NAMS_BASE_URL: "\t",
    });

    const result = await loadNamsConfig(projectDir, discoverClaudeNamsConfig);

    assert.deepEqual(result, {
      ok: true,
      config: {
        apiKey: "global-key",
        workspaceId: "global-workspace",
        baseUrl: "https://global.example.test",
      },
      sources: {
        apiKey: "global:~/.nams/config.json",
        workspaceId: "global:~/.nams/config.json",
        baseUrl: "global:~/.nams/config.json",
      },
    });
  });
});
