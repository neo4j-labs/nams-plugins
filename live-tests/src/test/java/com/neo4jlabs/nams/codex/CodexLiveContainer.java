package com.neo4jlabs.nams.codex;

import static com.neo4jlabs.nams.ContainerExecResultAssert.assertThat;

import java.nio.file.Path;
import java.util.Map;

import org.testcontainers.containers.BindMode;
import org.testcontainers.containers.Container;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.images.builder.ImageFromDockerfile;

import com.neo4jlabs.nams.LiveTestPaths;
import com.neo4jlabs.nams.ProjectFixture;

class CodexLiveContainer implements AutoCloseable {
    private final GenericContainer<?> container;
    private final String projectDirectory;

    private CodexLiveContainer(GenericContainer<?> container, String projectDirectory) {
        this.container = container;
        this.projectDirectory = projectDirectory;
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
        return new CodexLiveContainer(container, fixture.containerProject());
    }

    Container.ExecResult exec(String... command) throws Exception {
        return container.execInContainer(command);
    }

    Container.ExecResult shell(String command) throws Exception {
        return exec("bash", "-lc", command);
    }

    void assertNamsInstalled() throws Exception {
        assertThat(shell("mkdir -p /tmp/nams-hooks-pack"
            + " && cd /tmp/nams-hooks-pack"
            + " && npm pack /nams-hooks/dist >/tmp/nams-hooks-pack/package.txt"
            + " && npm install -g \"/tmp/nams-hooks-pack/$(cat /tmp/nams-hooks-pack/package.txt)\""
            + " && command -v nams-hooks"))
            .isSuccessful();
    }

    void assertCodexConfigLinked() throws Exception {
        assertThat(shell("ln -s /nams-hooks/dist-local/codex/.codex " + projectDirectory + "/.codex"
            + " && test -L " + projectDirectory + "/.codex"
            + " && test -d " + projectDirectory + "/.codex"))
            .isSuccessful();
    }

    void assertCodexLoggedIn() throws Exception {
        assertThat(shell("printenv OPENAI_API_KEY | codex login --with-api-key"))
            .isSuccessful();
        assertThat(exec("codex", "login", "status"))
            .isSuccessful();
    }

    void assertNamsHooksPreflight() throws Exception {
        assertThat(shell("printf '{\"session_id\":\"preflight\",\"cwd\":\"" + projectDirectory
            + "\"}\\n' | nams-hooks run codex --event SessionStart"))
            .isSuccessful();
    }

    @Override
    public void close() {
        container.close();
    }
}
