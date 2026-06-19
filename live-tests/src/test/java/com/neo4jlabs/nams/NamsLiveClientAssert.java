package com.neo4jlabs.nams;

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
}

