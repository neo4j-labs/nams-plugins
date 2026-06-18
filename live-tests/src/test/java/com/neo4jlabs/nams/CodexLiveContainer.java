package com.neo4jlabs.nams;

import java.nio.file.Path;
import java.util.Map;

import org.testcontainers.containers.BindMode;
import org.testcontainers.containers.Container;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.images.builder.ImageFromDockerfile;

final class CodexLiveContainer implements AutoCloseable {
    private final GenericContainer<?> container;

    private CodexLiveContainer(GenericContainer<?> container) {
        this.container = container;
    }

    static CodexLiveContainer start(ProjectFixture fixture, Map<String, String> environment) {
        Path dist = LiveTestPaths.requiredRepoPath("dist");
        Path distLocal = LiveTestPaths.requiredRepoPath("dist-local");
        ImageFromDockerfile image = new ImageFromDockerfile("nams-hooks-live-codex:install", false)
            .withDockerfile(LiveTestPaths.codexDockerfile());

        GenericContainer<?> container = new GenericContainer<>(image)
            .withFileSystemBind(dist.toString(), "/nams-hooks/dist", BindMode.READ_ONLY)
            .withFileSystemBind(distLocal.toString(), "/nams-hooks/dist-local", BindMode.READ_ONLY)
            .withFileSystemBind(fixture.hostHome().toString(), fixture.containerHome(), BindMode.READ_WRITE)
            .withFileSystemBind(fixture.hostProject().toString(), fixture.containerProject(), BindMode.READ_WRITE)
            .withEnv(environment)
            .withEnv("HOME", fixture.containerHome())
            .withWorkingDirectory(fixture.containerProject());
        container.start();
        return new CodexLiveContainer(container);
    }

    Container.ExecResult exec(String... command) throws Exception {
        return container.execInContainer(command);
    }

    Container.ExecResult shell(String command) throws Exception {
        return exec("bash", "-lc", command);
    }

    @Override
    public void close() {
        container.close();
    }
}
