import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configDiagnosticPayload, loadNamsConfig } from "../src/runtime/config.js";

interface ConfigFixture {
  fixtureDir: string;
  homeDir: string;
  projectDir: string;
}

type RuntimeEnvOverrides = Record<string, string | undefined>;
type JsonObject = Record<string, unknown>;

async function withFixture(fn: (fixture: ConfigFixture) => Promise<void>): Promise<void> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "nams-config-"));
  const homeDir = path.join(fixtureDir, "home");
  const projectDir = path.join(fixtureDir, "project");
  try {
    await mkdir(homeDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await fn({ fixtureDir, homeDir, projectDir });
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

function useRuntimeEnv(homeDir: string, overrides: RuntimeEnvOverrides = {}): void {
  for (const key of ["HOME", "USERPROFILE", "NAMS_API_KEY", "NAMS_BASE_URL"]) {
    delete process.env[key];
  }
  Object.assign(process.env, { HOME: homeDir, USERPROFILE: homeDir, ...overrides });
}

async function writeGlobalConfig(homeDir: string, config: JsonObject): Promise<void> {
  await mkdir(path.join(homeDir, ".nams"), { recursive: true });
  await writeFile(path.join(homeDir, ".nams", "config.json"), JSON.stringify(config), "utf8");
}

async function writeProjectConfig(projectDir: string, config: JsonObject): Promise<void> {
  await mkdir(path.join(projectDir, ".nams"), { recursive: true });
  await writeFile(path.join(projectDir, ".nams", "config.json"), JSON.stringify(config), "utf8");
}

test("loads global JSON config by default", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await writeGlobalConfig(homeDir, {
      apiKey: "global-key",
      baseUrl: "https://global.example.test",
    });
    useRuntimeEnv(homeDir);
    const result = await loadNamsConfig(projectDir);

    assert.deepEqual(result, {
      ok: true,
      config: {
        apiKey: "global-key",
        baseUrl: "https://global.example.test",
      },
      sources: {
        apiKey: "global:~/.nams/config.json",
        baseUrl: "global:~/.nams/config.json",
      },
    });
  });
});

test("project JSON config overlays global JSON config", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await writeGlobalConfig(homeDir, {
      apiKey: "global-key",
      baseUrl: "https://global.example.test",
    });
    await writeProjectConfig(projectDir, {
      apiKey: "project-key",
    });
    useRuntimeEnv(homeDir);
    const result = await loadNamsConfig(projectDir);

    assert.deepEqual(result, {
      ok: true,
      config: {
        apiKey: "project-key",
        baseUrl: "https://global.example.test",
      },
      sources: {
        apiKey: "project:.nams/config.json",
        baseUrl: "global:~/.nams/config.json",
      },
    });
  });
});

test("environment variables overlay project and global JSON config", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await writeGlobalConfig(homeDir, {
      apiKey: "global-key",
      baseUrl: "https://global.example.test",
    });
    await writeProjectConfig(projectDir, {
      apiKey: "project-key",
      baseUrl: "https://project.example.test",
    });
    useRuntimeEnv(homeDir, {
      NAMS_API_KEY: "env-key",
      NAMS_BASE_URL: "https://env.example.test",
    });
    const result = await loadNamsConfig(projectDir);

    assert.deepEqual(result, {
      ok: true,
      config: {
        apiKey: "env-key",
        baseUrl: "https://env.example.test",
      },
      sources: {
        apiKey: "env:NAMS_API_KEY",
        baseUrl: "env:NAMS_BASE_URL",
      },
    });
  });
});

test("does not read project dotenv config files", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".nams", ".env"),
      "NAMS_API_KEY=file-key\nNAMS_BASE_URL=https://file.example.test\n",
      "utf8",
    );
    useRuntimeEnv(homeDir);
    const result = await loadNamsConfig(projectDir);

    assert.deepEqual(result, {
      ok: false,
      reason: "missing-api-key",
      sources: {
        apiKey: "missing",
        baseUrl: "default",
      },
    });
  });
});

test("missing apiKey returns structured non-ok result", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    useRuntimeEnv(homeDir);
    const result = await loadNamsConfig(projectDir);

    assert.deepEqual(result, {
      ok: false,
      reason: "missing-api-key",
      sources: {
        apiKey: "missing",
        baseUrl: "default",
      },
    });
  });
});

