package com.neo4jlabs.nams.codex;

import io.restassured.path.json.JsonPath;
import io.restassured.path.json.exception.JsonPathException;
import java.util.Map;
import java.util.Optional;

class CodexTokenStats {
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
                accumulate(JsonPath.from(line).get(), accumulator);
            } catch (JsonPathException ignored) {
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

    private static void accumulate(Object node, TokenAccumulator accumulator) {
        if (node == null) {
            return;
        }
        if (node instanceof Map<?, ?> map) {
            accumulator.recordInput(firstLong(map, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"));
            accumulator.recordOutput(firstLong(map, "output_tokens", "outputTokens", "completion_tokens", "completionTokens"));
            accumulator.recordCached(firstLong(
                map,
                "cached_input_tokens",
                "cachedInputTokens",
                "input_cached_tokens",
                "inputCachedTokens",
                "cached_tokens",
                "cachedTokens"
            ));
            map.values().forEach(child -> accumulate(child, accumulator));
            return;
        }
        if (node instanceof Iterable<?> nodes) {
            for (Object child : nodes) {
                accumulate(child, accumulator);
            }
        }
    }

    private static Optional<Long> firstLong(Map<?, ?> node, String... names) {
        for (String name : names) {
            Object value = node.get(name);
            if (value instanceof Number number) {
                return Optional.of(number.longValue());
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
