package com.neo4jlabs.nams;

import static io.restassured.RestAssured.given;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import io.restassured.http.ContentType;
import io.restassured.path.json.JsonPath;

public class NamsLiveClient {
    private final String baseUrl;
    private final String apiKey;
    private final String workspaceId;

    public NamsLiveClient() {
        this.baseUrl = requireEnv("NAMS_BASE_URL");
        this.apiKey = requireEnv("NAMS_API_KEY");
        this.workspaceId = requireEnv("NAMS_WORKSPACE_ID");
    }

    public static Map<String, String> namsEnvironment() {
        Map<String, String> environment = new LinkedHashMap<>();
        environment.put("NAMS_API_KEY", requireEnv("NAMS_API_KEY"));
        environment.put("NAMS_WORKSPACE_ID", requireEnv("NAMS_WORKSPACE_ID"));
        environment.put("NAMS_BASE_URL", requireEnv("NAMS_BASE_URL"));
        return Map.copyOf(environment);
    }

    public static String requireEnv(String name) {
        String value = System.getenv(name);
        assertThat(value)
            .as("Missing required live-test env %s. Set it in live-tests/.env or the process environment.", name)
            .isNotBlank();
        assertThat(isMavenPlaceholder(value))
            .as("Live-test env %s was not resolved by Maven/Surefire", name)
            .isFalse();
        return value;
    }

    private static boolean isMavenPlaceholder(String value) {
        return value.startsWith("${") && value.endsWith("}");
    }

    public String workspaceId() {
        return workspaceId;
    }

    public List<String> workspaceIds() {
        return given()
            .baseUri(baseUrl)
            .accept(ContentType.JSON)
            .header("Authorization", "Bearer " + apiKey)
            .when()
            .get("/v1/users/me/workspaces")
            .then()
            .statusCode(200)
            .extract()
            .path("workspaces.id");
    }

    public String fetchConversationId(String conversationId) {
        return given()
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
    }

    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> messages(String conversationId) {
        return given()
            .baseUri(baseUrl)
            .accept(ContentType.JSON)
            .header("Authorization", "Bearer " + apiKey)
            .header("X-Workspace-Id", workspaceId)
            .queryParam("limit", 50)
            .when()
            .get("/v1/conversations/{id}/messages", conversationId)
            .then()
            .statusCode(200)
            .extract()
            .path("messages");
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> reasoningTrace(String conversationId) {
        String response = given()
            .baseUri(baseUrl)
            .accept(ContentType.JSON)
            .header("Authorization", "Bearer " + apiKey)
            .header("X-Workspace-Id", workspaceId)
            .when()
            .get("/v1/reasoning/trace/{conversationId}", conversationId)
            .then()
            .statusCode(200)
            .extract()
            .asString();
        return parseReasoningTrace(response);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> parseReasoningTrace(String json) {
        return JsonPath.from(json).getMap("");
    }
}
