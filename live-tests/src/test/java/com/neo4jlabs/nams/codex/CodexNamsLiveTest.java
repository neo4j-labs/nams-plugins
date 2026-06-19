package com.neo4jlabs.nams.codex;

import static com.neo4jlabs.nams.NamsLiveClientAssert.assertThat;
import static com.neo4jlabs.nams.ContainerExecResultAssert.assertThat;
import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.testcontainers.containers.Container;

import com.neo4jlabs.nams.NamsLiveClient;
import com.neo4jlabs.nams.ProjectFixture;

class CodexNamsLiveTest {
    private static final Logger LOG = LoggerFactory.getLogger(CodexNamsLiveTest.class);

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

            String marker = "nams-hooks-live codex research " + UUID.randomUUID();
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
                .json()
                .prompt("Research online how to become autonomo in Spain. In the response include this marker: " + marker)
                .exec());
            assertThat(result).isSuccessful();
            logCodexTokenStats(result);

            Path answer = fixture.hostProject().resolve(".live-tests/codex-answer.txt");
            assertThat(answer).isRegularFile();
            String response = Files.readString(answer);
            LOG.info("Codex response:\n{}", response);
            assertThat(response).isNotBlank().contains(marker);

            CodexSessionState state = CodexSessionState.readFromHome(fixture.hostHome());
            assertThat(nams)
                .hasConversation(state.conversationId())
                .hasUserAndAssistantMessages(state.conversationId(), marker)
                .hasReasoningStepAndToolCall(state.conversationId());
            logNamsMessageTokenStats(nams, state.conversationId());
            LOG.info("Verified NAMS conversation: {}", state.conversationId());
        }
    }

    private static Map<String, String> codexEnvironmentWithNams() {
        Map<String, String> environment = new LinkedHashMap<>(NamsLiveClient.namsEnvironment());
        environment.put("OPENAI_API_KEY", NamsLiveClient.requireEnv("OPENAI_API_KEY"));
        return Map.copyOf(environment);
    }

    private static void logCodexTokenStats(Container.ExecResult result) {
        CodexTokenStats.fromJsonl(result.getStdout() + "\n" + result.getStderr())
            .ifPresentOrElse(
                stats -> LOG.info(
                    "Codex token stats: input={}, output={}, cached_input={}",
                    stats.inputTokens(),
                    stats.outputTokens(),
                    stats.cachedInputTokens()
                ),
                () -> LOG.info("Codex token stats unavailable")
            );
    }

    private static void logNamsMessageTokenStats(NamsLiveClient nams, String conversationId) {
        List<Map<String, Object>> messages = nams.messages(conversationId);
        long inputTokens = tokenCountForRole(messages, "user");
        long outputTokens = tokenCountForRole(messages, "assistant");
        if (inputTokens == 0 && outputTokens == 0) {
            LOG.info("NAMS message token stats unavailable");
            return;
        }
        LOG.info("NAMS message token stats: input={}, output={}, total={}", inputTokens, outputTokens, inputTokens + outputTokens);
    }

    private static long tokenCountForRole(List<Map<String, Object>> messages, String role) {
        return messages.stream()
            .filter(message -> role.equals(Objects.toString(message.get("role"), "")))
            .map(message -> message.get("tokenCount"))
            .filter(Number.class::isInstance)
            .map(Number.class::cast)
            .mapToLong(Number::longValue)
            .sum();
    }
}
