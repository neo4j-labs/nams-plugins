import process from "node:process";
export async function readJsonPayload() {
    const input = await readStdin();
    if (input.trim() === "") {
        return {};
    }
    const parsed = JSON.parse(input);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
    }
    throw new Error("hook payload must be a JSON object");
}
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
}
