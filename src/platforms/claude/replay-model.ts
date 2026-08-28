export type ClaudeReplayStatus =
  | "pending"
  | "success"
  | "failure"
  | "error"
  | "timeout"
  | "cancelled";

export interface ClaudeReplayMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  ordinal: number;
  streamId: string;
}

export interface ClaudeReplayToolCall {
  sourceCallId: string;
  toolName: string;
  input: unknown;
  output?: string;
  status?: ClaudeReplayStatus;
  durationMs?: number;
  timestamp: string;
  ordinal: number;
}

export interface ClaudeReplayStep {
  localStepId: string;
  sourceAssistantMessageId: string;
  streamId: string;
  timestamp: string;
  ordinal: number;
  reasoning: string;
  actionTaken: string;
  result?: string;
  toolCalls: ClaudeReplayToolCall[];
}

export interface ClaudeReplaySession {
  sourceSessionId: string;
  projectDirectory: string;
  sourceStartedAt?: string;
  messages: ClaudeReplayMessage[];
  steps: ClaudeReplayStep[];
}

export interface ClaudeReplayCollection {
  sessions: ClaudeReplaySession[];
  discoveredFiles: number;
  matchedFiles: number;
  skippedFiles: number;
  malformedLines: number;
  unsupportedRecords: number;
}

export interface ClaudeReplayFileProgress {
  path: string;
  status: "imported" | "skipped";
}

export interface CollectClaudeReplayInput {
  importRoot: string;
  transcriptPaths?: string[];
  env?: NodeJS.ProcessEnv;
  onFileProcessed?: (event: ClaudeReplayFileProgress) => void;
}
