import type { HookInvocation, HookResult, MemoryPlatformAdapter } from "../../interfaces.js";
import { recordActiveWorkspaceSession } from "../../runtime/active-workspace-session.js";
import { type AssistantMessageState } from "../../runtime/dedupe.js";
import { sha256 } from "../../runtime/hashing.js";
import { appendNamsFailureDiagnostic } from "../../runtime/logging.js";
import {
  createNamsMemoryService,
  serializeToolInput,
  type NamsMemoryService,
} from "../../runtime/memory-service.js";
import {
  assistantContentHash,
  ensureConversation,
  recallMemoryContextOnce,
  recordToolCallOnce,
  storeAssistantMessageOnce,
  storeUserPromptOnce,
  withHookSessionState,
  type ToolCallTraceState,
} from "../../runtime/memory-turn.js";
import { sessionStatePath } from "../../runtime/paths.js";
import { type SessionState } from "../../runtime/session-state.js";
import {
  loadEffectiveNamsConfigForMemory,
  resolveWorkspaceForMemory,
  type WorkspaceResolutionResult,
} from "../../runtime/workspace-resolution.js";
import { formatWorkspaceSelectionNotice } from "../workspace-selection.js";
import { parseCodexPayload } from "./payload.js";
import { readCodexTranscript, type CodexTranscriptEntry } from "./transcript.js";

async function startSession(invocation: HookInvocation<"SessionStart">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async () => {
      return { stdout: { continue: true, suppressOutput: true } };
    });
}

async function beforeAgent(invocation: HookInvocation<"BeforeAgent">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      if (payloadInfo.prompt === undefined) {
        return allowOutput();
      }
      if (isWorkspaceSkillPrompt(payloadInfo.prompt)) {
        await recordSelectionRequiredWorkspaceSession(
          invocation,
          state,
          payloadInfo.projectDirectory,
          payloadInfo.sessionId,
        );
        return allowOutput();
      }

      const workspaceResult = await resolveWorkspaceForMemory({
        invocation,
        state,
        projectDirectory: payloadInfo.projectDirectory,
      });
      if (workspaceResult.status !== "ready") {
        if (workspaceResult.reason === "selection-required") {
          await recordSelectionRequiredWorkspaceSession(
            invocation,
            state,
            payloadInfo.projectDirectory,
            payloadInfo.sessionId,
          );
        }
        return workspaceResultOutput(workspaceResult, payloadInfo.sessionId);
      }

      let additionalContext: string | undefined;
      try {
        const memory = createNamsMemoryService(workspaceResult.config, invocation, state);
        const conversationId = await ensureConversation(memory, invocation, state, payloadInfo.projectDirectory);
        additionalContext = await recallMemoryContextOnce(memory, invocation, state, conversationId, payloadInfo.prompt);
        await storeUserPromptOnce(memory, invocation, state, conversationId, payloadInfo.prompt);
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowOutput(additionalContext);
    });
}

async function afterAgent(invocation: HookInvocation<"AfterAgent">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      if (state.conversationId === undefined) {
        return allowOutput();
      }
      const conversationId = state.conversationId;

      const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
      if (config === undefined) {
        return allowOutput();
      }

      try {
        const memory = createNamsMemoryService(config, invocation, state);
        const response = payloadInfo.lastAssistantMessage?.trim();
        if (response !== undefined && response !== "") {
          await storeAssistantMessageOnce(memory, state, conversationId, response, {
            lookupHash: assistantMessageDedupeHash(invocation.platform, state.sessionKey, response, payloadInfo.turnId),
            markHashes: assistantMessageHashes(invocation.platform, state.sessionKey, response, payloadInfo.turnId),
          });
        }
        if (payloadInfo.transcriptPath !== undefined) {
          const entries = await readCodexTranscript(payloadInfo.transcriptPath);
          if (response === undefined || response === "") {
            await storeAssistantMessagesFromTranscript(invocation.platform, conversationId, state, memory, entries);
          }
          await recordTraceFromTranscript(conversationId, state, memory, entries);
        }
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
        return allowOutput();
      }

      return allowOutput();
    });
}

async function afterTool(invocation: HookInvocation<"AfterTool">): Promise<HookResult> {
    const payloadInfo = parseCodexPayload(invocation.rawPayload, invocation.processCwd);
    return withHookSessionState(invocation, payloadInfo, async (state) => {
      const conversationId = state.conversationId;
      const toolName = payloadInfo.toolName;
      if (conversationId === undefined || toolName === undefined) {
        return allowPostToolUseOutput();
      }

      const config = await loadEffectiveNamsConfigForMemory(invocation, state, payloadInfo.projectDirectory);
      if (config === undefined) {
        return allowPostToolUseOutput();
      }

      const toolInput = payloadInfo.toolInput ?? {};
      const toolCallId = codexToolCallId({
        sessionKey: state.sessionKey,
        toolName,
        turnId: payloadInfo.turnId,
        toolUseId: payloadInfo.toolUseId,
        toolInput,
      });

      try {
        const memory = createNamsMemoryService(config, invocation, state);
        await recordToolCallOnce(
          memory,
          state,
          { lookupKeys: [toolCallId], markKeys: [toolCallId] },
          {
            conversationId,
            reasoning: `Codex ran ${toolName} for the current turn.`,
            actionTaken: `Ran ${toolName}`,
            ...(payloadInfo.toolResponse !== undefined ? { result: "Codex exposed post-tool output." } : {}),
          },
          codexReasoningStepHash({ sessionKey: state.sessionKey, toolName, turnId: payloadInfo.turnId }),
          {
            toolName,
            input: toolInput,
            ...(payloadInfo.toolResponse !== undefined ? { output: payloadInfo.toolResponse } : {}),
          },
        );
      } catch {
        await appendNamsFailureDiagnostic(invocation, state);
      }

      return allowPostToolUseOutput();
    });
}

