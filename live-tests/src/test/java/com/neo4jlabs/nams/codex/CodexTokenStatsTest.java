package com.neo4jlabs.nams.codex;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class CodexTokenStatsTest {
    @Test
    void readsAvailableTokenStatsFromJsonl() {
        String jsonl = """
            {"type":"diagnostic"}
            not-json
            {"type":"usage","usage":{"input_tokens":123,"output_tokens":45,"cached_input_tokens":67}}
            """;

        CodexTokenStats stats = CodexTokenStats.fromJsonl(jsonl).orElseThrow();

        assertThat(stats.inputTokens()).isEqualTo(123);
        assertThat(stats.outputTokens()).isEqualTo(45);
        assertThat(stats.cachedInputTokens()).isEqualTo(67);
    }

    @Test
    void returnsEmptyWhenTokenStatsAreUnavailable() {
        assertThat(CodexTokenStats.fromJsonl("{\"type\":\"message\"}\n")).isEmpty();
    }
}
