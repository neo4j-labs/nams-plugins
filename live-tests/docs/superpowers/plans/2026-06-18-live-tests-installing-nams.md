# Live Tests Installing NAMS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install generated `dist/` inside the Codex container, link generated `dist-local/codex/.codex` into a disposable project, load secrets from `live-tests/.env`, and run a real Codex prompt that prints the model response.

**Architecture:** This checkpoint builds on the project skeleton. The Java harness reads `live-tests/.env`, starts the Codex container with a host-mounted HOME and project directory, installs the generated npm package globally, symlinks the generated local Codex config, logs into Codex with `OPENAI_API_KEY`, and runs `codex exec` with hook trust bypass for this isolated smoke test.

**Tech Stack:** Java 25, Maven, JUnit Jupiter, AssertJ, Testcontainers Java, Codex CLI, generated `dist/`, generated `dist-local/`.

---

## Files

- Modify: `live-tests/.gitignore` - Keep `.env` ignored.
- Create: `live-tests/.env.example` - Document required local inputs for this checkpoint.
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/LiveEnv.java` - Parse `.env` and system environment.
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/ProjectFixture.java` - Host temp HOME/project directories.
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/CodexLiveContainer.java` - Codex container wrapper.
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/CodexNamsInstallLiveTest.java` - Install and prompt smoke test.

## Task 1: Local Environment File

**Files:**
- Modify: `live-tests/.gitignore`
- Create: `live-tests/.env.example`

- [ ] **Step 1: Ensure `.env` is ignored**

Update `live-tests/.gitignore`:

```gitignore
target/
.env
```

- [ ] **Step 2: Add example env file**

Create `live-tests/.env.example`:

```dotenv
# Required by the Codex live install smoke test.
OPENAI_API_KEY=sk-proj-example

# Required by the later NAMS verification plan.
NAMS_API_KEY=nams_example
NAMS_WORKSPACE_ID=00000000-0000-0000-0000-000000000000
NAMS_BASE_URL=https://memory.neo4jlabs.com
```

- [ ] **Step 3: Commit**

```bash
git add live-tests/.gitignore live-tests/.env.example
git commit -m "test: document live-test environment" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 2: Env Loader

**Files:**
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/LiveEnv.java`

- [ ] **Step 1: Write env loader**

Create `live-tests/src/test/java/com/neo4jlabs/nams/LiveEnv.java`:

```java
package com.neo4jlabs.nams;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

final class LiveEnv {
    private final Map<String, String> values;

    private LiveEnv(Map<String, String> values) {
        this.values = values;
    }

    static LiveEnv load() {
        Map<String, String> merged = new LinkedHashMap<>(System.getenv());
        Path envFile = LiveTestPaths.liveTestsRoot().resolve(".env");
        if (Files.isRegularFile(envFile)) {
            merged.putAll(readEnvFile(envFile));
        }
        return new LiveEnv(merged);
    }

    String require(String name) {
        String value = values.get(name);
        assertThat(value)
            .as("Missing required live-test env %s. Create live-tests/.env from .env.example.", name)
            .isNotBlank();
        return value;
    }

    Map<String, String> codexEnvironment() {
        return Map.of("OPENAI_API_KEY", require("OPENAI_API_KEY"));
    }

    private static Map<String, String> readEnvFile(Path path) {
        Map<String, String> parsed = new LinkedHashMap<>();
        try {
            for (String rawLine : Files.readAllLines(path)) {
                String line = rawLine.trim();
                if (line.isEmpty() || line.startsWith("#")) {
                    continue;
                }
                int separator = line.indexOf('=');
                assertThat(separator)
                    .as("Invalid .env line: %s", rawLine)
                    .isGreaterThan(0);
                String key = line.substring(0, separator).trim();
                String value = unquote(line.substring(separator + 1).trim());
                parsed.put(key, value);
            }
        } catch (IOException error) {
            throw new AssertionError("Unable to read " + path, error);
        }
        return parsed;
    }

    private static String unquote(String value) {
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            return value.substring(1, value.length() - 1);
        }
        if (value.length() >= 2 && value.startsWith("'") && value.endsWith("'")) {
            return value.substring(1, value.length() - 1);
        }
        return value;
    }
}
```

- [ ] **Step 2: Run compilation**

Run:

