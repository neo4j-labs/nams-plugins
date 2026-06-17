import { appendFile, chmod, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export async function ensurePrivateDirectory(directoryPath) {
    await mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
}
export async function writePrivateFile(filePath, content) {
    await ensurePrivateDirectory(path.dirname(filePath));
    await writeFile(filePath, content, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    await chmod(filePath, PRIVATE_FILE_MODE);
}
export async function appendPrivateFile(filePath, content) {
    await ensurePrivateDirectory(path.dirname(filePath));
    await appendFile(filePath, content, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    await chmod(filePath, PRIVATE_FILE_MODE);
}
export async function ensurePrivateFileMode(filePath) {
    try {
        const file = await stat(filePath);
        if (file.isFile()) {
            await chmod(filePath, PRIVATE_FILE_MODE);
        }
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return;
        }
        throw error;
    }
}
