import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { writePrivateFile } from "./permissions.js";
import { globalConfigPath, projectConfigPath } from "./paths.js";

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
  const { path: configPath } = await assertNamsJsonConfigPathSafe(input);
  const existing = await readExistingConfig(configPath);
  await assertNamsJsonConfigPathSafe(input);
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

export async function assertNamsJsonConfigPathSafe(
  input: Pick<WriteNamsJsonConfigInput, "scope" | "projectDirectory">,
): Promise<WriteNamsJsonConfigResult> {
  const configPath = configPathForScope(input.scope, input.projectDirectory);
  await rejectSymlink(path.dirname(configPath));
  await rejectUnsafeConfigFile(configPath);
  return { path: configPath };
}

export async function assertNamsJsonConfigInputsSafe(
  projectDirectory: string,
  destinationScope: NamsConfigWriteScope,
): Promise<void> {
  await assertNamsJsonConfigPathSafe({ projectDirectory, scope: "project" });
  if (destinationScope === "user" || globalConfigPath() !== undefined) {
    await assertNamsJsonConfigPathSafe({ projectDirectory, scope: "user" });
  }
}

async function rejectSymlink(configPath: string): Promise<void> {
  try {
    const file = await lstat(configPath);
    if (file.isSymbolicLink()) {
      throw new Error("NAMS config path must not be a symbolic link");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function rejectUnsafeConfigFile(configPath: string): Promise<void> {
  try {
    const file = await lstat(configPath);
    if (file.isSymbolicLink()) {
      throw new Error("NAMS config path must not be a symbolic link");
    }
    if (!file.isFile() || file.nlink > 1) {
      throw new Error("NAMS config path is unsafe; existing config must be a regular file without hard links");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function configPathForScope(scope: NamsConfigWriteScope, projectDirectory: string): string {
  if (scope === "project") {
    return projectConfigPath(projectDirectory);
  }

  const globalPath = globalConfigPath();
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
