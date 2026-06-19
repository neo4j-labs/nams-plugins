package com.neo4jlabs.nams.codex;

import java.util.ArrayList;
import java.util.List;

class CodexCli {
    static final String LIVE_TEST_MODEL = "gpt-5.4-mini";
    static final String LIVE_TEST_REASONING_CONFIG = "model_reasoning_effort=low";

    private CodexCli() {
    }

    static Builder withModel(String model) {
        return new Builder().withModel(model);
    }

    static final class Builder {
        private final List<String> arguments = new ArrayList<>();
        private String prompt;

        private Builder() {
        }

        Builder withModel(String model) {
            arguments.add("--model");
            arguments.add(model);
            return this;
        }

        Builder withModelReasoningEffort(String effort) {
            return config("model_reasoning_effort", effort);
        }

        Builder cd(String path) {
            arguments.add("--cd");
            arguments.add(path);
            return this;
        }

        Builder skipGitRepoCheck() {
            arguments.add("--skip-git-repo-check");
            return this;
        }

        Builder enable(String feature) {
            arguments.add("--enable");
            arguments.add(feature);
            return this;
        }

        Builder dangerouslyBypassHookTrust() {
            arguments.add("--dangerously-bypass-hook-trust");
            return this;
        }

        Builder config(String key, String value) {
            arguments.add("--config");
            arguments.add(key + "=" + value);
            return this;
        }

        Builder withApprovalPolicy(String policy) {
            return config("approval_policy", policy);
        }

        Builder sandbox(String sandbox) {
            arguments.add("--sandbox");
            arguments.add(sandbox);
            return this;
        }

        Builder outputLastMessage(String path) {
            arguments.add("--output-last-message");
            arguments.add(path);
            return this;
        }

        Builder prompt(String prompt) {
            this.prompt = prompt;
            return this;
        }

        String[] exec() {
            List<String> command = new ArrayList<>(arguments.size() + 3);
            command.add("codex");
            command.add("exec");
            command.addAll(arguments);
            if (prompt != null) {
                command.add(prompt);
            }
            return command.toArray(String[]::new);
        }
    }
}
