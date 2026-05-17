import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pathsUrl = pathToFileURL(path.join(repoRoot, ".build", "tsc", "runtime", "paths.js")).href;

test("resolves NAMS home from HOME", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  try {
    const { RuntimeEnvironment, resolveNamsHome } = await import(pathsUrl);

    assert.equal(resolveNamsHome({ HOME: homeDir }), path.join(homeDir, ".nams"));
    assert.equal(RuntimeEnvironment.from({ HOME: homeDir }).namsHome(), path.join(homeDir, ".nams"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("resolves NAMS home from USERPROFILE when HOME is absent", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  try {
    const { resolveNamsHome } = await import(pathsUrl);

    assert.equal(resolveNamsHome({ USERPROFILE: homeDir }), path.join(homeDir, ".nams"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("builds config, state, and log paths under NAMS home", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  try {
    const { RuntimeEnvironment, globalConfigPath, platformLogDirectory, projectConfigPath, sessionStatePath } =
      await import(pathsUrl);
    const runtimeEnvironment = RuntimeEnvironment.from({ HOME: homeDir });

    assert.equal(runtimeEnvironment.homeDirectory(), homeDir);
    assert.equal(runtimeEnvironment.value("HOME"), homeDir);
    assert.equal(runtimeEnvironment.globalConfigPath(), path.join(homeDir, ".nams", "config.json"));
    assert.equal(globalConfigPath(runtimeEnvironment), path.join(homeDir, ".nams", "config.json"));
    assert.equal(projectConfigPath("/tmp/project"), path.join("/tmp/project", ".nams", "config.json"));
    assert.equal(runtimeEnvironment.projectConfigPath("/tmp/project"), path.join("/tmp/project", ".nams", "config.json"));
    assert.equal(runtimeEnvironment.platformLogDirectory("gemini"), path.join(homeDir, ".nams", "logs", "gemini"));
    assert.equal(platformLogDirectory("gemini", runtimeEnvironment), path.join(homeDir, ".nams", "logs", "gemini"));
    assert.equal(
      runtimeEnvironment.sessionStatePath("gemini", "session/1"),
      path.join(homeDir, ".nams", "state", "gemini", `${sha256("session/1")}.json`),
    );
    assert.equal(
      sessionStatePath("gemini", "session/1", runtimeEnvironment),
      path.join(homeDir, ".nams", "state", "gemini", `${sha256("session/1")}.json`),
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("throws a stable error when no home directory is available", async () => {
  const { resolveNamsHome } = await import(pathsUrl);

  assert.throws(() => resolveNamsHome({}), /Unable to resolve NAMS home directory/);
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
