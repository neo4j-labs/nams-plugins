import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../../src/interfaces.js";

export type TestEnvironment = Record<string, string | undefined>;

export interface RuntimeLogReadResult {
  logPath: string;
  lines: Array<Record<string, any>>;
}

export function runtimeEnv(homeDir: string, extra: TestEnvironment = {}): TestEnvironment {
  return {
    ...childProcessEnv(extra),
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
}

function childProcessEnv(extra: TestEnvironment): TestEnvironment {
  const env = { ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key.startsWith("NODE_TEST")) {
      delete env[key];
    }
  }
  return env;
}

export function namsHome(homeDir: string): string {
  return path.join(homeDir, ".nams");
}

export async function singleSessionLogPath(homeDir: string, platform: Platform): Promise<string> {
  const logDir = path.join(namsHome(homeDir), "logs", platform);
  const logFiles = (await readdir(logDir)).filter((fileName) => /^session-.*\.jsonl$/.test(fileName));
  assert.equal(logFiles.length, 1, `expected one ${platform} session log file, got ${logFiles.join(", ")}`);
  return path.join(logDir, logFiles[0]);
}

export async function readSingleSessionLog(homeDir: string, platform: Platform): Promise<RuntimeLogReadResult> {
  const logPath = await singleSessionLogPath(homeDir, platform);
  const text = await readFile(logPath, "utf8");
  return {
    logPath,
    lines: text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>),
  };
}

export async function sessionStateFiles(homeDir: string, platform: Platform): Promise<string[]> {
  try {
    return await readdir(path.join(namsHome(homeDir), "state", platform));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