test("invalid JSON returns structured non-ok result without raw file content", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await mkdir(path.join(homeDir, ".nams"), { recursive: true });
    await writeFile(path.join(homeDir, ".nams", "config.json"), '{"apiKey":"secret-key"', "utf8");
    useRuntimeEnv(homeDir);
    const result = await loadNamsConfig(projectDir);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-json");
    assert.equal(result.errorSource, "global:~/.nams/config.json");
    assert.deepEqual(result.sources, {
      apiKey: "missing",
      baseUrl: "default",
    });
    assert.doesNotMatch(JSON.stringify(result), /secret-key/);
  });
});

test("invalid project JSON preserves global source metadata", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await writeGlobalConfig(homeDir, {
      apiKey: "global-key",
      baseUrl: "https://global.example.test",
    });
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await writeFile(path.join(projectDir, ".nams", "config.json"), '{"apiKey":"secret-project-key"', "utf8");
    useRuntimeEnv(homeDir);
    const result = await loadNamsConfig(projectDir);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-json");
    assert.equal(result.errorSource, "project:.nams/config.json");
    assert.deepEqual(result.sources, {
      apiKey: "global:~/.nams/config.json",
      baseUrl: "global:~/.nams/config.json",
    });
    assert.doesNotMatch(JSON.stringify(result), /secret-project-key|global-key|global\.example/);
  });
});

test("unreadable global config path returns structured non-ok result", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await mkdir(path.join(homeDir, ".nams", "config.json"), { recursive: true });
    useRuntimeEnv(homeDir, {
      NAMS_API_KEY: "env-secret-key",
    });
    const result = await loadNamsConfig(projectDir);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-json");
    assert.equal(result.errorSource, "global:~/.nams/config.json");
    assert.deepEqual(result.sources, {
      apiKey: "missing",
      baseUrl: "default",
    });
    assert.doesNotMatch(JSON.stringify(result), /env-secret-key|EISDIR|illegal operation|is a directory/i);
  });
});

test("unreadable project config path returns structured non-ok result with global source metadata", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await writeGlobalConfig(homeDir, {
      apiKey: "global-key",
      baseUrl: "https://global.example.test",
    });
    await mkdir(path.join(projectDir, ".nams", "config.json"), { recursive: true });
    useRuntimeEnv(homeDir, {
      NAMS_API_KEY: "env-secret-key",
    });
    const result = await loadNamsConfig(projectDir);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-json");
    assert.equal(result.errorSource, "project:.nams/config.json");
    assert.deepEqual(result.sources, {
      apiKey: "global:~/.nams/config.json",
      baseUrl: "global:~/.nams/config.json",
    });
    assert.doesNotMatch(JSON.stringify(result), /env-secret-key|global-key|global\.example|EISDIR|illegal operation|is a directory/i);
  });
});

test("configDiagnosticPayload includes sources but not secret values", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await writeGlobalConfig(homeDir, {
      apiKey: "secret-global-key",
      baseUrl: "https://global.example.test",
    });
    useRuntimeEnv(homeDir);
    const loaded = await loadNamsConfig(projectDir);
    useRuntimeEnv(path.join(homeDir, "empty"));
    const missing = await loadNamsConfig(projectDir);
    const invalid = {
      ok: false,
      reason: "invalid-json",
      errorSource: "global:~/.nams/config.json",
      sources: {
        apiKey: "missing",
        baseUrl: "default",
      },
    } as const;

    assert.deepEqual(configDiagnosticPayload(loaded), {
      message: "NAMS config loaded",
      configSources: {
        apiKey: "global:~/.nams/config.json",
        baseUrl: "global:~/.nams/config.json",
      },
    });
    assert.deepEqual(configDiagnosticPayload(missing), {
      message: "NAMS apiKey missing",
      configSources: {
        apiKey: "missing",
        baseUrl: "default",
      },
    });
    assert.deepEqual(configDiagnosticPayload(invalid), {
      message: "NAMS config invalid",
      configSources: {
        apiKey: "missing",
        baseUrl: "default",
      },
      errorSource: "global:~/.nams/config.json",
    });
    assert.doesNotMatch(JSON.stringify(configDiagnosticPayload(loaded)), /secret-global-key/);
  });
});
