import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("opencode plugin template exposes NAMS hook handlers", async () => {
  const source = await readFile(path.join(repoRoot, "templates", "opencode", "plugins", "nams-hooks.js"), "utf8");

  assert.match(source, /export const NamsHooks/);
  assert.match(source, /"chat\.message"/);
  assert.match(source, /"experimental\.chat\.system\.transform"/);
  assert.match(source, /"experimental\.text\.complete"/);
  assert.match(source, /"tool\.execute\.after"/);
  assert.match(source, /session\.created/);
  assert.match(source, /nams-hooks/);
});
