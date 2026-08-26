export type CodexReplayStatus =
  | "pending"
  | "success"
  | "failure"
  | "error"
  | "timeout"
  | "cancelled";

export interface CodexReplayMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  ordinal: number;
  threadId: string;
}

export interface CodexReplayToolCall {
  sourceCallId: string;
  toolName: string;
  input: unknown;
  output?: string;
  status?: CodexReplayStatus;
  durationMs?: number;
  timestamp: string;
  ordinal: number;
}

export interface CodexReplayStep {
  localStepId: string;
  sourceReasoningId: string;
  threadId: string;
  turnId: string;
  timestamp: string;
  ordinal: number;
  reasoning: string;
  actionTaken: string;
  result?: string;
  toolCalls: CodexReplayToolCall[];
}

export interface CodexReplaySession {
  sourceSessionId: string;
  projectDirectory: string;
  sourceStartedAt?: string;
  messages: CodexReplayMessage[];
  steps: CodexReplayStep[];
}

export interface CodexReplayCollection {
  sessions: CodexReplaySession[];
  discoveredFiles: number;
  matchedFiles: number;
  skippedFiles: number;
  malformedLines: number;
  unsupportedRecords: number;
}

export interface CodexReplayFileProgress {
  path: string;
  status: "imported" | "skipped";
}

export interface CollectCodexReplayInput {
  importRoot: string;
  transcriptPaths?: string[];
  env?: NodeJS.ProcessEnv;
  onFileProcessed?: (event: CodexReplayFileProgress) => void;
}

export type CodexReplayOutboxRecord =
  | {
      kind: "conversation.create";
      localConversationId: string;
      sourceSessionId: string;
      projectDirectory: string;
      sourceStartedAt?: string;
    }
  | {
      kind: "message.add";
      localConversationId: string;
      role: "user" | "assistant";
      content: string;
    }
  | {
      kind: "reasoningStep.create";
      localConversationId: string;
      localStepId: string;
      reasoning: string;
      actionTaken: string;
      result?: string;
    }
  | {
      kind: "toolCall.create";
      localStepId: string;
      toolName: string;
      input: unknown;
      output?: string;
      status?: CodexReplayStatus;
      durationMs?: number;
    };

export interface CodexReplayOutbox {
  directory: string;
  path: string;
  recordCount: number;
}

export interface CreateCodexReplayOutboxInput {
  sessions: CodexReplaySession[];
  temporaryRoot?: string;
}
