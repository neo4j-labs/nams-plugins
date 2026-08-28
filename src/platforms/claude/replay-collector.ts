import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  discoverRegularJsonlFiles,
  isDirectoryWithinImportRoot,
  normalizeAbsolutePath,
} from "../../runtime/replay-files.js";
import { homeDirectory } from "../../runtime/paths.js";
import { firstString, isPlainObject } from "../../runtime/util.js";
import type {
  ClaudeReplayCollection,
  ClaudeReplayMessage,
  ClaudeReplaySession,
  ClaudeReplayStatus,
  ClaudeReplayStep,
  ClaudeReplayToolCall,
  CollectClaudeReplayInput,
} from "./replay-model.js";

interface SourceRecord {
  value: Record<string, unknown>;
  ordinal: number;
}

interface ParsedTranscript {
  path: string;
  records: SourceRecord[];
  malformedLines: number;
  unsupportedRecords: number;
  sessionId?: string;
  streamId?: string;
  isRoot: boolean;
  projectDirectory?: string;
  sourceStartedAt?: string;
  parentCallId?: string;
}

interface AssistantGroup {
  sourceAssistantMessageId: string;
  streamId: string;
  transcriptPath: string;
  records: SourceRecord[];
  text: string[];
  tools: Array<{ block: Record<string, unknown>; record: SourceRecord; blockIndex: number }>;
}

interface OutputPart {
  value: string;
  timestamp: string;
  ordinal: number;
  transcriptPath: string;
}

interface CallBuilder extends ClaudeReplayToolCall {
  streamId: string;
  sourceAssistantUuid?: string;
  outputParts: OutputPart[];
  callTimestampMs?: number;
  lastOutputTimestampMs?: number;
  finalStatus?: ClaudeReplayStatus;
}

interface StepBuilder extends Omit<ClaudeReplayStep, "toolCalls"> {
  transcriptPath: string;
  toolCalls: CallBuilder[];
}

interface NormalizedSession {
  session?: ClaudeReplaySession;
  importedPaths: Set<string>;
  unsupportedRecords: number;
}

export async function discoverClaudeTranscriptPaths(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const configured = firstString(env.CLAUDE_CONFIG_DIR);
  const home = homeDirectory(env);
  if (configured === undefined && home === undefined) return [];
  const claudeRoot = path.resolve(configured ?? path.join(home as string, ".claude"));
  const projectsDirectory = path.join(claudeRoot, "projects");
  const candidates = await discoverRegularJsonlFiles([projectsDirectory]);
  return candidates.filter((candidate) => !isClaudeMemoryTranscript(projectsDirectory, candidate));
}

export async function collectClaudeReplaySessions(
  input: CollectClaudeReplayInput,
): Promise<ClaudeReplayCollection> {
  const importRoot = path.resolve(input.importRoot);
  let transcriptPaths: string[];
  try {
    transcriptPaths = [...(
      input.transcriptPaths ?? await discoverClaudeTranscriptPaths(input.env)
    )].map((candidate) => path.resolve(candidate)).sort();
  } catch {
    throw new Error("Unable to discover Claude transcripts");
  }

  const parsed: ParsedTranscript[] = [];
  let malformedLines = 0;
  let unsupportedRecords = 0;
  for (const transcriptPath of transcriptPaths) {
    const transcript = await parseTranscript(transcriptPath);
    parsed.push(transcript);
    malformedLines += transcript.malformedLines;
    unsupportedRecords += transcript.unsupportedRecords;
  }

  const groups = new Map<string, ParsedTranscript[]>();
  for (const file of parsed) {
    if (file.sessionId === undefined) continue;
    const files = groups.get(file.sessionId) ?? [];
    files.push(file);
    groups.set(file.sessionId, files);
  }

  const sessions: ClaudeReplaySession[] = [];
  const importedPaths = new Set<string>();
  for (const [sessionId, files] of groups) {
    const normalized = await normalizeSession(sessionId, files, importRoot);
    unsupportedRecords += normalized.unsupportedRecords;
    if (normalized.session !== undefined) sessions.push(normalized.session);
    for (const importedPath of normalized.importedPaths) importedPaths.add(importedPath);
  }

  for (const transcriptPath of transcriptPaths) {
    const status = importedPaths.has(transcriptPath) ? "imported" : "skipped";
    input.onFileProcessed?.({ path: transcriptPath, status });
  }

  sessions.sort((left, right) =>
    (left.sourceStartedAt ?? "").localeCompare(right.sourceStartedAt ?? "")
    || left.sourceSessionId.localeCompare(right.sourceSessionId)
  );
  return {
    sessions,
    discoveredFiles: transcriptPaths.length,
    matchedFiles: importedPaths.size,
    skippedFiles: transcriptPaths.length - importedPaths.size,
    malformedLines,
    unsupportedRecords,
  };
}

