package com.neo4jlabs.nams;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

public class ProjectFixture implements AutoCloseable {
    private final Path hostRoot;
    private final Path hostHome;
    private final Path hostProject;

    private ProjectFixture(Path hostRoot, Path hostHome, Path hostProject) {
        this.hostRoot = hostRoot;
        this.hostHome = hostHome;
        this.hostProject = hostProject;
    }

    public static ProjectFixture create(String platform) {
        try {
            Path root = Files.createTempDirectory("nams-live-" + platform + "-");
            Path home = Files.createDirectories(root.resolve("home"));
            Path project = Files.createDirectories(root.resolve("project"));
            Files.createDirectories(project.resolve(".live-tests"));
            return new ProjectFixture(root, home, project);
        } catch (IOException error) {
            throw new AssertionError("Unable to create live-test fixture", error);
        }
    }

    public Path hostHome() {
        return hostHome;
    }

    public Path hostProject() {
        return hostProject;
    }

    public String containerHome() {
        return "/workspace/home";
    }

    public String containerProject() {
        return "/workspace/project";
    }

    @Override
    public void close() throws IOException {
        deleteRecursively(hostRoot);
    }

    private static void deleteRecursively(Path path) throws IOException {
        if (!Files.exists(path)) {
            return;
        }
        try (var stream = Files.walk(path)) {
            for (Path child : stream.sorted((left, right) -> right.compareTo(left)).toList()) {
                Files.deleteIfExists(child);
            }
        }
    }
}