```bash
cd live-tests
mvn test -Dtest=CodexContainerSmokeTest
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add live-tests/src/test/java/com/neo4jlabs/nams/LiveEnv.java
git commit -m "test: add live-test env loader" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 3: Project Fixture

**Files:**
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/ProjectFixture.java`

- [ ] **Step 1: Write fixture class**

Create `live-tests/src/test/java/com/neo4jlabs/nams/ProjectFixture.java`:

```java
package com.neo4jlabs.nams;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

final class ProjectFixture implements AutoCloseable {
    private final Path hostRoot;
    private final Path hostHome;
    private final Path hostProject;

    private ProjectFixture(Path hostRoot, Path hostHome, Path hostProject) {
        this.hostRoot = hostRoot;
        this.hostHome = hostHome;
        this.hostProject = hostProject;
    }

    static ProjectFixture create(String platform) {
        try {
            Path root = Files.createTempDirectory("nams-live-" + platform + "-");
            Path home = Files.createDirectories(root.resolve("home"));
            Path project = Files.createDirectories(root.resolve("project"));
            Files.createDirectories(project.resolve(".live-tests"));
            return new ProjectFixture(root, home, project);
        } catch (IOException error) {
            throw new AssertionError("Unable to create live-test fixture", error);
        }
    }

    Path hostHome() {
        return hostHome;
    }

    Path hostProject() {
        return hostProject;
    }

    String containerHome() {
        return "/workspace/home";
    }

    String containerProject() {
        return "/workspace/project";
    }

    @Override
    public void close() throws IOException {
        deleteRecursively(hostRoot);
    }

    private static void deleteRecursively(Path path) throws IOException {
        if (!Files.exists(path)) {
            return;
        }
        try (var stream = Files.walk(path)) {
            for (Path child : stream.sorted((left, right) -> right.compareTo(left)).toList()) {
                Files.deleteIfExists(child);
            }
        }
    }
}
```

- [ ] **Step 2: Run compilation**

Run:

```bash
cd live-tests
mvn test -Dtest=CodexContainerSmokeTest
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add live-tests/src/test/java/com/neo4jlabs/nams/ProjectFixture.java
git commit -m "test: add live-test project fixture" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 4: Codex Container Wrapper

**Files:**
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/CodexLiveContainer.java`

- [ ] **Step 1: Write container wrapper**

Create `live-tests/src/test/java/com/neo4jlabs/nams/CodexLiveContainer.java`:

```java
package com.neo4jlabs.nams;

import java.nio.file.Path;
import java.util.Map;

import org.testcontainers.containers.BindMode;
import org.testcontainers.containers.Container;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.images.builder.ImageFromDockerfile;

final class CodexLiveContainer implements AutoCloseable {
    private final GenericContainer<?> container;

    private CodexLiveContainer(GenericContainer<?> container) {
        this.container = container;
    }

    static CodexLiveContainer start(ProjectFixture fixture, Map<String, String> environment) {
        Path dist = LiveTestPaths.requiredRepoPath("dist");
        Path distLocal = LiveTestPaths.requiredRepoPath("dist-local");
        ImageFromDockerfile image = new ImageFromDockerfile("nams-hooks-live-codex:install", false)
            .withDockerfile(LiveTestPaths.codexDockerfile());

        GenericContainer<?> container = new GenericContainer<>(image)
            .withFileSystemBind(dist.toString(), "/nams-hooks/dist", BindMode.READ_ONLY)
            .withFileSystemBind(distLocal.toString(), "/nams-hooks/dist-local", BindMode.READ_ONLY)
            .withFileSystemBind(fixture.hostHome().toString(), fixture.containerHome(), BindMode.READ_WRITE)
            .withFileSystemBind(fixture.hostProject().toString(), fixture.containerProject(), BindMode.READ_WRITE)
            .withEnv(environment)
            .withEnv("HOME", fixture.containerHome())
            .withEnv("NPM_CONFIG_PREFIX", fixture.containerHome() + "/.npm-global")
            .withEnv("PATH", fixture.containerHome() + "/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
            .withWorkingDirectory(fixture.containerProject());
        container.start();
        return new CodexLiveContainer(container);
    }

    Container.ExecResult exec(String... command) throws Exception {
        return container.execInContainer(command);
    }

    Container.ExecResult shell(String command) throws Exception {
        return exec("bash", "-lc", command);
    }

    @Override
    public void close() {
        container.close();
    }
}
```

- [ ] **Step 2: Run compilation**

Run:

```bash
cd live-tests
mvn test -Dtest=CodexContainerSmokeTest
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add live-tests/src/test/java/com/neo4jlabs/nams/CodexLiveContainer.java
git commit -m "test: add Codex live container wrapper" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 5: Install NAMS And Run Codex Prompt

**Files:**
- Create: `live-tests/src/test/java/com/neo4jlabs/nams/CodexNamsInstallLiveTest.java`

- [ ] **Step 1: Write live install test**

Create `live-tests/src/test/java/com/neo4jlabs/nams/CodexNamsInstallLiveTest.java`:

```java
package com.neo4jlabs.nams;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.testcontainers.containers.Container;

class CodexNamsInstallLiveTest {
    @Test
    void installsNamsHooksLinksCodexConfigAndPrintsModelResponse() throws Exception {
        LiveEnv env = LiveEnv.load();
        try (ProjectFixture fixture = ProjectFixture.create("codex");
             CodexLiveContainer codex = CodexLiveContainer.start(fixture, env.codexEnvironment())) {
            assertZero(codex.shell("npm install -g /nams-hooks/dist"), "npm install -g /nams-hooks/dist");
            assertZero(codex.shell("ln -s /nams-hooks/dist-local/codex/.codex " + fixture.containerProject() + "/.codex"), "link Codex config");
            assertZero(codex.shell("printenv OPENAI_API_KEY | codex login --with-api-key"), "codex login");
            assertZero(codex.exec("codex", "login", "status"), "codex login status");
            assertZero(
                codex.shell("printf '{\"session_id\":\"preflight\",\"cwd\":\"" + fixture.containerProject() + "\"}\\n' | nams-hooks run codex --event SessionStart"),
                "nams-hooks command preflight"
            );

            String marker = "nams-hooks-live codex install " + UUID.randomUUID();
            String answerPath = fixture.containerProject() + "/.live-tests/codex-answer.txt";
            Container.ExecResult result = codex.exec(
                "codex",
                "exec",
                "--cd",
                fixture.containerProject(),
                "--enable",
                "hooks",
                "--dangerously-bypass-hook-trust",
                "--ask-for-approval",
                "never",
                "--sandbox",
                "workspace-write",
                "--output-last-message",
                answerPath,
                "Reply with a short greeting and include this marker: " + marker
            );
            assertZero(result, "codex exec");

            Path answer = fixture.hostProject().resolve(".live-tests/codex-answer.txt");
            assertThat(answer).isRegularFile();
            String response = Files.readString(answer);
            System.out.printf("Codex response:%n%s%n", response);
            assertThat(response).isNotBlank();
        }
    }

    private static void assertZero(Container.ExecResult result, String command) {
        assertThat(result.getExitCode())
            .as("%s%nstdout:%n%s%nstderr:%n%s", command, result.getStdout(), result.getStderr())
            .isZero();
    }
}
```

- [ ] **Step 2: Create local `.env`**

Create `live-tests/.env` from `live-tests/.env.example` and set a real `OPENAI_API_KEY`.

Run:

```bash
cp live-tests/.env.example live-tests/.env
```

Edit `live-tests/.env` so `OPENAI_API_KEY` has a real value. Keep `.env` untracked.

- [ ] **Step 3: Generate artifacts**

Run from repository root:

```bash
npm run dist
```

Expected: `dist/` and `dist-local/` exist.

- [ ] **Step 4: Run install live test**

Run:

```bash
cd live-tests
mvn test -Dtest=CodexNamsInstallLiveTest
```

Expected: PASS. The output includes `Codex response:` followed by the model response.

- [ ] **Step 5: Commit**

```bash
git add live-tests/src/test/java/com/neo4jlabs/nams/CodexNamsInstallLiveTest.java
git commit -m "test: install nams-hooks in Codex live test" -m "Co-authored-by: Codex <codex@openai.com>"
```

## Task 6: Checkpoint Verification

**Files:**
- Verify: all files created in this plan.

- [ ] **Step 1: Run package generation**

Run from repository root:

```bash
npm run dist
```

Expected: PASS.

- [ ] **Step 2: Run install checkpoint**

Run:

```bash
cd live-tests
mvn test -Dtest=CodexNamsInstallLiveTest
```

Expected: PASS and prints a Codex model response.

- [ ] **Step 3: Check status**

Run:

```bash
git status --short
```

Expected: `.env`, `target/`, generated artifact directories, and fixture temp directories are not staged or untracked.