async function parseTranscript(transcriptPath: string): Promise<ParsedTranscript> {
  let contents: string;
  try {
    contents = await readFile(transcriptPath, "utf8");
  } catch {
    throw new Error("Unable to read Claude transcript");
  }
  const records: SourceRecord[] = [];
  let malformedLines = 0;
  let unsupportedRecords = 0;
  for (const [ordinal, line] of contents.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isPlainObject(value)) records.push({ value, ordinal });
      else unsupportedRecords += 1;
    } catch {
      malformedLines += 1;
    }
  }

  const sessionId = records
    .map((record) => firstString(record.value.sessionId, record.value.session_id))
    .find((value) => value !== undefined);
  const sidechain = records
    .map((record) => typeof record.value.isSidechain === "boolean" ? record.value.isSidechain : undefined)
    .find((value) => value !== undefined);
  const agentId = records
    .map((record) => firstString(record.value.agentId))
    .find((value) => value !== undefined);
  const isRoot = sidechain !== true;
  const streamId = isRoot ? "root" : agentId === undefined ? undefined : `agent:${agentId}`;
  const projectDirectory = isRoot ? firstAbsoluteCwd(records) : undefined;
  const sourceStartedAt = records
    .map((record) => firstString(record.value.timestamp, record.value.createdAt))
    .find((value) => value !== undefined);
  const parentCallId = isRoot ? undefined : await readParentCallId(transcriptPath);
  if (!isRoot && streamId === undefined) unsupportedRecords += 1;

  return {
    path: transcriptPath,
    records,
    malformedLines,
    unsupportedRecords,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(streamId !== undefined ? { streamId } : {}),
    isRoot,
    ...(projectDirectory !== undefined ? { projectDirectory } : {}),
    ...(sourceStartedAt !== undefined ? { sourceStartedAt } : {}),
    ...(parentCallId !== undefined ? { parentCallId } : {}),
  };
}

async function readParentCallId(transcriptPath: string): Promise<string | undefined> {
  const metaPath = transcriptPath.replace(/\.jsonl$/, ".meta.json");
  try {
    const value: unknown = JSON.parse(await readFile(metaPath, "utf8"));
    return isPlainObject(value) ? firstString(value.toolUseId) : undefined;
  } catch {
    return undefined;
  }
}

function firstAbsoluteCwd(records: SourceRecord[]): string | undefined {
  for (const record of records) {
    const cwd = normalizeAbsolutePath(record.value.cwd);
    if (cwd !== undefined) return cwd;
  }
  return undefined;
}

