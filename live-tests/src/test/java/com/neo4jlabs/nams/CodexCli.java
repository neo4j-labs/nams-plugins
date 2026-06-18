package com.neo4jlabs.nams;

final class CodexCli {
    static final String LIVE_TEST_MODEL = "gpt-5.4-mini";
    static final String LIVE_TEST_REASONING_CONFIG = "model_reasoning_effort=low";

    private CodexCli() {
    }

    static String[] exec(String... arguments) {
        String[] command = new String[arguments.length + 6];
        command[0] = "codex";
        command[1] = "exec";
        command[2] = "--model";
        command[3] = LIVE_TEST_MODEL;
        command[4] = "--config";
        command[5] = LIVE_TEST_REASONING_CONFIG;
        System.arraycopy(arguments, 0, command, 6, arguments.length);
        return command;
    }
}
