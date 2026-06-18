package com.neo4jlabs.nams;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

final class LiveEnv {
    private final Map<String, String> values;

    private LiveEnv(Map<String, String> values) {
        this.values = values;
    }

    static LiveEnv load() {
        Map<String, String> merged = new LinkedHashMap<>(System.getenv());
        Path envFile = LiveTestPaths.liveTestsRoot().resolve(".env");
        if (Files.isRegularFile(envFile)) {
            merged.putAll(readEnvFile(envFile));
        }
        return new LiveEnv(merged);
    }

    String require(String name) {
        String value = values.get(name);
        assertThat(value)
            .as("Missing required live-test env %s. Create live-tests/.env from .env.example.", name)
            .isNotBlank();
        return value;
    }

    String optional(String name, String defaultValue) {
        String value = values.get(name);
        return value == null || value.isBlank() ? defaultValue : value;
    }

    String namsApiKey() {
        return require("NAMS_API_KEY");
    }

    String namsWorkspaceId() {
        return require("NAMS_WORKSPACE_ID");
    }

    String namsBaseUrl() {
        return optional("NAMS_BASE_URL", "https://memory.neo4jlabs.com");
    }

    Map<String, String> codexEnvironment() {
        return Map.of("OPENAI_API_KEY", require("OPENAI_API_KEY"));
    }

    Map<String, String> codexEnvironmentWithNams() {
        Map<String, String> environment = new LinkedHashMap<>(codexEnvironment());
        environment.put("NAMS_API_KEY", namsApiKey());
        environment.put("NAMS_WORKSPACE_ID", namsWorkspaceId());
        environment.put("NAMS_BASE_URL", namsBaseUrl());
        return Map.copyOf(environment);
    }

    private static Map<String, String> readEnvFile(Path path) {
        Map<String, String> parsed = new LinkedHashMap<>();
        try {
            int lineNumber = 0;
            for (String rawLine : Files.readAllLines(path)) {
                lineNumber++;
                String line = rawLine.trim();
                if (line.isEmpty() || line.startsWith("#")) {
                    continue;
                }
                int separator = line.indexOf('=');
                assertThat(separator)
                    .as("Invalid .env line at %s line %d", path, lineNumber)
                    .isGreaterThan(0);
                String key = line.substring(0, separator).trim();
                String value = unquote(line.substring(separator + 1).trim());
                parsed.put(key, value);
            }
        } catch (IOException error) {
            throw new AssertionError("Unable to read " + path, error);
        }
        return parsed;
    }

    private static String unquote(String value) {
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            return value.substring(1, value.length() - 1);
        }
        if (value.length() >= 2 && value.startsWith("'") && value.endsWith("'")) {
            return value.substring(1, value.length() - 1);
        }
        return value;
    }
}
