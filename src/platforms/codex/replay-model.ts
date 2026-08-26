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

export interface CollectCodexReplayInput {
  importRoot: string;
  transcriptPaths?: string[];
  env?: NodeJS.ProcessEnv;
}
