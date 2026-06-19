package com.neo4jlabs.nams;

import java.util.List;
import java.util.Map;
import java.util.Objects;

import org.assertj.core.api.AbstractAssert;
import org.assertj.core.api.Assertions;

public class NamsLiveClientAssert extends AbstractAssert<NamsLiveClientAssert, NamsLiveClient> {
    private NamsLiveClientAssert(NamsLiveClient actual) {
        super(actual, NamsLiveClientAssert.class);
    }

    public static NamsLiveClientAssert assertThat(NamsLiveClient actual) {
        return new NamsLiveClientAssert(actual);
    }

    public NamsLiveClientAssert workspaceExists() {
        isNotNull();
        Assertions.assertThat(actual.workspaceIds())
            .as("NAMS workspaces")
            .contains(actual.workspaceId());
        return this;
    }

    public NamsLiveClientAssert hasConversation(String conversationId) {
        isNotNull();
        Assertions.assertThat(conversationId)
            .as("conversation id")
            .isNotBlank();
        Assertions.assertThat(actual.fetchConversationId(conversationId))
            .as("NAMS conversation")
            .isEqualTo(conversationId);
        return this;
    }

    public NamsLiveClientAssert hasUserAndAssistantMessages(String conversationId, String marker) {
        isNotNull();
        List<Map<String, Object>> messages = actual.messages(conversationId);
        Assertions.assertThat(messages)
            .as("NAMS conversation messages")
            .hasSizeGreaterThanOrEqualTo(2);
        Assertions.assertThat(messages.stream().map(message -> Objects.toString(message.get("role"), "")).toList())
            .as("NAMS message roles")
            .contains("user", "assistant");
        Assertions.assertThat(messages.stream().map(message -> Objects.toString(message.get("content"), "")).toList())
            .as("NAMS message contents")
            .anySatisfy(content -> Assertions.assertThat(content).contains(marker));
        return this;
    }

    public NamsLiveClientAssert hasReasoningStepAndToolCall(String conversationId) {
        isNotNull();
        Map<String, Object> trace = actual.reasoningTrace(conversationId);
        Assertions.assertThat(trace.get("conversationId"))
            .as("NAMS reasoning trace conversationId")
            .isEqualTo(conversationId);
        Assertions.assertThat(listField(trace, "steps"))
            .as("NAMS reasoning trace steps")
            .isNotEmpty();
        Assertions.assertThat(listField(trace, "toolCalls"))
            .as("NAMS reasoning trace tool calls")
            .isNotEmpty();
        return this;
    }

    private static List<?> listField(Map<String, Object> object, String name) {
        Object value = object.get(name);
        Assertions.assertThat(value)
            .as("NAMS reasoning trace %s", name)
            .isInstanceOf(List.class);
        return (List<?>) value;
    }
}
