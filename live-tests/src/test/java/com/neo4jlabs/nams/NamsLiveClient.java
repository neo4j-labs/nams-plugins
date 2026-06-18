package com.neo4jlabs.nams;

import static io.restassured.RestAssured.given;
import static org.assertj.core.api.Assertions.assertThat;

import io.restassured.http.ContentType;

final class NamsLiveClient {
    private final String baseUrl;
    private final String apiKey;
    private final String workspaceId;

    NamsLiveClient(LiveEnv env) {
        this.baseUrl = env.namsBaseUrl();
        this.apiKey = env.namsApiKey();
        this.workspaceId = env.namsWorkspaceId();
    }

    void assertWorkspaceExists() {
        String id = given()
            .baseUri(baseUrl)
            .accept(ContentType.JSON)
            .header("Authorization", "Bearer " + apiKey)
            .header("X-Workspace-Id", workspaceId)
            .when()
            .get("/v1/workspace")
            .then()
            .statusCode(200)
            .extract()
            .path("id");
        assertThat(id).isEqualTo(workspaceId);
    }

    void assertConversationExists(String conversationId) {
        String id = given()
            .baseUri(baseUrl)
            .accept(ContentType.JSON)
            .header("Authorization", "Bearer " + apiKey)
            .header("X-Workspace-Id", workspaceId)
            .when()
            .get("/v1/conversations/{id}", conversationId)
            .then()
            .statusCode(200)
            .extract()
            .path("id");
        assertThat(id).isEqualTo(conversationId);
    }
}
