package com.neo4jlabs.nams;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.testcontainers.containers.BindMode;
import org.testcontainers.containers.Container;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.images.builder.ImageFromDockerfile;

class CodexContainerSmokeTest {
    private static final Logger LOG = LoggerFactory.getLogger(CodexContainerSmokeTest.class);

    @Test
    void codexUniversalContainerRunsCodexCommandWithMountedArtifacts() throws Exception {
        Path dist = LiveTestPaths.requiredRepoPath("dist");
        Path distLocal = LiveTestPaths.requiredRepoPath("dist-local");
        assumeTrue(
            dockerCliCanReachDaemon(),
            "Docker environment is required for Codex container smoke tests"
        );

        ImageFromDockerfile image = new ImageFromDockerfile("nams-hooks-live-codex:skeleton", false)
            .withDockerfile(LiveTestPaths.codexDockerfile());

        try (GenericContainer<?> container = new GenericContainer<>(image)
            .withFileSystemBind(dist.toString(), "/nams-hooks/dist", BindMode.READ_ONLY)
            .withFileSystemBind(distLocal.toString(), "/nams-hooks/dist-local", BindMode.READ_ONLY)
            .withWorkingDirectory("/workspace")) {
            container.start();

            Container.ExecResult version = container.execInContainer("codex", "--version");
            assertThat(version.getExitCode())
                .as("codex --version stderr=%s", version.getStderr())
                .isZero();
            assertThat(version.getStdout() + version.getStderr()).containsIgnoringCase("codex");

            Container.ExecResult prompt = container.execInContainer(
                "codex",
                "exec",
                "--cd",
                "/workspace",
                "Say hello from nams live tests"
            );

            String output = prompt.getStdout() + prompt.getStderr();
            LOG.info("codex exec exit={}\n{}", prompt.getExitCode(), output);
            assertThat(output)
                .as("codex exec should produce either a model response or an auth/runtime error")
                .isNotBlank();
        }
    }

    private static boolean dockerCliCanReachDaemon() {
        try {
            Process process = new ProcessBuilder("docker", "info")
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start();

            if (!process.waitFor(10, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                return false;
            }
            return process.exitValue() == 0;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }
}
