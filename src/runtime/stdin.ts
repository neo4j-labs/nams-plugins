import process from "node:process";

export async function readJsonPayload(): Promise<Record<string, unknown>> {
  const input = await readStdin();
  if (input.trim() === "") {
    return {};
  }

  const parsed: unknown = JSON.parse(input);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  throw new Error("hook payload must be a JSON object");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
