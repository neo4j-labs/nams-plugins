import path from "node:path";
import type { Platform } from "../interfaces.js";
import { sha256 } from "./hashing.js";

export type RuntimeEnvironmentValues = Record<string, string | undefined>;
export type RuntimeEnvironmentInput = RuntimeEnvironment | RuntimeEnvironmentValues | undefined;

export class RuntimeEnvironment {
  static from(input: RuntimeEnvironmentInput = process.env): RuntimeEnvironment {
    if (input instanceof RuntimeEnvironment) {
      return input;
    }
    return new RuntimeEnvironment(input ?? process.env);
  }

  static fromProcess(): RuntimeEnvironment {
    return new RuntimeEnvironment(process.env);
  }

  private constructor(private readonly values: RuntimeEnvironmentValues) {}

  value(name: string): string | undefined {
    return firstNonBlank(this.values[name]);
  }

  homeDirectory(): string | undefined {
    return this.value("HOME") ?? this.value("USERPROFILE");
  }

  namsHome(): string | undefined {
    const home = this.homeDirectory();
    return home === undefined ? undefined : path.join(home, ".nams");
  }

  requireNamsHome(): string {
    const namsHome = this.namsHome();
    if (namsHome === undefined) {
      throw new Error("Unable to resolve NAMS home directory from HOME or USERPROFILE");
    }
    return namsHome;
  }

  globalConfigPath(): string | undefined {
    const namsHome = this.namsHome();
    return namsHome === undefined ? undefined : path.join(namsHome, "config.json");
  }

  projectConfigPath(projectDirectory: string): string {
    return path.join(projectDirectory, ".nams", "config.json");
  }

  sessionStatePath(platform: Platform, sessionKey: string): string {
    return path.join(this.requireNamsHome(), "state", platform, `${sha256(sessionKey)}.json`);
  }

  platformLogDirectory(platform: Platform): string {
    return path.join(this.requireNamsHome(), "logs", platform);
  }
}

export function resolveNamsHome(environment: RuntimeEnvironmentInput = process.env): string {
  return RuntimeEnvironment.from(environment).requireNamsHome();
}

export function globalConfigPath(environment: RuntimeEnvironmentInput = process.env): string {
  return path.join(resolveNamsHome(environment), "config.json");
}

export function projectConfigPath(projectDirectory: string): string {
  return path.join(projectDirectory, ".nams", "config.json");
}

export function sessionStatePath(
  platform: Platform,
  sessionKey: string,
  environment: RuntimeEnvironmentInput = process.env,
): string {
  return RuntimeEnvironment.from(environment).sessionStatePath(platform, sessionKey);
}

export function platformLogDirectory(
  platform: Platform,
  environment: RuntimeEnvironmentInput = process.env,
): string {
  return RuntimeEnvironment.from(environment).platformLogDirectory(platform);
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "");
}
