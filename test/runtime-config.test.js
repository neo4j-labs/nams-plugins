import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "config.js")).href;

async function withFixture(fn) {
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

async function writeGlobalConfig(homeDir, config) {
  await mkdir(path.join(homeDir, ".nams"), { recursive: true });
  await writeFile(path.join(homeDir, ".nams", "config.json"), JSON.stringify(config), "utf8");
}

async function writeProjectConfig(projectDir, config) {
  await mkdir(path.join(projectDir, ".nams"), { recursive: true });
  await writeFile(path.join(projectDir, ".nams", "config.json"), JSON.stringify(config), "utf8");
}

test("loads global JSON config by default", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await writeGlobalConfig(homeDir, {
      apiKey: "global-key",
      baseUrl: "https://global.example.test",
    });

    const { loadNamsConfig } = await import(configUrl);
    const result = await loadNamsConfig(projectDir, { HOME: homeDir });

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

    const { loadNamsConfig } = await import(configUrl);
    const result = await loadNamsConfig(projectDir, { HOME: homeDir });

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

    const { loadNamsConfig } = await import(configUrl);
    const result = await loadNamsConfig(projectDir, {
      HOME: homeDir,
      NAMS_API_KEY: "env-key",
      NAMS_BASE_URL: "https://env.example.test",
    });

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

test("does not read project .nams/.env", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".nams", ".env"),
      "NAMS_API_KEY=file-key\nNAMS_BASE_URL=https://file.example.test\n",
      "utf8",
    );

    const { loadNamsConfig } = await import(configUrl);
    const result = await loadNamsConfig(projectDir, { HOME: homeDir });

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
    const { loadNamsConfig } = await import(configUrl);
    const result = await loadNamsConfig(projectDir, { HOME: homeDir });

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

    const { loadNamsConfig } = await import(configUrl);
    const result = await loadNamsConfig(projectDir, { HOME: homeDir });

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

test("configDiagnosticPayload includes sources but not secret values", async () => {
  await withFixture(async ({ homeDir, projectDir }) => {
    await writeGlobalConfig(homeDir, {
      apiKey: "secret-global-key",
      baseUrl: "https://global.example.test",
    });

    const { configDiagnosticPayload, loadNamsConfig } = await import(configUrl);
    const loaded = await loadNamsConfig(projectDir, { HOME: homeDir });
    const missing = await loadNamsConfig(projectDir, { HOME: path.join(homeDir, "empty") });
    const invalid = {
      ok: false,
      reason: "invalid-json",
      errorSource: "global:~/.nams/config.json",
      sources: {
        apiKey: "missing",
        baseUrl: "default",
      },
    };

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