async function normalizeSession(
  sessionId: string,
  files: ParsedTranscript[],
  importRoot: string,
): Promise<NormalizedSession> {
  const root = files.find((file) => file.isRoot && file.streamId === "root");
  if (
    root?.projectDirectory === undefined
    || !isDirectoryWithinImportRoot(importRoot, root.projectDirectory)
  ) {
    return { importedPaths: new Set(), unsupportedRecords: 0 };
  }

  const eligibleFiles = files.filter((file) => file.streamId !== undefined);
  const activeByPath = new Map(
    eligibleFiles.map((file) => [file.path, activeUuids(file.records)]),
  );
  const groups = assistantGroups(eligibleFiles, activeByPath);
  const steps: StepBuilder[] = [];
  const callsByScopedId = new Map<string, CallBuilder>();
  let unsupportedRecords = 0;

  for (const group of groups) {
    if (group.tools.length === 0) continue;
    const first = group.records[0];
    const timestamp = firstString(first.value.timestamp) ?? "";
    const step: StepBuilder = {
      localStepId: `${sessionId}:${group.streamId}:${group.sourceAssistantMessageId}`,
      sourceAssistantMessageId: group.sourceAssistantMessageId,
      streamId: group.streamId,
      transcriptPath: group.transcriptPath,
      timestamp,
      ordinal: first.ordinal * 1000,
      reasoning: group.text.join("\n").trim()
        || "Claude exposed a tool-use step in the persisted transcript.",
      actionTaken: "",
      toolCalls: [],
    };
    for (const tool of group.tools) {
      const sourceCallId = firstString(tool.block.id);
      const toolName = firstString(tool.block.name);
      if (sourceCallId === undefined || toolName === undefined) {
        unsupportedRecords += 1;
        continue;
      }
      const call: CallBuilder = {
        sourceCallId,
        toolName,
        input: tool.block.input ?? {},
        timestamp: firstString(tool.record.value.timestamp) ?? timestamp,
        ordinal: tool.record.ordinal * 1000 + tool.blockIndex,
        streamId: group.streamId,
        sourceAssistantUuid: firstString(tool.record.value.uuid),
        outputParts: [],
        callTimestampMs: timestampMs(firstString(tool.record.value.timestamp)),
      };
      step.toolCalls.push(call);
      const scoped = callKey(group.streamId, sourceCallId);
      if (callsByScopedId.has(scoped)) unsupportedRecords += 1;
      else callsByScopedId.set(scoped, call);
    }
    if (step.toolCalls.length > 0) steps.push(step);
  }

  for (const file of eligibleFiles) {
    for (const record of file.records) {
      const content = messageContent(record.value);
      if (Array.isArray(content)) {
        for (const block of content.filter(isPlainObject)) {
          if (block.type !== "tool_result") continue;
          const sourceCallId = firstString(block.tool_use_id);
          const call = sourceCallId === undefined || file.streamId === undefined
            ? undefined
            : callsByScopedId.get(callKey(file.streamId, sourceCallId));
          if (call === undefined) {
            unsupportedRecords += 1;
            continue;
          }
          const sourceAssistantUuid = firstString(
            record.value.sourceToolAssistantUUID,
            record.value.parentUuid,
          );
          if (
            sourceAssistantUuid !== undefined
            && call.sourceAssistantUuid !== undefined
            && sourceAssistantUuid !== call.sourceAssistantUuid
          ) {
            unsupportedRecords += 1;
            continue;
          }
          const normalized = await directResultParts(
            record,
            block,
            file,
            sessionId,
            path.dirname(root.path),
          );
          unsupportedRecords += normalized.unsupportedRecords;
          call.outputParts.push(...normalized.parts);
          call.lastOutputTimestampMs = timestampMs(firstString(record.value.timestamp))
            ?? call.lastOutputTimestampMs;
          if (block.is_error === true) call.status = "error";
          else if (isAsyncResult(record.value.toolUseResult)) call.status = "pending";
          else call.status = "success";
        }
      }

      const notification = taskNotificationResult(record.value);
      if (notification === undefined) continue;
      if (!file.isRoot || file.streamId !== "root") continue;
      const call = callsByScopedId.get(callKey("root", notification.sourceCallId));
      if (call === undefined) {
        unsupportedRecords += 1;
        continue;
      }
      if (notification.result !== "") {
        call.outputParts.push({
          value: notification.result,
          timestamp: firstString(record.value.timestamp) ?? "",
          ordinal: record.ordinal * 1000,
          transcriptPath: file.path,
        });
      }
      call.lastOutputTimestampMs = timestampMs(firstString(record.value.timestamp))
        ?? call.lastOutputTimestampMs;
      call.finalStatus = notification.status;
    }
  }

  const includedPaths = linkedTranscriptClosure(eligibleFiles, root.path, steps);
  const includedSteps = steps.filter((step) => includedPaths.has(step.transcriptPath));
  for (const step of includedSteps) {
    step.toolCalls.sort(compareTimeline);
    for (const call of step.toolCalls) {
      const values = call.outputParts.map((part) => part.value).filter((value) => value !== "");
      if (values.length > 0) call.output = values.join("\n\n");
      call.status = call.finalStatus ?? call.status;
      call.durationMs = elapsedMs(call.callTimestampMs, call.lastOutputTimestampMs);
    }
    step.actionTaken = `Ran ${step.toolCalls.length} tool ${step.toolCalls.length === 1 ? "call" : "calls"}: ${
      step.toolCalls.map((call) => call.toolName).join(", ")
    }`;
    if (step.toolCalls.some((call) => call.status !== undefined)) {
      step.result = `Tool statuses: ${step.toolCalls.map((call) => call.status ?? "unknown").join(", ")}`;
    }
  }

  const messages = rootMessages(root, activeByPath.get(root.path) ?? new Set());
  if (messages.length === 0 && includedSteps.length === 0) {
    return { importedPaths: new Set(), unsupportedRecords };
  }
  messages.sort(compareTimeline);
  includedSteps.sort(compareTimeline);
  const session: ClaudeReplaySession = {
    sourceSessionId: sessionId,
    projectDirectory: root.projectDirectory,
    ...(root.sourceStartedAt !== undefined ? { sourceStartedAt: root.sourceStartedAt } : {}),
    messages,
    steps: includedSteps.map((step) => ({
      localStepId: step.localStepId,
      sourceAssistantMessageId: step.sourceAssistantMessageId,
      streamId: step.streamId,
      timestamp: step.timestamp,
      ordinal: step.ordinal,
      reasoning: step.reasoning,
      actionTaken: step.actionTaken,
      ...(step.result !== undefined ? { result: step.result } : {}),
      toolCalls: step.toolCalls.map((call) => ({
        sourceCallId: call.sourceCallId,
        toolName: call.toolName,
        input: call.input,
        ...(call.output !== undefined ? { output: call.output } : {}),
        ...(call.status !== undefined ? { status: call.status } : {}),
        ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
        timestamp: call.timestamp,
        ordinal: call.ordinal,
      })),
    })),
  };
  return { session, importedPaths: includedPaths, unsupportedRecords };
}

