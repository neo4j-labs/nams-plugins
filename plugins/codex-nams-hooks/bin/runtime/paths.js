import path from "node:path";
import { sha256 } from "./hashing.js";
import { firstString } from "./util.js";
export function envValue(env, name) {
    return firstString(env[name]);
}
export function homeDirectory(env = process.env) {
    return envValue(env, "HOME") ?? envValue(env, "USERPROFILE");
}
export function namsHome(env = process.env) {
    const home = homeDirectory(env);
    return home === undefined ? undefined : path.join(home, ".nams");
}
export function requireNamsHome(env = process.env) {
    const home = namsHome(env);
    if (home === undefined) {
        throw new Error("Unable to resolve NAMS home directory from HOME or USERPROFILE");
    }
    return home;
}
export function globalConfigPath(env = process.env) {
    const home = namsHome(env);
    return home === undefined ? undefined : path.join(home, "config.json");
}
export function projectConfigPath(projectDirectory) {
    return path.join(projectDirectory, ".nams", "config.json");
}
export function sessionStateDirectory(platform, env = process.env) {
    return path.join(requireNamsHome(env), "state", platform);
}
export function sessionStatePath(platform, sessionKey, createdAt, env = process.env) {
    return path.join(sessionStateDirectory(platform, env), `session-${formatStateTimestamp(createdAt)}--${sha256(sessionKey)}.json`);
}
export function platformLogDirectory(platform, env = process.env) {
    return path.join(requireNamsHome(env), "logs", platform);
}
function formatStateTimestamp(value) {
    const parsed = new Date(value);
    const timestamp = Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    return timestamp.replaceAll(":", "").replace(/[^a-zA-Z0-9._-]/g, "-");
}
