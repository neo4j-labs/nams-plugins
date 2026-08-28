import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  discoverRegularJsonlFiles,
  isDirectoryWithinImportRoot,
  normalizeAbsolutePath,
} from "../src/runtime/replay-files.js";

test("discovers sorted regular JSONL files without following nested symlinks", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "nams-replay-files-"));
  try {
    const corpus = path.join(fixture, "corpus");
    const linkedRoot = path.join(fixture, "linked-root");
    const outside = path.join(fixture, "outside");
    await mkdir(path.join(corpus, "nested"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(corpus, "z.jsonl"), "{}\n", "utf8");
    await writeFile(path.join(corpus, "nested", "a.jsonl"), "{}\n", "utf8");
    await writeFile(path.join(corpus, "ignore.txt"), "{}\n", "utf8");
    await writeFile(path.join(outside, "linked-file.jsonl"), "{}\n", "utf8");
    await symlink(corpus, linkedRoot, "dir");
    await symlink(path.join(outside, "linked-file.jsonl"), path.join(corpus, "linked.jsonl"), "file");
    await symlink(outside, path.join(corpus, "linked-dir"), "dir");

    assert.deepEqual(await discoverRegularJsonlFiles([linkedRoot]), [
      path.join(linkedRoot, "nested", "a.jsonl"),
      path.join(linkedRoot, "z.jsonl"),
    ]);
    assert.deepEqual(await discoverRegularJsonlFiles([path.join(fixture, "missing")]), []);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("matches the import root and descendants but not string-prefix siblings", () => {
  const root = path.resolve("/workspaces/nams-hooks");
  assert.equal(isDirectoryWithinImportRoot(root, root), true);
  assert.equal(isDirectoryWithinImportRoot(root, path.join(root, "worktrees", "feature")), true);
  assert.equal(isDirectoryWithinImportRoot(root, `${root}-old`), false);
  assert.equal(isDirectoryWithinImportRoot(root, "relative/project"), false);
});

test("normalizes only usable absolute paths", () => {
  assert.equal(normalizeAbsolutePath(" /workspaces/nams-hooks/../nams-hooks "), path.normalize("/workspaces/nams-hooks"));
  assert.equal(normalizeAbsolutePath("relative/project"), undefined);
  assert.equal(normalizeAbsolutePath(""), undefined);
  assert.equal(normalizeAbsolutePath(42), undefined);
});
