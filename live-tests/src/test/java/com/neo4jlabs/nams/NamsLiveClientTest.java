package com.neo4jlabs.nams;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

class NamsLiveClientTest {
    @Test
    void parsesReasoningTraceWithoutObjectMapperDependency() {
        Map<String, Object> trace = NamsLiveClient.parseReasoningTrace("""
            {
              "conversationId": "conversation-123",
              "steps": [{"id": "step-1"}],
              "toolCalls": [{"toolName": "web"}]
            }
            """);

        assertThat(trace.get("conversationId")).isEqualTo("conversation-123");
        assertThat(trace.get("steps")).isInstanceOf(List.class);
        assertThat(trace.get("toolCalls")).isInstanceOf(List.class);
    }
}