function activeUuids(records: SourceRecord[]): Set<string> {
  const byUuid = new Map<string, SourceRecord>();
  for (const record of records) {
    const uuid = firstString(record.value.uuid);
    if (uuid !== undefined) byUuid.set(uuid, record);
  }
  const active = new Set<string>();
  let current = [...records].reverse().find((record) => firstString(record.value.uuid) !== undefined);
  while (current !== undefined) {
    const uuid = firstString(current.value.uuid);
    if (uuid === undefined || active.has(uuid)) break;
    active.add(uuid);
    const parentUuid = firstString(current.value.parentUuid);
    current = parentUuid === undefined ? undefined : byUuid.get(parentUuid);
  }
  return active;
}

function assistantGroups(
  files: ParsedTranscript[],
  activeByPath: Map<string, Set<string>>,
): AssistantGroup[] {
  const result: AssistantGroup[] = [];
  for (const file of files) {
    if (file.streamId === undefined) continue;
    const active = activeByPath.get(file.path) ?? new Set<string>();
    const groups = new Map<string, AssistantGroup>();
    for (const record of file.records) {
      if (record.value.type !== "assistant" || !isPlainObject(record.value.message)) continue;
      const messageId = firstString(record.value.message.id);
      const uuid = firstString(record.value.uuid);
      if (messageId === undefined || uuid === undefined || !active.has(uuid)) continue;
      let group = groups.get(messageId);
      if (group === undefined) {
        group = {
          sourceAssistantMessageId: messageId,
          streamId: file.streamId,
          transcriptPath: file.path,
          records: [],
          text: [],
          tools: [],
        };
        groups.set(messageId, group);
      }
      group.records.push(record);
      const content = messageContent(record.value);
      if (!Array.isArray(content)) continue;
      for (const [blockIndex, block] of content.entries()) {
        if (!isPlainObject(block)) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
          group.text.push(block.text);
        } else if (block.type === "tool_use") {
          group.tools.push({ block, record, blockIndex });
        }
      }
    }
    result.push(...groups.values());
  }
  return result;
}