export const codexMemoryAdapter: Required<MemoryPlatformAdapter> = { startSession, beforeAgent, afterAgent, afterTool };

function allowOutput(additionalContext?: string): HookResult {
  return {
    stdout: {
      continue: true,
      suppressOutput: true,
      ...(additionalContext !== undefined
        ? {
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext,
            },
          }
        : {}),
    },
  };
}

function workspaceResultOutput(
  result: Exclude<WorkspaceResolutionResult, { status: "ready" }>,
  sessionId?: string,
): HookResult {
  if (result.reason === "selection-required") {
    return allowOutput(formatWorkspaceSelectionNotice("codex", result.workspaces, sessionId, [
      "Select a session workspace with: $nams:workspace use <workspace-id-or-name>",
    ]));
  }
  return allowOutput();
}

async function recordSelectionRequiredWorkspaceSession(
  invocation: HookInvocation,
  state: SessionState,
  projectDirectory: string,
  sessionId?: string,
): Promise<void> {
  try {
    await recordActiveWorkspaceSession({
      platform: invocation.platform,
      sessionId,
      sessionKey: state.sessionKey,
      projectDirectory,
      statePath: sessionStatePath(invocation.platform, state.sessionKey, state.createdAt),
    });
  } catch {
    return;
  }
}

function allowPostToolUseOutput(): HookResult {
  return { stdout: { continue: true } };
}

function isWorkspaceSkillPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return trimmed === "$nams:workspace" || trimmed.startsWith("$nams:workspace ");
}

async function storeAssistantMessagesFromTranscript(
  platform: string,
  conversationId: string,
  state: AssistantMessageState & { seenTranscriptEntryIds: string[]; sessionKey: string },
  memory: NamsMemoryService,
  entries: CodexTranscriptEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.kind !== "assistant") {
      continue;
    }
    if (entry.id !== undefined && state.seenTranscriptEntryIds.includes(entry.id)) {
      continue;
    }

    const content = entry.content.trim();
    if (content !== "") {
      const responseHash = assistantContentHash(platform, state.sessionKey, content);
      await storeAssistantMessageOnce(memory, state, conversationId, content, {
        lookupHash: responseHash,
        markHashes: [responseHash],
      });
    }

    if (entry.id !== undefined) {
      state.seenTranscriptEntryIds.push(entry.id);
    }
  }
}

async function recordTraceFromTranscript(
  conversationId: string,
  state: ToolCallTraceState & { sessionKey: string },
  memory: NamsMemoryService,
  entries: CodexTranscriptEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.kind !== "toolCall") {
      continue;
    }

    const toolCallId = codexTranscriptToolCallId(state.sessionKey, entry);
    await recordToolCallOnce(
      memory,
      state,
      { lookupKeys: [toolCallId], markKeys: [toolCallId] },
      {
        conversationId,
        reasoning: `Codex exposed ${entry.name} from the session transcript.`,
        actionTaken: `Ran ${entry.name}`,
        ...(entry.status !== undefined ? { result: `Codex transcript recorded status: ${entry.status}.` } : {}),
      },
      codexTranscriptReasoningStepHash(state.sessionKey, entry.name, entry.status),
      {
        toolName: entry.name,
        input: entry.args,
        ...(entry.status !== undefined ? { status: entry.status } : {}),
      },
    );
  }
}

function assistantMessageDedupeHash(platform: string, sessionKey: string, content: string, turnId?: string): string {
  if (turnId === undefined) {
    return assistantContentHash(platform, sessionKey, content);
  }
  return sha256([platform, sessionKey, "assistant", "turn", turnId, content].join("\n"));
}

function assistantMessageHashes(platform: string, sessionKey: string, content: string, turnId?: string): string[] {
  const contentHash = assistantContentHash(platform, sessionKey, content);
  if (turnId === undefined) {
    return [contentHash];
  }
  return [assistantMessageDedupeHash(platform, sessionKey, content, turnId), contentHash];
}

function codexToolCallId(input: {
  sessionKey: string;
  toolName: string;
  turnId?: string;
  toolUseId?: string;
  toolInput: unknown;
}): string {
  if (input.toolUseId !== undefined) {
    return `codex-tool-use-id:${input.toolUseId}`;
  }
  return `codex-tool-fallback:${sha256(
    [input.sessionKey, input.turnId ?? "", input.toolName, serializeToolInput(input.toolInput)].join("\n"),
  )}`;
}

function codexReasoningStepHash(input: { sessionKey: string; toolName: string; turnId?: string }): string {
  return sha256([input.sessionKey, "codex-reasoning-step", input.turnId ?? "", input.toolName].join("\n"));
}

function codexTranscriptToolCallId(
  sessionKey: string,
  entry: Extract<CodexTranscriptEntry, { kind: "toolCall" }>,
): string {
  if (entry.id !== undefined) {
    return `codex-transcript-tool-id:${entry.id}`;
  }
  return `codex-transcript-tool-fallback:${sha256(
    [sessionKey, String(entry.transcriptEntryIndex), entry.name, serializeToolInput(entry.args)].join("\n"),
  )}`;
}

function codexTranscriptReasoningStepHash(sessionKey: string, toolName: string, status?: string): string {
  return sha256([sessionKey, "codex-transcript-reasoning-step", toolName, status ?? ""].join("\n"));
}
