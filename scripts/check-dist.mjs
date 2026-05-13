import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedClientPath = path.join(root, "dist", "bin", "generated", "nams-client.js");
const rootPackagePath = path.join(root, "package.json");
const distPackagePath = path.join(root, "dist", "package.json");

await access(generatedClientPath);
await verifyPackageBin(rootPackagePath, root);
await verifyPackageBin(distPackagePath, path.join(root, "dist"));

const source = await readFile(generatedClientPath, "utf8");
if (/nams-openapi|readFile/.test(source)) {
  throw new Error("dist/bin/generated/nams-client.js must not read OpenAPI at runtime.");
}

async function verifyPackageBin(packagePath, packageRoot) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const binPath = packageJson.bin?.["nams-hooks"];
  if (typeof binPath !== "string" || binPath.trim() === "") {
    throw new Error(`${path.relative(root, packagePath)} must define bin.nams-hooks.`);
  }
  await access(path.join(packageRoot, binPath), constants.X_OK);
}
