package com.neo4jlabs.nams;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.testcontainers.containers.Container;

class CodexNamsInstallLiveTest {
    private static final Logger LOG = LoggerFactory.getLogger(CodexNamsInstallLiveTest.class);

    @Test
    void installsNamsHooksLinksCodexConfigAndPrintsModelResponse() throws Exception {
        LiveEnv env = LiveEnv.load();
        try (ProjectFixture fixture = ProjectFixture.create("codex");
             CodexLiveContainer codex = CodexLiveContainer.start(fixture, env.codexEnvironment())) {
            assertZero(
                codex.shell("mkdir -p /tmp/nams-hooks-pack"
                    + " && cd /tmp/nams-hooks-pack"
                    + " && npm pack /nams-hooks/dist >/tmp/nams-hooks-pack/package.txt"
                    + " && npm install -g \"/tmp/nams-hooks-pack/$(cat /tmp/nams-hooks-pack/package.txt)\""),
                "npm install -g packed /nams-hooks/dist"
            );
            assertZero(
                codex.shell("ln -s /nams-hooks/dist-local/codex/.codex " + fixture.containerProject() + "/.codex"),
                "link Codex config"
            );
            assertZero(codex.shell("printenv OPENAI_API_KEY | codex login --with-api-key"), "codex login --with-api-key");
            assertZero(codex.exec("codex", "login", "status"), "codex login status");
            assertZero(
                codex.shell("printf '{\"session_id\":\"preflight\",\"cwd\":\"" + fixture.containerProject() + "\"}\\n' | nams-hooks run codex --event SessionStart"),
                "nams-hooks command preflight"
            );

            String marker = "nams-hooks-live codex install " + UUID.randomUUID();
            String answerPath = fixture.containerProject() + "/.live-tests/codex-answer.txt";
            Container.ExecResult result = codex.exec(CodexCli.exec(
                "--cd",
                fixture.containerProject(),
                "--skip-git-repo-check",
                "--enable",
                "hooks",
                "--dangerously-bypass-hook-trust",
                "--config",
                "approval_policy=never",
                "--sandbox",
                "workspace-write",
                "--output-last-message",
                answerPath,
                "Reply with a short greeting and include this marker: " + marker
            ));
            assertZero(result, "codex exec");

            Path answer = fixture.hostProject().resolve(".live-tests/codex-answer.txt");
            assertThat(answer).isRegularFile();
            String response = Files.readString(answer);
            LOG.info("Codex response:\n{}", response);
            assertThat(response).isNotBlank().contains(marker);
        }
    }

    private static void assertZero(Container.ExecResult result, String command) {
        assertThat(result.getExitCode())
            .as("%s%nstdout:%n%s%nstderr:%n%s", command, result.getStdout(), result.getStderr())
            .isZero();
    }
}
