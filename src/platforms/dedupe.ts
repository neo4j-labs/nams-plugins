export interface AssistantMessageState {
  lastAssistantMessageHash?: string;
  seenAssistantMessageHashes: string[];
}

export function hasSeenAny(seen: string[], keys: string[]): boolean {
  return keys.some((key) => seen.includes(key));
}

export function markSeen(seen: string[], keys: string[]): void {
  for (const key of keys) {
    if (!seen.includes(key)) {
      seen.push(key);
    }
  }
}

export function hasSeenAssistantMessage(state: AssistantMessageState, hash: string): boolean {
  return state.lastAssistantMessageHash === hash || state.seenAssistantMessageHashes.includes(hash);
}

export function markAssistantMessageSeen(state: AssistantMessageState, hashes: string[]): void {
  state.lastAssistantMessageHash = hashes[0];
  for (const hash of hashes) {
    if (!state.seenAssistantMessageHashes.includes(hash)) {
      state.seenAssistantMessageHashes.push(hash);
    }
  }
}