function rootMessages(root: ParsedTranscript, active: Set<string>): ClaudeReplayMessage[] {
  const messages: ClaudeReplayMessage[] = [];
  const groups = assistantGroups([root], new Map([[root.path, active]]));
  for (const record of root.records) {
    const uuid = firstString(record.value.uuid);
    if (uuid === undefined || !active.has(uuid)) continue;
    if (record.value.type !== "user" || record.value.isSidechain === true || record.value.isMeta === true) continue;
    if (!isPlainObject(record.value.origin) || record.value.origin.kind !== "human") continue;
    const content = authoredUserContent(messageContent(record.value));
    if (content === undefined) continue;
    messages.push({
      role: "user",
      content,
      timestamp: firstString(record.value.timestamp) ?? "",
      ordinal: record.ordinal * 1000,
      streamId: "root",
    });
  }
  for (const group of groups) {
    const content = group.text.join("\n").trim();
    if (content === "") continue;
    messages.push({
      role: "assistant",
      content,
      timestamp: firstString(group.records[0].value.timestamp) ?? "",
      ordinal: group.records[0].ordinal * 1000,
      streamId: "root",
    });
  }
  return messages;
}

function authoredUserContent(value: unknown): string | undefined {
  const raw = typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.filter(isPlainObject)
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n")
      : "";
  const commandName = extractTag(raw, "command-name")?.trim();
  if (commandName !== undefined && commandName !== "") {
    const args = extractTag(raw, "command-args")?.trim() ?? "";
    return args === "" ? commandName : `${commandName} ${args}`;
  }
  const content = raw.trim();
  return content === "" ? undefined : content;
}

function linkedTranscriptClosure(
  files: ParsedTranscript[],
  rootPath: string,
  steps: StepBuilder[],
): Set<string> {
  const included = new Set([rootPath]);
  let changed = true;
  while (changed) {
    changed = false;
    const includedCalls = new Set(
      steps.filter((step) => included.has(step.transcriptPath))
        .flatMap((step) => step.toolCalls.map((call) => call.sourceCallId)),
    );
    for (const file of files) {
      if (included.has(file.path) || file.isRoot) continue;
      if (file.parentCallId === undefined || includedCalls.has(file.parentCallId)) {
        included.add(file.path);
        changed = true;
      }
    }
  }
  return included;
}

async function directResultParts(
  record: SourceRecord,
  block: Record<string, unknown>,
  file: ParsedTranscript,
  sessionId: string,
  corpusDirectory: string,
): Promise<{ parts: OutputPart[]; unsupportedRecords: number }> {
  const timestamp = firstString(record.value.timestamp) ?? "";
  const toolUseResult = isPlainObject(record.value.toolUseResult)
    ? record.value.toolUseResult
    : undefined;
  const persisted = toolUseResult === undefined
    ? undefined
    : firstString(toolUseResult.persistedOutputPath);
  if (persisted !== undefined && toolUseResult !== undefined) {
    const complete = await readPersistedOutput(
      file.path,
      sessionId,
      persisted,
      toolUseResult,
      corpusDirectory,
    );
    if (complete !== undefined) {
      return {
        parts: [{ value: complete, timestamp, ordinal: record.ordinal * 1000, transcriptPath: file.path }],
        unsupportedRecords: 0,
      };
    }
  }
  return {
    parts: outputValues(block.content).map((value, index) => ({
      value,
      timestamp,
      ordinal: record.ordinal * 1000 + index,
      transcriptPath: file.path,
    })),
    unsupportedRecords: persisted === undefined ? 0 : 1,
  };
}

async function readPersistedOutput(
  transcriptPath: string,
  sessionId: string,
  recordedPath: string,
  toolUseResult: Record<string, unknown>,
  corpusDirectory: string,
): Promise<string | undefined> {
  const basename = path.basename(recordedPath);
  if (basename === "" || basename === "." || basename === "..") return undefined;
  const sessionDirectory = sessionDirectoryForTranscript(transcriptPath, sessionId);
  if (sessionDirectory === undefined) return undefined;
  const candidate = path.join(sessionDirectory, "tool-results", basename);
  try {
    const metadata = await lstat(candidate);
    const expectedSize = finiteNumber(toolUseResult.persistedOutputSize);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || expectedSize === undefined
      || metadata.size !== expectedSize
    ) {
      return undefined;
    }
    const resolvedCorpus = await realpath(corpusDirectory);
    const resolvedSession = await realpath(sessionDirectory);
    const resolvedCandidate = await realpath(candidate);
    if (
      !isDirectoryWithinImportRoot(resolvedCorpus, resolvedSession)
      || !isDirectoryWithinImportRoot(resolvedSession, path.dirname(resolvedCandidate))
    ) {
      return undefined;
    }
    const stdout = (await readFile(resolvedCandidate)).toString("utf8");
    const stderr = firstString(toolUseResult.stderr);
    return stderr === undefined || stderr === "" ? stdout : `${stdout}\n${stderr}`;
  } catch {
    return undefined;
  }
}

