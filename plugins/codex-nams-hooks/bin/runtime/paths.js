import path from "node:path";
import { sha256 } from "./hashing.js";
export class RuntimeEnvironment {
    values;
    static from(input = process.env) {
        if (input instanceof RuntimeEnvironment) {
            return input;
        }
        return new RuntimeEnvironment(input ?? process.env);
    }
    static fromProcess() {
        return new RuntimeEnvironment(process.env);
    }
    constructor(values) {
        this.values = values;
    }
    value(name) {
        return firstNonBlank(this.values[name]);
    }
    homeDirectory() {
        return this.value("HOME") ?? this.value("USERPROFILE");
    }
    namsHome() {
        const home = this.homeDirectory();
        return home === undefined ? undefined : path.join(home, ".nams");
    }
    requireNamsHome() {
        const namsHome = this.namsHome();
        if (namsHome === undefined) {
            throw new Error("Unable to resolve NAMS home directory from HOME or USERPROFILE");
        }
        return namsHome;
    }
    globalConfigPath() {
        const namsHome = this.namsHome();
        return namsHome === undefined ? undefined : path.join(namsHome, "config.json");
    }
    projectConfigPath(projectDirectory) {
        return path.join(projectDirectory, ".nams", "config.json");
    }
    sessionStateDirectory(platform) {
        return path.join(this.requireNamsHome(), "state", platform);
    }
    sessionStatePath(platform, sessionKey, createdAt) {
        return path.join(this.sessionStateDirectory(platform), `session-${formatStateTimestamp(createdAt)}--${sha256(sessionKey)}.json`);
    }
    platformLogDirectory(platform) {
        return path.join(this.requireNamsHome(), "logs", platform);
    }
}
export function sessionStatePath(platform, sessionKey, createdAt, environment = process.env) {
    return RuntimeEnvironment.from(environment).sessionStatePath(platform, sessionKey, createdAt);
}
export function sessionStateDirectory(platform, environment = process.env) {
    return RuntimeEnvironment.from(environment).sessionStateDirectory(platform);
}
function firstNonBlank(...values) {
    return values.find((value) => typeof value === "string" && value.trim() !== "");
}
function formatStateTimestamp(value) {
    const parsed = new Date(value);
    const timestamp = Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    return timestamp.replaceAll(":", "").replace(/[^a-zA-Z0-9._-]/g, "-");
}
