#!/usr/bin/env node

import path from "node:path";
import { buildProjectionTarget, root } from "./build-dist-common.mjs";

const outputRoot = path.join(root, "dist-local");
const projections = [
  { kind: "template", platform: "antigravity", from: "templates/local/antigravity", to: "antigravity", renderPackage: false },
  { kind: "template", platform: "claude", from: "templates/local/claude", to: "claude", renderPackage: false },
  { kind: "template", platform: "codex", from: "templates/local/codex", to: "codex", renderPackage: false },
  { kind: "template", platform: "gemini", from: "templates/local/gemini", to: "gemini", renderPackage: false },
  { kind: "opencode", platform: "opencode", from: "templates/local/opencode/.opencode/plugins/nams-hooks.js", to: "opencode/.opencode/plugins/nams-hooks.js", commandMode: "installed" },
];

await buildProjectionTarget(outputRoot, projections);
