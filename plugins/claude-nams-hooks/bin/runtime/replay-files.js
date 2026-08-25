import { readdir, stat } from "node:fs/promises";
import path from "node:path";
export async function discoverRegularJsonlFiles(roots) {
    const files = [];
    for (const root of roots) {
        if (!(await isExistingDirectory(root)))
            continue;
        await walk(root, files);
    }
    return files.sort();
}
export function normalizeAbsolutePath(value) {
    if (typeof value !== "string" || value.trim() === "" || !path.isAbsolute(value.trim())) {
        return undefined;
    }
    return path.normalize(value.trim());
}
export function isDirectoryWithinImportRoot(importRoot, candidate) {
    if (!path.isAbsolute(candidate))
        return false;
    const relative = path.relative(path.resolve(importRoot), path.normalize(candidate));
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
async function isExistingDirectory(root) {
    try {
        return (await stat(root)).isDirectory();
    }
    catch (error) {
        if (isNodeError(error, "ENOENT"))
            return false;
        throw error;
    }
}
async function walk(directory, files) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink())
            continue;
        if (entry.isDirectory()) {
            await walk(entryPath, files);
            continue;
        }
        if (entry.isFile() && entry.name.endsWith(".jsonl"))
            files.push(entryPath);
    }
}
function isNodeError(error, code) {
    return error instanceof Error && "code" in error && error.code === code;
}
