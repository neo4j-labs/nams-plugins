import path from "node:path";
import type { Platform } from "../interfaces.js";
import { sha256 } from "./hashing.js";

type RuntimeEnv = Record<string, string | undefined>;

export function resolveNamsHome(env: RuntimeEnv = process.env): string {
  const home = firstNonBlank(env.HOME, env.USERPROFILE);
  if (home === undefined) {
    throw new Error("Unable to resolve NAMS home directory from HOME or USERPROFILE");
  }
  return path.join(home, ".nams");
}

export function globalConfigPath(env: RuntimeEnv = process.env): string {
  return path.join(resolveNamsHome(env), "config.json");
}

export function projectConfigPath(projectDirectory: string): string {
  return path.join(projectDirectory, ".nams", "config.json");
}

export function sessionStatePath(platform: Platform, sessionKey: string, env: RuntimeEnv = process.env): string {
  return path.join(resolveNamsHome(env), "state", platform, `${sha256(sessionKey)}.json`);
}

export function platformLogDirectory(platform: Platform, env: RuntimeEnv = process.env): string {
  return path.join(resolveNamsHome(env), "logs", platform);
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "");
}
