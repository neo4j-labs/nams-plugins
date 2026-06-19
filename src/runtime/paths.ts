import path from "node:path";
import type { Platform } from "../interfaces.js";
import { sha256 } from "./hashing.js";
import { firstString } from "./util.js";

export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return firstString(env[name]);
}

export function homeDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue(env, "HOME") ?? envValue(env, "USERPROFILE");
}

export function namsHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = homeDirectory(env);
  return home === undefined ? undefined : path.join(home, ".nams");
}

export function requireNamsHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = namsHome(env);
  if (home === undefined) {
    throw new Error("Unable to resolve NAMS home directory from HOME or USERPROFILE");
  }
  return home;
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = namsHome(env);
  return home === undefined ? undefined : path.join(home, "config.json");
}

export function projectConfigPath(projectDirectory: string): string {
  return path.join(projectDirectory, ".nams", "config.json");
}

export function sessionStateDirectory(platform: Platform, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(requireNamsHome(env), "state", platform);
}

export function sessionStatePath(
  platform: Platform,
  sessionKey: string,
  createdAt: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    sessionStateDirectory(platform, env),
    `session-${formatStateTimestamp(createdAt)}--${sha256(sessionKey)}.json`,
  );
}

export function platformLogDirectory(platform: Platform, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(requireNamsHome(env), "logs", platform);
}

function formatStateTimestamp(value: string): string {
  const parsed = new Date(value);
  const timestamp = Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  return timestamp.replaceAll(":", "").replace(/[^a-zA-Z0-9._-]/g, "-");
}
