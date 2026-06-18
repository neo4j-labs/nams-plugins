import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  envValue,
  globalConfigPath,
  homeDirectory,
  namsHome,
  platformLogDirectory,
  projectConfigPath,
  requireNamsHome,
  sessionStateDirectory,
  sessionStatePath,
} from "../src/runtime/paths.js";

test("resolves NAMS home from HOME", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  try {
    assert.equal(namsHome({ HOME: homeDir }), path.join(homeDir, ".nams"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("resolves NAMS home from USERPROFILE when HOME is absent", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  try {
    assert.equal(namsHome({ USERPROFILE: homeDir }), path.join(homeDir, ".nams"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("builds config, state, and log paths under NAMS home", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "nams-home-"));
  try {
    const env = { HOME: homeDir };

    assert.equal(homeDirectory(env), homeDir);
    assert.equal(envValue(env, "HOME"), homeDir);
    assert.equal(globalConfigPath(env), path.join(homeDir, ".nams", "config.json"));
    assert.equal(projectConfigPath("/tmp/project"), path.join("/tmp/project", ".nams", "config.json"));
    assert.equal(platformLogDirectory("gemini", env), path.join(homeDir, ".nams", "logs", "gemini"));
    assert.equal(
      sessionStateDirectory("gemini", env),
      path.join(homeDir, ".nams", "state", "gemini"),
    );
    assert.equal(
      sessionStatePath("gemini", "session/1", "2026-05-11T12:00:01.234Z", env),
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
  assert.throws(() => requireNamsHome({}), /Unable to resolve NAMS home directory/);
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
