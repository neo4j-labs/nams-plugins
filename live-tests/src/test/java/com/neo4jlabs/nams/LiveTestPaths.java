package com.neo4jlabs.nams;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;

final class LiveTestPaths {
    private LiveTestPaths() {
    }

    static Path liveTestsRoot() {
        return Path.of("").toAbsolutePath().normalize();
    }

    static Path repoRoot() {
        return liveTestsRoot().getParent();
    }

    static Path requiredRepoPath(String relativePath) {
        Path path = repoRoot().resolve(relativePath).normalize();
        assertThat(Files.exists(path))
            .as("Expected repo artifact %s to exist. Run `npm run dist` before live tests.", relativePath)
            .isTrue();
        return path;
    }

    static Path codexDockerfile() {
        Path path = liveTestsRoot().resolve("docker/codex/Dockerfile").normalize();
        assertThat(Files.isRegularFile(path))
            .as("Codex Dockerfile must exist")
            .isTrue();
        return path;
    }
}
