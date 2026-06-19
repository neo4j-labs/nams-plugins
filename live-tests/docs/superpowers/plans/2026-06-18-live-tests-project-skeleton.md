# Live Tests Project Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `live-tests/` Maven skeleton on Java 25 and prove Testcontainers can start the Codex universal container with generated `dist/` and `dist-local/` mounted read-only.

**Architecture:** This checkpoint creates only the Java/Maven test harness and a Codex container smoke test. It does not install `nams-hooks`, read `.env`, require platform keys, or assert NAMS behavior yet. The Codex prompt command is allowed to fail because this checkpoint validates container orchestration, artifact mounts, and CLI reachability.

**Tech Stack:** Java 25, Maven, JUnit Jupiter, AssertJ, Testcontainers Java, Docker, `ghcr.io/openai/codex-universal`.

---

## Files

- Create: `live-tests/pom.xml` - Maven project metadata and test dependencies.
- Create: `live-tests/.gitignore` - Ignore Maven output and local env files.
- Create: `live-tests/docker/codex/Dockerfile` - Codex universal image wrapper.
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/LiveTestPaths.java` - Resolve repo root and required generated artifacts.
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/CodexContainerSmokeTest.java` - Testcontainers smoke test.

## Task 1: Maven Project Skeleton

**Files:**
- Create: `live-tests/pom.xml`
- Create: `live-tests/.gitignore`

- [ ] **Step 1: Create Maven project file**

Create `live-tests/pom.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <groupId>com.neo4jlabs.nams</groupId>
  <artifactId>nams-hooks-live-tests</artifactId>
  <version>0.1.0-SNAPSHOT</version>
  <packaging>jar</packaging>

  <properties>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <maven.compiler.release>25</maven.compiler.release>
    <junit.jupiter.version>6.0.1</junit.jupiter.version>
    <assertj.version>3.27.6</assertj.version>
    <testcontainers.version>2.0.5</testcontainers.version>
    <maven.surefire.version>3.5.4</maven.surefire.version>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>${junit.jupiter.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.assertj</groupId>
      <artifactId>assertj-core</artifactId>
      <version>${assertj.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.testcontainers</groupId>
      <artifactId>testcontainers</artifactId>
      <version>${testcontainers.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.testcontainers</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>${testcontainers.version}</version>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>${maven.surefire.version}</version>
        <configuration>
          <useModulePath>false</useModulePath>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
```

- [ ] **Step 2: Add local ignores**

Create `live-tests/.gitignore`:

```gitignore
target/
.env
```

- [ ] **Step 3: Run Maven with no tests**

Run:

```bash
cd live-tests
mvn test
```

Expected: build succeeds and reports no tests or zero test failures.

- [ ] **Step 4: Commit**

```bash
git add live-tests/pom.xml live-tests/.gitignore
git commit -m "test: add live-tests Maven skeleton" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 2: Codex Container Image

**Files:**
- Create: `live-tests/docker/codex/Dockerfile`

- [ ] **Step 1: Create Codex Dockerfile**

Create `live-tests/docker/codex/Dockerfile`:

```dockerfile
FROM ghcr.io/openai/codex-universal:latest

WORKDIR /workspace

RUN node --version \
  && npm --version \
  && codex --version
```

- [ ] **Step 2: Build image manually once**

Run:

```bash
cd live-tests
docker build -t nams-hooks-live-codex:local docker/codex
```

Expected: Docker build succeeds and prints Node, npm, and Codex versions.

- [ ] **Step 3: Commit**

```bash
git add live-tests/docker/codex/Dockerfile
git commit -m "test: add Codex live-test container image" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 3: Artifact Path Helper

**Files:**
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/LiveTestPaths.java`

- [ ] **Step 1: Write path helper**

Create `live-tests/src/test/java/com/neo4jlabs/nams/LiveTestPaths.java`:

```java
package com.neo4jlabs.nams;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;

final class LiveTestPaths {
    private LiveTestPaths() {
    }

    static Path liveTestsRoot() {
        return Path.of("").toAbsolutePath().normalize();
    }

    static Path repoRoot() {
        return liveTestsRoot().getParent();
    }

