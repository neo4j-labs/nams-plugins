export function hasSeenAny(seen, keys) {
    return keys.some((key) => seen.includes(key));
}
export function markSeen(seen, keys) {
    for (const key of keys) {
        if (!seen.includes(key)) {
            seen.push(key);
        }
    }
}
export function hasSeenAssistantMessage(state, hash) {
    return state.lastAssistantMessageHash === hash || state.seenAssistantMessageHashes.includes(hash);
}
export function markAssistantMessageSeen(state, hashes) {
    state.lastAssistantMessageHash = hashes[0];
    for (const hash of hashes) {
        if (!state.seenAssistantMessageHashes.includes(hash)) {
            state.seenAssistantMessageHashes.push(hash);
        }
    }
}
