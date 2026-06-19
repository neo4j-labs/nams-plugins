package com.neo4jlabs.nams.codex;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.Iterator;
import java.util.Optional;

class CodexTokenStats {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final long inputTokens;
    private final long outputTokens;
    private final long cachedInputTokens;

    private CodexTokenStats(long inputTokens, long outputTokens, long cachedInputTokens) {
        this.inputTokens = inputTokens;
        this.outputTokens = outputTokens;
        this.cachedInputTokens = cachedInputTokens;
    }

    static Optional<CodexTokenStats> fromJsonl(String jsonl) {
        TokenAccumulator accumulator = new TokenAccumulator();
        for (String line : jsonl.lines().toList()) {
            if (line.isBlank()) {
                continue;
            }
            try {
                accumulate(MAPPER.readTree(line), accumulator);
            } catch (IOException ignored) {
                // Codex may mix non-JSON diagnostics into stdout/stderr; those lines do not carry usage.
            }
        }
        return accumulator.hasValues() ? Optional.of(accumulator.toStats()) : Optional.empty();
    }

    long inputTokens() {
        return inputTokens;
    }

    long outputTokens() {
        return outputTokens;
    }

    long cachedInputTokens() {
        return cachedInputTokens;
    }

    private static void accumulate(JsonNode node, TokenAccumulator accumulator) {
        if (node == null || node.isNull()) {
            return;
        }
        if (node.isObject()) {
            accumulator.recordInput(firstLong(node, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"));
            accumulator.recordOutput(firstLong(node, "output_tokens", "outputTokens", "completion_tokens", "completionTokens"));
            accumulator.recordCached(firstLong(
                node,
                "cached_input_tokens",
                "cachedInputTokens",
                "input_cached_tokens",
                "inputCachedTokens",
                "cached_tokens",
                "cachedTokens"
            ));
            Iterator<JsonNode> fields = node.elements();
            while (fields.hasNext()) {
                accumulate(fields.next(), accumulator);
            }
            return;
        }
        if (node.isArray()) {
            for (JsonNode child : node) {
                accumulate(child, accumulator);
            }
        }
    }

    private static Optional<Long> firstLong(JsonNode node, String... names) {
        for (String name : names) {
            JsonNode value = node.get(name);
            if (value != null && value.canConvertToLong()) {
                return Optional.of(value.asLong());
            }
        }
        return Optional.empty();
    }

    private static final class TokenAccumulator {
        private long inputTokens;
        private long outputTokens;
        private long cachedInputTokens;
        private boolean hasValues;

        void recordInput(Optional<Long> value) {
            value.ifPresent(tokens -> {
                inputTokens = Math.max(inputTokens, tokens);
                hasValues = true;
            });
        }

        void recordOutput(Optional<Long> value) {
            value.ifPresent(tokens -> {
                outputTokens = Math.max(outputTokens, tokens);
                hasValues = true;
            });
        }

        void recordCached(Optional<Long> value) {
            value.ifPresent(tokens -> {
                cachedInputTokens = Math.max(cachedInputTokens, tokens);
                hasValues = true;
            });
        }

        boolean hasValues() {
            return hasValues;
        }

        CodexTokenStats toStats() {
            return new CodexTokenStats(inputTokens, outputTokens, cachedInputTokens);
        }
    }
}