    static Path requiredRepoPath(String relativePath) {
        Path path = repoRoot().resolve(relativePath).normalize();
        assertThat(Files.exists(path))
            .as("Expected repo artifact %s to exist. Run `npm run dist` before live tests.", relativePath)
            .isTrue();
        return path;
    }

    static Path codexDockerfile() {
        Path path = liveTestsRoot().resolve("docker/codex/Dockerfile").normalize();
        assertThat(Files.isRegularFile(path))
            .as("Codex Dockerfile must exist")
            .isTrue();
        return path;
    }
}
```

- [ ] **Step 2: Run compilation**

Run:

```bash
cd live-tests
mvn test
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add live-tests/src/test/java/com/neo4jlabs/nams/LiveTestPaths.java
git commit -m "test: add live-test path helpers" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 4: Codex Container Smoke Test

**Files:**
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/CodexContainerSmokeTest.java`

- [ ] **Step 1: Build generated artifacts**

Run from the repository root:

```bash
npm run dist
```

Expected: `dist/`, `dist-local/`, and `dist-marketplace/` are generated. This plan uses `dist/` and `dist-local/`.

- [ ] **Step 2: Write Codex smoke test**

Create `live-tests/src/test/java/com/neo4jlabs/nams/CodexContainerSmokeTest.java`:

```java
package com.neo4jlabs.nams;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.testcontainers.containers.BindMode;
import org.testcontainers.containers.Container;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.images.builder.ImageFromDockerfile;

class CodexContainerSmokeTest {
    @Test
    void codexUniversalContainerRunsCodexCommandWithMountedArtifacts() throws Exception {
        Path dist = LiveTestPaths.requiredRepoPath("dist");
        Path distLocal = LiveTestPaths.requiredRepoPath("dist-local");

        ImageFromDockerfile image = new ImageFromDockerfile("nams-hooks-live-codex:skeleton", false)
            .withDockerfile(LiveTestPaths.codexDockerfile());

        try (GenericContainer<?> container = new GenericContainer<>(image)
            .withFileSystemBind(dist.toString(), "/nams-hooks/dist", BindMode.READ_ONLY)
            .withFileSystemBind(distLocal.toString(), "/nams-hooks/dist-local", BindMode.READ_ONLY)
            .withWorkingDirectory("/workspace")) {
            container.start();

            Container.ExecResult version = container.execInContainer("codex", "--version");
            assertThat(version.getExitCode())
                .as("codex --version stderr=%s", version.getStderr())
                .isZero();
            assertThat(version.getStdout() + version.getStderr()).containsIgnoringCase("codex");

            Container.ExecResult prompt = container.execInContainer(
                "codex",
                "exec",
                "--cd",
                "/workspace",
                "Say hello from nams live tests"
            );

            String output = prompt.getStdout() + prompt.getStderr();
            System.out.printf("codex exec exit=%d%n%s%n", prompt.getExitCode(), output);
            assertThat(output)
                .as("codex exec should produce either a model response or an auth/runtime error")
                .isNotBlank();
        }
    }
}
```

- [ ] **Step 3: Run smoke test**

Run:

```bash
cd live-tests
mvn test -Dtest=CodexContainerSmokeTest
```

Expected: PASS. The `codex exec` process may exit non-zero without keys, but the test passes when the command runs and prints either a response or an auth/runtime error.

- [ ] **Step 4: Commit**

```bash
git add live-tests/src/test/java/com/neo4jlabs/nams/CodexContainerSmokeTest.java
git commit -m "test: smoke test Codex container" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 5: Checkpoint Verification

**Files:**
- Verify: all files created in this plan.

- [ ] **Step 1: Run package generation**

Run from repository root:

```bash
npm run dist
```

Expected: generated artifacts exist.

- [ ] **Step 2: Run Maven live skeleton**

Run:

```bash
cd live-tests
mvn test -Dtest=CodexContainerSmokeTest
```

Expected: PASS.

- [ ] **Step 3: Check working tree**

Run:

```bash
git status --short
```

Expected: no generated `dist/`, `dist-local/`, `.build/`, `target/`, or `.env` files are staged or untracked.
