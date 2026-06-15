#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(root, "test");
const priorityTests = [
  "test/cli-workspaces.test.ts",
  "test/workspace-use-command.test.ts",
];
const retryableInfrastructureFailurePatterns = [
  /InternalCallbackScope::Close/,
  /Assertion failed: \(env_->execution_async_id\(\)\) == \(0\)/,
  /Cannot find module '.*\/\.build\/tsc\/cli\.js'/,
];

const files = await listTestFiles(testRoot);
const orderedFiles = [
  ...priorityTests.filter((file) => files.includes(file)),
  ...files.filter((file) => !priorityTests.includes(file)),
];

for (const file of orderedFiles) {
  await runTestFile(file);
}

async function listTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTestFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path.relative(root, fullPath));
    }
  }
  return files.sort();
}

async function runTestFile(file) {
  const first = await runCommand(process.execPath, ["--import=tsx", "--test", file]);
  if (first.code === 0) {
    return;
  }
  if (!isRetryableInfrastructureFailure(first.output)) {
    throw new Error(`${file} failed with exit code ${first.code ?? "unknown"}.`);
  }

  console.error(`${file} hit a transient Node test runner failure; rebuilding and retrying once.`);
  const rebuild = await runCommand("npm", ["run", "build"]);
  if (rebuild.code !== 0) {
    throw new Error(`npm run build failed before retrying ${file}.`);
  }
  const second = await runCommand(process.execPath, ["--import=tsx", "--test", file]);
  if (second.code !== 0) {
    throw new Error(`${file} failed with exit code ${second.code ?? "unknown"} after retry.`);
  }
}

function isRetryableInfrastructureFailure(output) {
  return retryableInfrastructureFailurePatterns.some((pattern) => pattern.test(output));
}

async function runCommand(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, output });
    });
  });
}
