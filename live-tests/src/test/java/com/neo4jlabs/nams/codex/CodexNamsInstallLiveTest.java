package com.neo4jlabs.nams.codex;

import static com.neo4jlabs.nams.NamsLiveClientAssert.assertThat;
import static com.neo4jlabs.nams.ContainerExecResultAssert.assertThat;
import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.testcontainers.containers.Container;

import com.neo4jlabs.nams.NamsLiveClient;
import com.neo4jlabs.nams.ProjectFixture;

class CodexNamsInstallLiveTest {
    private static final Logger LOG = LoggerFactory.getLogger(CodexNamsInstallLiveTest.class);

    @Test
    void installsNamsHooksLinksCodexConfigAndPrintsModelResponse() throws Exception {
        NamsLiveClient nams = new NamsLiveClient();
        assertThat(nams).workspaceExists();
        try (ProjectFixture fixture = ProjectFixture.create("codex");
             CodexLiveContainer codex = CodexLiveContainer.start(fixture, codexEnvironmentWithNams())) {
            codex.assertNamsInstalled();
            codex.assertCodexConfigLinked();
            codex.assertCodexLoggedIn();
            codex.assertNamsHooksPreflight();

            String marker = "nams-hooks-live codex install " + UUID.randomUUID();
            String answerPath = fixture.containerProject() + "/.live-tests/codex-answer.txt";
            Container.ExecResult result = codex.exec(CodexCli
                .withModel("gpt-5.4-mini")
                .withModelReasoningEffort("low")
                .cd(fixture.containerProject())
                .skipGitRepoCheck()
                .enable("hooks")
                .dangerouslyBypassHookTrust()
                .withApprovalPolicy("never")
                .sandbox("workspace-write")
                .outputLastMessage(answerPath)
                .prompt("Reply with a short greeting and include this marker: " + marker)
                .exec());
            assertThat(result).isSuccessful();

            Path answer = fixture.hostProject().resolve(".live-tests/codex-answer.txt");
            assertThat(answer).isRegularFile();
            String response = Files.readString(answer);
            LOG.info("Codex response:\n{}", response);
            assertThat(response).isNotBlank().contains(marker);

            CodexSessionState state = CodexSessionState.readFromHome(fixture.hostHome());
            assertThat(nams).hasConversation(state.conversationId());
            LOG.info("Verified NAMS conversation: {}", state.conversationId());
        }
    }

    private static Map<String, String> codexEnvironmentWithNams() {
        Map<String, String> environment = new LinkedHashMap<>(NamsLiveClient.namsEnvironment());
        environment.put("OPENAI_API_KEY", NamsLiveClient.requireEnv("OPENAI_API_KEY"));
        return Map.copyOf(environment);
    }
}
