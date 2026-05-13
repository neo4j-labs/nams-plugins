import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const generatedClientPath = path.join(root, "dist", "bin", "generated", "nams-client.js");

await access(generatedClientPath);

const source = await readFile(generatedClientPath, "utf8");
if (/nams-openapi|readFile/.test(source)) {
  throw new Error("dist/bin/generated/nams-client.js must not read OpenAPI at runtime.");
}

const distFiles = await listFiles(distDir);
const openApiArtifacts = distFiles.filter((file) => /openapi|nams-openapi/i.test(file));
if (openApiArtifacts.length > 0) {
  throw new Error(`dist must not include runtime OpenAPI artifacts: ${openApiArtifacts.join(", ")}`);
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}
