package com.neo4jlabs.nams;

import org.assertj.core.api.AbstractAssert;
import org.testcontainers.containers.Container;

public class ContainerExecResultAssert extends AbstractAssert<ContainerExecResultAssert, Container.ExecResult> {
    private ContainerExecResultAssert(Container.ExecResult actual) {
        super(actual, ContainerExecResultAssert.class);
    }

    public static ContainerExecResultAssert assertThat(Container.ExecResult actual) {
        return new ContainerExecResultAssert(actual);
    }

    public ContainerExecResultAssert hasExitCode(int expected) {
        isNotNull();
        if (actual.getExitCode() != expected) {
            failWithMessage(
                "Expected exit code to be <%s> but was <%s>.%nstdout:%n%s%nstderr:%n%s",
                expected,
                actual.getExitCode(),
                actual.getStdout(),
                actual.getStderr()
            );
        }
        return this;
    }

    public ContainerExecResultAssert isSuccessful() {
        return hasExitCode(0);
    }
}
