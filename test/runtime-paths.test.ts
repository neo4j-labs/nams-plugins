import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  RuntimeEnvironment,
  globalConfigPath,
  platformLogDirectory,
  projectConfigPath,
  resolveNamsHome,
  sessionStatePath,
} from "../src/runtime/paths.js";

test("resolves NAMS home from HOME", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  try {
    assert.equal(resolveNamsHome({ HOME: homeDir }), path.join(homeDir, ".nams"));
    assert.equal(RuntimeEnvironment.from({ HOME: homeDir }).namsHome(), path.join(homeDir, ".nams"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("resolves NAMS home from USERPROFILE when HOME is absent", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  try {
    assert.equal(resolveNamsHome({ USERPROFILE: homeDir }), path.join(homeDir, ".nams"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("builds config, state, and log paths under NAMS home", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  try {
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
      runtimeEnvironment.sessionStateDirectory("gemini"),
      path.join(homeDir, ".nams", "state", "gemini"),
    );
    assert.equal(
      runtimeEnvironment.sessionStatePath("gemini", "session/1", "2026-05-11T12:00:01.234Z"),
      path.join(
        homeDir,
        ".nams",
        "state",
        "gemini",
        `session-2026-05-11T120001.234Z--${sha256("session/1")}.json`,
      ),
    );
    assert.equal(
      sessionStatePath("gemini", "session/1", "2026-05-11T12:00:01.234Z", runtimeEnvironment),
      path.join(
        homeDir,
        ".nams",
        "state",
        "gemini",
        `session-2026-05-11T120001.234Z--${sha256("session/1")}.json`,
      ),
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("throws a stable error when no home directory is available", async () => {
  assert.throws(() => resolveNamsHome({}), /Unable to resolve NAMS home directory/);
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
