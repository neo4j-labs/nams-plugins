import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "config.js")).href;

test(".nams/.env values take priority over process environment", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-config-"));
  try {
    await mkdir(path.join(projectDir, ".nams"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".nams", ".env"),
      "NAMS_API_KEY=file-key\nNAMS_BASE_URL=https://file.example.test\n",
      "utf8",
    );

    const { loadNamsConfig } = await import(configUrl);
    const config = await loadNamsConfig(projectDir, {
      NAMS_API_KEY: "env-key",
      NAMS_BASE_URL: "https://env.example.test",
    });

    assert.deepEqual(config, {
      apiKey: "file-key",
      baseUrl: "https://file.example.test",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("process environment fills missing config values", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-config-"));
  try {
    const { loadNamsConfig } = await import(configUrl);
    const config = await loadNamsConfig(projectDir, {
      NAMS_API_KEY: "env-key",
      NAMS_BASE_URL: "https://env.example.test",
    });

    assert.deepEqual(config, {
      apiKey: "env-key",
      baseUrl: "https://env.example.test",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("missing NAMS_API_KEY returns null config", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-config-"));
  try {
    const { loadNamsConfig } = await import(configUrl);
    const config = await loadNamsConfig(projectDir, {});

    assert.equal(config, null);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
