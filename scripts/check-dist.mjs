import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedClientPath = path.join(root, "dist", "bin", "generated", "nams-client.js");

await access(generatedClientPath);

const source = await readFile(generatedClientPath, "utf8");
if (/nams-openapi|readFile/.test(source)) {
  throw new Error("dist/bin/generated/nams-client.js must not read OpenAPI at runtime.");
}
