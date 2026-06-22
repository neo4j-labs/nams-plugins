import { firstString } from "../../runtime/util.js";

export interface AntigravityPayloadInfo {
  sessionId?: string;
  workspacePaths: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  invocationNum?: number;
  initialNumSteps?: number;
  stepIdx?: number;
  error?: unknown;
  executionNum?: number;
  terminationReason?: string;
  fullyIdle?: boolean;
  projectDirectory: string;
}

export function parseAntigravityPayload(
  payload: Record<string, unknown>,
  processCwd: string,
): AntigravityPayloadInfo {
  const workspacePaths = stringArray(payload.workspacePaths);
  const sessionId = firstString(payload.conversationId);
  const transcriptPath = firstString(payload.transcriptPath);
  const artifactDirectoryPath = firstString(payload.artifactDirectoryPath);
  const invocationNum = numberValue(payload.invocationNum);
  const initialNumSteps = numberValue(payload.initialNumSteps);
  const stepIdx = numberValue(payload.stepIdx);
  const executionNum = numberValue(payload.executionNum);
  const terminationReason = firstString(payload.terminationReason);
  const fullyIdle = booleanValue(payload.fullyIdle);

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    workspacePaths,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(artifactDirectoryPath !== undefined ? { artifactDirectoryPath } : {}),
    ...(invocationNum !== undefined ? { invocationNum } : {}),
    ...(initialNumSteps !== undefined ? { initialNumSteps } : {}),
    ...(stepIdx !== undefined ? { stepIdx } : {}),
    ...(payload.error !== undefined ? { error: payload.error } : {}),
    ...(executionNum !== undefined ? { executionNum } : {}),
    ...(terminationReason !== undefined ? { terminationReason } : {}),
    ...(fullyIdle !== undefined ? { fullyIdle } : {}),
    projectDirectory: workspacePaths[0] ?? processCwd,
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
