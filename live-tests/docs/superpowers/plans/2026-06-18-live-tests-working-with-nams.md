# Live Tests Working With NAMS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add REST-assured verification that the Codex live prompt created a NAMS conversation in the configured workspace.

**Architecture:** This checkpoint builds on the install checkpoint. The Java harness reads NAMS credentials from `live-tests/.env`, passes them into the Codex container for hook runtime use, parses the generated `.nams/state/codex/session-*.json`, and uses REST-assured to verify the conversation exists over the NAMS REST API.

**Tech Stack:** Java 25, Maven, JUnit Jupiter, AssertJ, Testcontainers Java, REST-assured, Jackson Databind, Codex CLI, generated `dist/`, generated `dist-local/`, NAMS REST API.

---

## Files

- Modify: `live-tests/pom.xml` - Add REST-assured and Jackson test dependencies.
- Modify: `live-tests/src/test/java/com/neo4jlabs/nams/LiveEnv.java` - Add NAMS environment helpers.
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/NamsLiveClient.java` - NAMS REST assertions.
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/CodexSessionState.java` - Parse local session state.
- Modify: `live-tests/src/test/java/com/neo4jlabs/nams/CodexNamsInstallLiveTest.java` - Pass NAMS env and assert conversation exists.

## Task 1: REST Dependencies

**Files:**
- Modify: `live-tests/pom.xml`

- [ ] **Step 1: Add dependency properties**

Add these properties under the existing Maven `<properties>` block:

```xml
<rest.assured.version>5.5.6</rest.assured.version>
<jackson.version>2.20.1</jackson.version>
```

- [ ] **Step 2: Add REST-assured and Jackson dependencies**

Add these dependencies under `<dependencies>`:

```xml
<dependency>
  <groupId>io.rest-assured</groupId>
  <artifactId>rest-assured</artifactId>
  <version>${rest.assured.version}</version>
  <scope>test</scope>
</dependency>
<dependency>
  <groupId>com.fasterxml.jackson.core</groupId>
  <artifactId>jackson-databind</artifactId>
  <version>${jackson.version}</version>
  <scope>test</scope>
</dependency>
```

- [ ] **Step 3: Run existing install test**

Run:

```bash
cd live-tests
mvn test -Dtest=CodexNamsInstallLiveTest
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add live-tests/pom.xml
git commit -m "test: add NAMS live-test REST dependencies" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 2: NAMS Environment Helpers

**Files:**
- Modify: `live-tests/src/test/java/com/neo4jlabs/nams/LiveEnv.java`

- [ ] **Step 1: Add NAMS accessors**

Add these methods to `LiveEnv`:

```java
String optional(String name, String defaultValue) {
    String value = values.get(name);
    return value == null || value.isBlank() ? defaultValue : value;
}

String namsApiKey() {
    return require("NAMS_API_KEY");
}

String namsWorkspaceId() {
    return require("NAMS_WORKSPACE_ID");
}

String namsBaseUrl() {
    return optional("NAMS_BASE_URL", "https://memory.neo4jlabs.com");
}

Map<String, String> codexEnvironmentWithNams() {
    Map<String, String> environment = new LinkedHashMap<>(codexEnvironment());
    environment.put("NAMS_API_KEY", namsApiKey());
    environment.put("NAMS_WORKSPACE_ID", namsWorkspaceId());
    environment.put("NAMS_BASE_URL", namsBaseUrl());
    return Map.copyOf(environment);
}
```

The file already imports `LinkedHashMap`, `Map`, and assertion helpers from the install plan.

- [ ] **Step 2: Run compilation**

Run:

```bash
cd live-tests
mvn test -Dtest=CodexNamsInstallLiveTest
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add live-tests/src/test/java/com/neo4jlabs/nams/LiveEnv.java
git commit -m "test: add NAMS live environment helpers" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 3: NAMS REST Client

**Files:**
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/NamsLiveClient.java`

- [ ] **Step 1: Write REST client**

Create `live-tests/src/test/java/com/neo4jlabs/nams/NamsLiveClient.java`:

```java
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
```

- [ ] **Step 2: Run compilation**

Run:

```bash
cd live-tests
mvn test -Dtest=CodexNamsInstallLiveTest
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add live-tests/src/test/java/com/neo4jlabs/nams/NamsLiveClient.java
git commit -m "test: add NAMS live REST client" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 4: Session State Parser

