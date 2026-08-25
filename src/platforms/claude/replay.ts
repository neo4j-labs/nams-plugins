import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ReplayPlatformAdapter,
  ReplayRecord,
  ReplayToolRecord,
  ReplayTranscript,
} from "../../interfaces.js";
import { discoverRegularJsonlFiles, normalizeAbsolutePath } from "../../runtime/replay-files.js";
import { homeDirectory } from "../../runtime/paths.js";
import { firstString, isPlainObject } from "../../runtime/util.js";
import { discoverClaudeNamsConfig } from "./config.js";

export const claudeReplayAdapter: ReplayPlatformAdapter = {
  platform: "claude",
  discoverConfig: discoverClaudeNamsConfig,
  discoverTranscripts: () => discoverClaudeReplayTranscripts(),
  readTranscript: readClaudeReplayTranscript,
};

export async function readClaudeReplayTranscript(transcriptPath: string): Promise<ReplayTranscript> {
  const lines = (await readFile(transcriptPath, "utf8")).split(/\r?\n/);
  const records: ReplayRecord[] = [];
  const calls = new Map<string, ReplayToolRecord>();
  let sourceSessionId: string | undefined;
  let sourceStartedAt: string | undefined;
  let projectDirectory: string | undefined;
  let sawCwd = false;
  let malformedLineCount = 0;
  let unsupportedRecordCount = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      malformedLineCount += 1;
      continue;
    }
    if (!isPlainObject(raw)) {
      unsupportedRecordCount += 1;
      continue;
    }

    if (!sawCwd && Object.hasOwn(raw, "cwd")) {
      sawCwd = true;
      projectDirectory = normalizeAbsolutePath(raw.cwd);
      sourceStartedAt = firstString(raw.timestamp, raw.createdAt);
    }
    sourceSessionId ??= firstString(raw.sessionId, raw.session_id);

    const message = isPlainObject(raw.message) ? raw.message : undefined;
    const blocks = contentBlocks(message?.content);
    let handled = false;
    if ((raw.type === "user" || raw.type === "assistant") && message?.role === raw.type) {
      let pendingText: string[] = [];
      const flushText = (): void => {
        const content = pendingText.join("\n").trim();
        pendingText = [];
        if (content === "") return;
        records.push({ kind: "message", role: raw.type as "user" | "assistant", content });
        handled = true;
      };

      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          pendingText.push(block.text);
          continue;
        }
        flushText();

        if (raw.type === "assistant" && block.type === "tool_use") {
          const toolName = firstString(block.name);
          if (toolName === undefined) continue;
          const sourceCallId = firstString(block.id);
          const tool: ReplayToolRecord = {
            kind: "tool",
            toolName,
            input: block.input ?? {},
            reasoningStep: {
              reasoning: `Claude Code ran ${toolName} with the provided tool input.`,
              actionTaken: `Ran ${toolName}`,
            },
          };
          records.push(tool);
          if (sourceCallId !== undefined) calls.set(sourceCallId, tool);
          handled = true;
          continue;
        }

        if (raw.type === "user" && block.type === "tool_result") {
          const call = calls.get(firstString(block.tool_use_id) ?? "");
          if (call === undefined) {
            unsupportedRecordCount += 1;
            handled = true;
            continue;
          }
          if (Object.hasOwn(block, "content")) call.output = block.content;
          if (typeof block.is_error === "boolean") call.status = block.is_error ? "error" : "success";
          const durationMs = finiteNumber(block.duration_ms, block.durationMs);
          if (durationMs !== undefined) call.durationMs = durationMs;
          handled = true;
        }
      }
      flushText();
    }
    if (!handled) unsupportedRecordCount += 1;
  }

  return {
    sourceSessionId: sourceSessionId ?? path.basename(transcriptPath, ".jsonl"),
    ...(projectDirectory !== undefined ? { projectDirectory } : {}),
    ...(sourceStartedAt !== undefined ? { sourceStartedAt } : {}),
    records,
    malformedLineCount,
    unsupportedRecordCount,
  };
}

export async function discoverClaudeReplayTranscripts(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const configured = firstString(env.CLAUDE_CONFIG_DIR);
  const home = homeDirectory(env);
  if (configured === undefined && home === undefined) return [];
  const claudeRoot = path.resolve(configured ?? path.join(home as string, ".claude"));
  return discoverRegularJsonlFiles([path.join(claudeRoot, "projects")]);
}

function contentBlocks(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function finiteNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}