function sessionDirectoryForTranscript(transcriptPath: string, sessionId: string): string | undefined {
  if (!isSafePathSegment(sessionId)) return undefined;
  const filename = path.basename(transcriptPath, ".jsonl");
  if (filename === path.basename(transcriptPath)) return undefined;
  const transcriptDirectory = path.dirname(transcriptPath);
  if (filename === sessionId) return path.join(transcriptDirectory, sessionId);
  if (
    path.basename(transcriptDirectory) === "subagents"
    && path.basename(path.dirname(transcriptDirectory)) === sessionId
  ) {
    return path.dirname(transcriptDirectory);
  }
  return undefined;
}

function isSafePathSegment(value: string): boolean {
  return value !== "."
    && value !== ".."
    && value === path.basename(value)
    && !value.includes("/")
    && !value.includes("\\");
}

function outputValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return value === undefined ? [] : [stableSerialize(value)];
  return value.map((part) => {
    if (isPlainObject(part) && part.type === "text" && typeof part.text === "string") {
      return part.text;
    }
    return stableSerialize(part);
  });
}

function taskNotificationResult(value: Record<string, unknown>): {
  sourceCallId: string;
  result: string;
  status?: ClaudeReplayStatus;
} | undefined {
  if (value.type !== "user" || !isPlainObject(value.origin) || value.origin.kind !== "task-notification") {
    return undefined;
  }
  const content = messageContent(value);
  if (typeof content !== "string" || !content.trimStart().startsWith("<task-notification>")) {
    return undefined;
  }
  const sourceCallId = extractTag(content, "tool-use-id")?.trim();
  if (sourceCallId === undefined || sourceCallId === "") return undefined;
  const status = normalizeNotificationStatus(extractTag(content, "status"));
  return {
    sourceCallId,
    result: extractTag(content, "result") ?? "",
    ...(status !== undefined ? { status } : {}),
  };
}

function extractTag(value: string, tag: string): string | undefined {
  const opening = `<${tag}>`;
  const closing = `</${tag}>`;
  const start = value.indexOf(opening);
  const end = value.lastIndexOf(closing);
  if (start < 0 || end < start + opening.length) return undefined;
  return value.slice(start + opening.length, end);
}

function normalizeNotificationStatus(value: string | undefined): ClaudeReplayStatus | undefined {
  switch (value?.trim().toLowerCase()) {
    case "completed": return "success";
    case "failed": return "failure";
    case "error": return "error";
    case "timed_out":
    case "timeout": return "timeout";
    case "cancelled":
    case "canceled": return "cancelled";
    case "pending":
    case "running": return "pending";
    default: return undefined;
  }
}

function isAsyncResult(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const status = firstString(value.status)?.toLowerCase();
  return value.isAsync === true || status === "async_launched" || status === "running";
}

function messageContent(value: Record<string, unknown>): unknown {
  return isPlainObject(value.message) ? value.message.content : undefined;
}

function callKey(streamId: string, sourceCallId: string): string {
  return `${streamId}\n${sourceCallId}`;
}

function stableSerialize(value: unknown): string {
  const serialized = JSON.stringify(sortJson(value));
  return serialized ?? String(value ?? "");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function elapsedMs(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

function timestampMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteNumber(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

function compareTimeline(
  left: { timestamp: string; streamId?: string; ordinal: number },
  right: { timestamp: string; streamId?: string; ordinal: number },
): number {
  return left.timestamp.localeCompare(right.timestamp)
    || (left.streamId ?? "").localeCompare(right.streamId ?? "")
    || left.ordinal - right.ordinal;
}

function isClaudeMemoryTranscript(projectsDirectory: string, candidate: string): boolean {
  return path.relative(projectsDirectory, candidate).split(path.sep).includes("memory");
}
