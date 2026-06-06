import { readFile } from "node:fs/promises";
import { writePrivateFile } from "./permissions.js";
import { RuntimeEnvironment } from "./paths.js";

export type NamsConfigWriteScope = "project" | "user";

export interface WriteNamsJsonConfigInput {
  scope: NamsConfigWriteScope;
  projectDirectory: string;
  workspaceId: string;
}

export interface WriteNamsJsonConfigResult {
  path: string;
}

export async function writeNamsJsonConfig(input: WriteNamsJsonConfigInput): Promise<WriteNamsJsonConfigResult> {
  const configPath = configPathForScope(input.scope, input.projectDirectory);
  const existing = await readExistingConfig(configPath);
  await writePrivateFile(
    configPath,
    `${JSON.stringify(
      {
        ...existing,
        workspaceId: input.workspaceId,
      },
      null,
      2,
    )}\n`,
  );
  return { path: configPath };
}

function configPathForScope(scope: NamsConfigWriteScope, projectDirectory: string): string {
  const runtimeEnvironment = RuntimeEnvironment.fromProcess();
  if (scope === "project") {
    return runtimeEnvironment.projectConfigPath(projectDirectory);
  }

  const globalPath = runtimeEnvironment.globalConfigPath();
  if (globalPath === undefined) {
    throw new Error("Unable to resolve NAMS home directory from HOME or USERPROFILE");
  }
  return globalPath;
}

async function readExistingConfig(configPath: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }

  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
