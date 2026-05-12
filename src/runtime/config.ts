import { readFile } from "node:fs/promises";
import path from "node:path";

export interface NamsRuntimeConfig {
  apiKey: string;
  baseUrl?: string;
}

export async function loadNamsConfig(
  projectDirectory: string,
  env: Record<string, string | undefined> = process.env,
): Promise<NamsRuntimeConfig | null> {
  const fileEnv = await readLocalEnv(projectDirectory);
  const apiKey = fileEnv.NAMS_API_KEY ?? env.NAMS_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    return null;
  }

  const baseUrl = fileEnv.NAMS_BASE_URL ?? env.NAMS_BASE_URL;
  return {
    apiKey,
    ...(baseUrl !== undefined && baseUrl.trim() !== "" ? { baseUrl } : {}),
  };
}

async function readLocalEnv(projectDirectory: string): Promise<Record<string, string>> {
  const envPath = path.join(projectDirectory, ".nams", ".env");
  let content: string;
  try {
    content = await readFile(envPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  return parseEnv(content);
}

function parseEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    values[key] = stripQuotes(value);
  }
  return values;
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