**Files:**
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/CodexSessionState.java`

- [ ] **Step 1: Write parser**

Create `live-tests/src/test/java/com/neo4jlabs/nams/CodexSessionState.java`:

```java
package com.neo4jlabs.nams;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

final class CodexSessionState {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final String conversationId;

    private CodexSessionState(String conversationId) {
        this.conversationId = conversationId;
    }

    static CodexSessionState readFromHome(Path hostHome) {
        Path stateDir = hostHome.resolve(".nams/state/codex");
        assertThat(stateDir)
            .as("Codex state directory")
            .isDirectory();

        Path latestState;
        try (var files = Files.list(stateDir)) {
            latestState = files
                .filter(path -> path.getFileName().toString().endsWith(".json"))
                .max(Comparator.comparing(CodexSessionState::lastModifiedMillis))
                .orElseThrow(() -> new AssertionError("No Codex session state JSON found in " + stateDir));
        } catch (IOException error) {
            throw new AssertionError("Unable to list Codex state directory " + stateDir, error);
        }

        try {
            JsonNode root = MAPPER.readTree(latestState.toFile());
            JsonNode conversationIdNode = root.get("conversationId");
            assertThat(conversationIdNode)
                .as("conversationId in " + latestState)
                .isNotNull();
            assertThat(conversationIdNode.asText()).isNotBlank();
            return new CodexSessionState(conversationIdNode.asText());
        } catch (IOException error) {
            throw new AssertionError("Unable to parse " + latestState, error);
        }
    }

    String conversationId() {
        return conversationId;
    }

    private static long lastModifiedMillis(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException error) {
            throw new AssertionError("Unable to stat " + path, error);
        }
    }
}
```

- [ ] **Step 2: Run compilation**

Run:

```bash
cd live-tests
mvn test -Dtest=CodexNamsInstallLiveTest
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add live-tests/src/test/java/com/neo4jlabs/nams/CodexSessionState.java
git commit -m "test: parse Codex NAMS session state" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 5: Verify Conversation Creation

**Files:**
- Modify: `live-tests/src/test/java/com/neo4jlabs/nams/CodexNamsInstallLiveTest.java`

- [ ] **Step 1: Update live test to pass NAMS env and verify REST state**

Change the start of the test body in `CodexNamsInstallLiveTest` so it constructs a NAMS client and passes NAMS env into the container:

```java
LiveEnv env = LiveEnv.load();
NamsLiveClient nams = new NamsLiveClient(env);
nams.assertWorkspaceExists();
try (ProjectFixture fixture = ProjectFixture.create("codex");
     CodexLiveContainer codex = CodexLiveContainer.start(fixture, env.codexEnvironmentWithNams())) {
```

At the end of the try block, after asserting the response is not blank, add:

```java
CodexSessionState state = CodexSessionState.readFromHome(fixture.hostHome());
nams.assertConversationExists(state.conversationId());
System.out.printf("Verified NAMS conversation: %s%n", state.conversationId());
```

- [ ] **Step 2: Verify local `.env` has NAMS values**

Open `live-tests/.env` and set:

```dotenv
NAMS_API_KEY=nams_real_key
NAMS_WORKSPACE_ID=real-workspace-id
NAMS_BASE_URL=https://memory.neo4jlabs.com
```

Keep `.env` untracked.

- [ ] **Step 3: Run NAMS live verification**

Run:

```bash
npm run dist
cd live-tests
mvn test -Dtest=CodexNamsInstallLiveTest
```

Expected: PASS. Output includes `Verified NAMS conversation: <uuid>`.

- [ ] **Step 4: Commit**

```bash
git add live-tests/src/test/java/com/neo4jlabs/nams/CodexNamsInstallLiveTest.java
git commit -m "test: verify NAMS conversation from Codex live run" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 6: Checkpoint Verification

**Files:**
- Verify: all files modified in this plan.

- [ ] **Step 1: Run complete Codex live NAMS test**

Run:

```bash
npm run dist
cd live-tests
mvn test -Dtest=CodexNamsInstallLiveTest
```

Expected: PASS.

- [ ] **Step 2: Confirm generated and secret files are ignored**

Run:

```bash
git status --short
```

Expected: `.env`, `target/`, `dist/`, `dist-local/`, `dist-marketplace/`, `.build/`, and temporary fixture directories are not staged or untracked.
