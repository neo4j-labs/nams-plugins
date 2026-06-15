#!/usr/bin/env node

import path from "node:path";
import {
  copyRuntime,
  readRootPackageJson,
  resetOutputRoot,
  root,
  writeReleasePackageJson,
} from "./build-dist-common.mjs";

const outputRoot = path.join(root, "dist");

await resetOutputRoot(outputRoot);
await copyRuntime(path.join(outputRoot, "bin"));
await writeReleasePackageJson(await readRootPackageJson(), path.join(outputRoot, "package.json"));
