#!/usr/bin/env node

import path from "node:path";
import { buildProjectionTarget, root } from "./build-dist-common.mjs";

const outputRoot = path.join(root, "dist-marketplace");
const projections = [
  { kind: "template", platform: "antigravity", from: "templates/marketplace/antigravity/plugins/nams-hooks", to: "antigravity/plugins/nams-hooks", renderPackage: true },
  { kind: "packageJson", platform: "antigravity", to: "antigravity/plugins/nams-hooks/package.json" },
  { kind: "runtime", platform: "antigravity", to: "antigravity/plugins/nams-hooks/bin" },
  { kind: "template", platform: "gemini", from: "templates/marketplace/gemini/gemini-extension.json", to: "gemini-extension.json", renderPackage: false },
  { kind: "template", platform: "gemini", from: "templates/marketplace/gemini/hooks", to: "hooks", renderPackage: false },
  { kind: "template", platform: "gemini", from: "templates/marketplace/gemini/commands", to: "commands", renderPackage: false },
  { kind: "packageJson", platform: "gemini", to: "plugins/gemini-nams-hooks/package.json" },
  { kind: "runtime", platform: "gemini", to: "plugins/gemini-nams-hooks/bin" },
  { kind: "template", platform: "claude", from: "templates/marketplace/claude/.claude-plugin", to: ".claude-plugin", renderPackage: true },
  { kind: "template", platform: "claude", from: "templates/marketplace/claude/plugins/claude-nams-hooks", to: "plugins/claude-nams-hooks", renderPackage: true },
  { kind: "packageJson", platform: "claude", to: "plugins/claude-nams-hooks/package.json" },
  { kind: "runtime", platform: "claude", to: "plugins/claude-nams-hooks/bin" },
  { kind: "template", platform: "codex", from: "templates/marketplace/codex/.agents", to: ".agents", renderPackage: true },
  { kind: "template", platform: "codex", from: "templates/marketplace/codex/plugins/codex-nams-hooks", to: "plugins/codex-nams-hooks", renderPackage: true },
  { kind: "packageJson", platform: "codex", to: "plugins/codex-nams-hooks/package.json" },
  { kind: "runtime", platform: "codex", to: "plugins/codex-nams-hooks/bin" },
  { kind: "opencode", platform: "opencode", from: "templates/marketplace/opencode/plugins/opencode-nams-hooks/nams-hooks.js", to: "plugins/opencode-nams-hooks/nams-hooks.js", commandMode: "bundled" },
  { kind: "packageJson", platform: "opencode", to: "plugins/opencode-nams-hooks/package.json" },
  { kind: "runtime", platform: "opencode", to: "plugins/opencode-nams-hooks/bin" },
];

await buildProjectionTarget(outputRoot, projections);
