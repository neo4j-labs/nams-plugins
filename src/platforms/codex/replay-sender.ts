import path from "node:path";
import {
  NamsClient,
  NamsWorkspaceClient,
  type NamsRequestEvent,
  type RecordToolCallRequest,
  type WorkspaceListResponse,
} from "../../generated/nams-client.js";
import {
  loadNamsConnectionConfig,
  type NamsConnectionConfigLoadResult,
} from "../../runtime/config.js";
import {
  serializeToolInput,
  serializeToolOutput,
} from "../../runtime/memory-service.js";
import { namsReplayProvenanceHeaders } from "../../runtime/provenance.js";
import { validWorkspaces } from "../../runtime/workspace-configuration.js";
import { readCodexReplayOutbox } from "./replay-outbox.js";

export interface SendCodexReplayOutboxInput {
  outboxPath: string;
  importRoot: string;
  fetch?: typeof fetch;
  onProgress?: (line: string) => void;
}

export interface CodexReplaySendSummary {
  conversations: number;
  messages: number;
  reasoningSteps: number;
  toolCalls: number;
}

interface ResolvedDestination {
  apiKey: string;
  workspaceId: string;
  baseUrl: string;
}

export async function sendCodexReplayOutbox(
  input: SendCodexReplayOutboxInput,
): Promise<CodexReplaySendSummary> {
  const records = await readCodexReplayOutbox(input.outboxPath);
  const onRequest = (event: NamsRequestEvent): void => {
    input.onProgress?.(`  - ${event.method} ${event.path}`);
  };
  const destination = await resolveDestination(input, onRequest);
  const client = new NamsClient({
    ...destination,
    defaultHeaders: namsReplayProvenanceHeaders(),
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    onRequest,
  });
  const conversationIds = new Map<string, string>();
  const stepIds = new Map<string, string>();
  const summary: CodexReplaySendSummary = {
    conversations: 0,
    messages: 0,
    reasoningSteps: 0,
    toolCalls: 0,
  };

  for (const record of records) {
    if (record.kind === "conversation.create") {
      const response = await namsRequest(() => client.createConversation({
        metadata: {
          harness: "codex",
          projectDirectory: record.projectDirectory,
          sourceSessionId: record.sourceSessionId,
          importSource: "nams-hooks-replay",
          ...(record.sourceStartedAt !== undefined
            ? { sourceStartedAt: record.sourceStartedAt }
            : {}),
        },
      }));
      const conversationId = requiredId(
        response.id,
        "NAMS conversation response did not include id",
      );
      conversationIds.set(record.localConversationId, conversationId);
      summary.conversations += 1;
      continue;
    }

    if (record.kind === "message.add") {
      const conversationId = conversationIds.get(record.localConversationId);
      if (conversationId === undefined) {
        throw new Error(
          `Codex replay outbox references an unknown conversation: ${record.localConversationId}`,
        );
      }
      await namsRequest(() => client.addMessage(conversationId, {
        role: record.role,
        content: record.content,
      }));
      summary.messages += 1;
      continue;
    }

    if (record.kind === "reasoningStep.create") {
      const conversationId = conversationIds.get(record.localConversationId);
      if (conversationId === undefined) {
        throw new Error(
          `Codex replay outbox references an unknown conversation: ${record.localConversationId}`,
        );
      }
      const response = await namsRequest(() => client.recordReasoningStep({
        conversationId,
        reasoning: record.reasoning,
        actionTaken: record.actionTaken,
        ...(record.result !== undefined ? { result: record.result } : {}),
      }));
      const stepId = requiredId(
        response.id,
        "NAMS reasoning response did not include id",
      );
      stepIds.set(record.localStepId, stepId);
      summary.reasoningSteps += 1;
      continue;
    }

    const stepId = stepIds.get(record.localStepId);
    if (stepId === undefined) {
      throw new Error(
        `Codex replay outbox references an unknown reasoning step: ${record.localStepId}`,
      );
    }
    const toolRequest: RecordToolCallRequest = {
      stepId,
      toolName: record.toolName,
      input: serializeToolInput(record.input),
      ...(record.output !== undefined
        ? { output: serializeToolOutput(record.output) }
        : {}),
      ...(record.status !== undefined ? { status: record.status } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    };
    await namsRequest(() => client.recordToolCall(toolRequest));
    summary.toolCalls += 1;
  }

  return summary;
}

async function resolveDestination(
  input: SendCodexReplayOutboxInput,
  onRequest: (event: NamsRequestEvent) => void,
): Promise<ResolvedDestination> {
  let connection: NamsConnectionConfigLoadResult;
  try {
    connection = await loadNamsConnectionConfig(path.resolve(input.importRoot));
  } catch {
    throw new Error("NAMS replay configuration unavailable");
  }
  if (!connection.ok) {
    throw new Error(`NAMS replay configuration unavailable: ${connection.reason}`);
  }
  if (connection.config.workspaceId !== undefined) {
    return {
      apiKey: connection.config.apiKey,
      workspaceId: connection.config.workspaceId,
      baseUrl: connection.config.baseUrl,
    };
  }

  const workspaceClient = new NamsWorkspaceClient({
    apiKey: connection.config.apiKey,
    baseUrl: connection.config.baseUrl,
    defaultHeaders: namsReplayProvenanceHeaders(),
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    onRequest,
  });
  let response: WorkspaceListResponse;
  try {
    response = await workspaceClient.listMyWorkspaces();
  } catch {
    throw new Error("NAMS workspace resolution failed for replay");
  }
  const workspaces = validWorkspaces(response.workspaces);
  if (workspaces.length === 0) {
    throw new Error("No NAMS workspace is available for replay");
  }
  if (workspaces.length !== 1) {
    throw new Error("NAMS workspace selection is required before replay");
  }
  return {
    apiKey: connection.config.apiKey,
    workspaceId: workspaces[0].id,
    baseUrl: connection.config.baseUrl,
  };
}

async function namsRequest<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error("NAMS request failed during Codex replay");
  }
}

function requiredId(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === "") throw new Error(message);
  return value;
}
