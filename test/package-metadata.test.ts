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

test("package files include npm dist and docs without source templates", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.deepEqual(packageJson.files, [
    "dist/",
    "README.md",
    "INSTALL.md",
    "DEVELOPMENT.md",
  ]);
});

test("package scripts expose split dist targets and umbrella dist", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.scripts["dist:npm"], "npm run build && node scripts/build-dist-npm.mjs");
  assert.equal(packageJson.scripts["dist:marketplace"], "npm run build && node scripts/build-dist-marketplace.mjs");
  assert.equal(packageJson.scripts["dist:local"], "npm run build && node scripts/build-dist-local.mjs");
  assert.equal(packageJson.scripts.dist, "npm run dist:npm && npm run dist:local && npm run dist:marketplace");
  assert.equal(packageJson.scripts["dist:check"], "node scripts/check-dist.mjs");
  assert.equal(packageJson.scripts["package:check"], "npm run check && npm run dist && npm run dist:check");
});

test("package lock root package matches package metadata", async () => {
  const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));

  assert.equal(packageLock.name, "@neo4j-labs/nams-plugins");
  assert.equal(packageLock.packages[""].name, "@neo4j-labs/nams-plugins");
  assert.deepEqual(packageLock.packages[""].bin, {
    "nams-hooks": "dist/bin/cli.js",
  });
});
