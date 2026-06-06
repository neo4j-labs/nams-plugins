import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { writeNamsJsonConfig } from "../src/runtime/config-writer.js";

test("writes project .nams/config.json with private file mode", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-config-writer-"));
  try {
    const result = await writeNamsJsonConfig({
      projectDirectory: projectDir,
      scope: "project",
      workspaceId: "workspace-1",
    });

    const configPath = path.join(projectDir, ".nams", "config.json");
    assert.equal(result.path, configPath);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      workspaceId: "workspace-1",
    });
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("preserves existing config keys when writing workspaceId", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-config-writer-"));
  try {
    const configDir = path.join(projectDir, ".nams");
    const configPath = path.join(configDir, "config.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ apiKey: "existing-key", baseUrl: "https://nams.example" }, null, 2)}\n`,
      { mode: 0o600 },
    );

    await writeNamsJsonConfig({
      projectDirectory: projectDir,
      scope: "project",
      workspaceId: "workspace-1",
    });

    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      apiKey: "existing-key",
      baseUrl: "https://nams.example",
      workspaceId: "workspace-1",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("rejects symlinked project config path without changing target", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-config-writer-"));
  try {
    const configDir = path.join(projectDir, ".nams");
    const configPath = path.join(configDir, "config.json");
    const targetPath = path.join(projectDir, "target-config.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(targetPath, `${JSON.stringify({ apiKey: "outside-target" }, null, 2)}\n`, { mode: 0o644 });
    await chmod(targetPath, 0o644);
    await symlink(targetPath, configPath);

    await assert.rejects(
      writeNamsJsonConfig({
        projectDirectory: projectDir,
        scope: "project",
        workspaceId: "workspace-1",
      }),
      /symbolic link/,
    );

    assert.equal(await readFile(targetPath, "utf8"), `${JSON.stringify({ apiKey: "outside-target" }, null, 2)}\n`);
    assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("rejects symlinked project config directory without changing target directory", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "nams-config-writer-"));
  const targetDir = await mkdtemp(path.join(tmpdir(), "nams-config-target-"));
  try {
    const configDir = path.join(projectDir, ".nams");
    await writeFile(path.join(targetDir, "keep.txt"), "keep\n");
    await chmod(targetDir, 0o755);
    await symlink(targetDir, configDir);

    await assert.rejects(
      writeNamsJsonConfig({
        projectDirectory: projectDir,
        scope: "project",
        workspaceId: "workspace-1",
      }),
      /symbolic link/,
    );

    assert.equal(await readFile(path.join(targetDir, "keep.txt"), "utf8"), "keep\n");
    assert.equal((await stat(targetDir)).mode & 0o777, 0o755);
    await assert.rejects(readFile(path.join(targetDir, "config.json"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});
