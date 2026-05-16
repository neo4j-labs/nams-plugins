import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export function runtimeEnv(homeDir, extra = {}) {
  return {
    ...extra,
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
}

export function namsHome(homeDir) {
  return path.join(homeDir, ".nams");
}

export async function singleSessionLogPath(homeDir, platform) {
  const logDir = path.join(namsHome(homeDir), "logs", platform);
  const logFiles = (await readdir(logDir)).filter((fileName) => /^session-.*\.jsonl$/.test(fileName));
  assert.equal(logFiles.length, 1, `expected one ${platform} session log file, got ${logFiles.join(", ")}`);
  return path.join(logDir, logFiles[0]);
}

export async function readSingleSessionLog(homeDir, platform) {
  const logPath = await singleSessionLogPath(homeDir, platform);
  const text = await readFile(logPath, "utf8");
  return {
    logPath,
    lines: text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

export async function sessionStateFiles(homeDir, platform) {
  try {
    return await readdir(path.join(namsHome(homeDir), "state", platform));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
