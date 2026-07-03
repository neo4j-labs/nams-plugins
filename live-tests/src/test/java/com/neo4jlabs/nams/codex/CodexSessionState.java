package com.neo4jlabs.nams.codex;

import static org.assertj.core.api.Assertions.assertThat;

import io.restassured.path.json.JsonPath;
import io.restassured.path.json.exception.JsonPathException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

class CodexSessionState {
    private final String conversationId;

    private CodexSessionState(String conversationId) {
        this.conversationId = conversationId;
    }

    static CodexSessionState readFromHome(Path hostHome) {
        Path stateDir = hostHome.resolve(".nams/state/codex");
        assertThat(stateDir)
            .as("Codex state directory")
            .isDirectory();

        Path latestState;
        try (var files = Files.list(stateDir)) {
            latestState = files
                .filter(path -> path.getFileName().toString().endsWith(".json"))
                .max(Comparator.comparing(CodexSessionState::lastModifiedMillis))
                .orElseThrow(() -> new AssertionError("No Codex session state JSON found in " + stateDir));
        } catch (IOException error) {
            throw new AssertionError("Unable to list Codex state directory " + stateDir, error);
        }

        try {
            String conversationId = JsonPath.from(Files.readString(latestState)).getString("conversationId");
            assertThat(conversationId)
                .as("conversationId in " + latestState)
                .isNotBlank();
            return new CodexSessionState(conversationId);
        } catch (IOException | JsonPathException error) {
            throw new AssertionError("Unable to parse " + latestState, error);
        }
    }

    String conversationId() {
        return conversationId;
    }

    private static long lastModifiedMillis(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException error) {
            throw new AssertionError("Unable to stat " + path, error);
        }
    }
}
