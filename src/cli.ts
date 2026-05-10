#!/usr/bin/env node

import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type Harness = "gemini" | "claude" | "codex";

const harnesses = new Set<Harness>(["gemini", "claude", "codex"]);

async function main(argv: string[]): Promise<number> {
  const [command, harnessArg] = argv;
  if (command !== "run" || !isHarness(harnessArg)) {
    process.stderr.write("Usage: nams-hooks run <gemini|claude|codex>\n");
    return 1;
  }

  const payload = await readJsonPayload();
  await logSessionStart(harnessArg, payload);
  process.stdout.write(`${JSON.stringify({ continue: true, suppressOutput: true })}\n`);
  return 0;
}

function isHarness(value: string | undefined): value is Harness {
  return value !== undefined && harnesses.has(value as Harness);
}

async function readJsonPayload(): Promise<Record<string, unknown>> {
  const input = await readStdin();
  if (input.trim() === "") {
    return {};
  }

  const parsed: unknown = JSON.parse(input);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  throw new Error("hook payload must be a JSON object");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function logSessionStart(harness: Harness, payload: Record<string, unknown>): Promise<void> {
  const event = getEventName(payload);
  const cwd = getProjectDirectory(payload);
  const logDir = path.join(cwd, ".nams", "logs");
  const logPath = path.join(logDir, `${harness}-${toKebabCase(event)}.jsonl`);
  const entry = {
    timestamp: new Date().toISOString(),
    harness,
    event,
    payload,
  };

  await mkdir(logDir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function getEventName(payload: Record<string, unknown>): string {
  const value = payload.hook_event_name ?? payload.hookEventName ?? payload.event;
  return typeof value === "string" && value.trim() !== "" ? value : "SessionStart";
}

function getProjectDirectory(payload: Record<string, unknown>): string {
  return typeof payload.cwd === "string" && payload.cwd.trim() !== "" ? payload.cwd : process.cwd();
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
