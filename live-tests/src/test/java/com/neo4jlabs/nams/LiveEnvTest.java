package com.neo4jlabs.nams;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class LiveEnvTest {
    @TempDir
    private Path tempDir;

    @Test
    void malformedEnvLineFailureDoesNotRevealLineContents() throws Throwable {
        Path envFile = tempDir.resolve(".env");
        String secret = "secret-value-should-not-appear";
        Files.writeString(envFile, "OPENAI_API_KEY " + secret + "\n");

        assertThatThrownBy(() -> readEnvFile(envFile))
            .isInstanceOf(AssertionError.class)
            .hasMessageContaining(".env")
            .hasMessageNotContaining(secret)
            .hasMessageNotContaining("OPENAI_API_KEY " + secret)
            .hasMessageContaining(envFile.toString())
            .hasMessageContaining("line 1");
    }

    private static void readEnvFile(Path path) throws Throwable {
        Method method = LiveEnv.class.getDeclaredMethod("readEnvFile", Path.class);
        method.setAccessible(true);
        try {
            method.invoke(null, path);
        } catch (InvocationTargetException error) {
            throw error.getCause();
        }
    }
}
