import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("package metadata uses nams-plugins package and nams-hooks executable", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.name, "@neo4j-labs/nams-plugins");
  assert.deepEqual(packageJson.bin, {
    "nams-hooks": "./dist/bin/cli.js",
  });
});

test("package lock root package matches package metadata", async () => {
  const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));

  assert.equal(packageLock.name, "@neo4j-labs/nams-plugins");
  assert.equal(packageLock.packages[""].name, "@neo4j-labs/nams-plugins");
  assert.deepEqual(packageLock.packages[""].bin, {
    "nams-hooks": "dist/bin/cli.js",
  });
});
