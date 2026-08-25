import { readFile } from "node:fs/promises";
import path from "node:path";
import { discoverRegularJsonlFiles, normalizeAbsolutePath, } from "../../runtime/replay-files.js";
import { homeDirectory } from "../../runtime/paths.js";
import { firstString, isPlainObject } from "../../runtime/util.js";
export const codexReplayAdapter = {
    platform: "codex",
    discoverTranscripts: () => discoverCodexReplayTranscripts(),
    readTranscript: readCodexReplayTranscript,
};
export async function readCodexReplayTranscript(transcriptPath) {
    const records = [];
    const calls = new Map();
    let sourceSessionId;
    let sourceStartedAt;
    let projectDirectory;
    let sawCwd = false;
    let sawSessionMeta = false;
    let malformedLineCount = 0;
    let unsupportedRecordCount = 0;
    for (const line of (await readFile(transcriptPath, "utf8")).split(/\r?\n/)) {
        if (line.trim() === "")
            continue;
        let raw;
        try {
            raw = JSON.parse(line);
        }
        catch {
            malformedLineCount += 1;
            continue;
        }
        if (!isPlainObject(raw)) {
            unsupportedRecordCount += 1;
            continue;
        }
        const payload = isPlainObject(raw.payload) ? raw.payload : undefined;
        if (!sawCwd && payload !== undefined && Object.hasOwn(payload, "cwd")) {
            sawCwd = true;
            projectDirectory = normalizeAbsolutePath(payload.cwd);
        }
        if (raw.type === "session_meta" && payload !== undefined) {
            sourceSessionId ??= firstString(payload.id, payload.session_id);
            if (!sawSessionMeta) {
                sawSessionMeta = true;
                sourceStartedAt = firstString(payload.timestamp, raw.timestamp);
            }
            continue;
        }
        const item = responseItem(raw);
        if (item === undefined || isCompaction(raw, item)) {
            unsupportedRecordCount += 1;
            continue;
        }
        if (item.type === "message") {
            const role = item.role;
            const content = role === "user" || role === "assistant" ? visibleText(item.content, role).trim() : "";
            if ((role === "user" || role === "assistant") && content !== "") {
                records.push({ kind: "message", role, content });
            }
            else {
                unsupportedRecordCount += 1;
            }
            continue;
        }
        if (item.type === "reasoning" || item.type === "agent_message") {
            unsupportedRecordCount += 1;
            continue;
        }
        const tool = toolFromItem(item);
        if (tool !== undefined) {
            records.push(tool);
            const sourceCallId = firstString(item.call_id, item.id);
            if (sourceCallId !== undefined && isPairableCall(item.type))
                calls.set(sourceCallId, tool);
            continue;
        }
        if (isOutputItem(item.type)) {
            const call = calls.get(firstString(item.call_id) ?? "");
            if (call === undefined) {
                unsupportedRecordCount += 1;
                continue;
            }
            if (Object.hasOwn(item, "output"))
                call.output = item.output;
            if (item.type === "tool_search_output" && Object.hasOwn(item, "tools"))
                call.output = item.tools;
            const status = explicitStatus(item);
            if (status !== undefined)
                applyStatus(call, status);
            continue;
        }
        unsupportedRecordCount += 1;
    }
    return {
        sourceSessionId: sourceSessionId ?? path.basename(transcriptPath, ".jsonl"),
        ...(projectDirectory !== undefined ? { projectDirectory } : {}),
        ...(sourceStartedAt !== undefined ? { sourceStartedAt } : {}),
        records,
        malformedLineCount,
        unsupportedRecordCount,
    };
}
export async function discoverCodexReplayTranscripts(env = process.env) {
    const configured = firstString(env.CODEX_HOME);
    const home = homeDirectory(env);
    if (configured === undefined && home === undefined)
        return [];
    const codexRoot = path.resolve(configured ?? path.join(home, ".codex"));
    return discoverRegularJsonlFiles([
        path.join(codexRoot, "sessions"),
        path.join(codexRoot, "archived_sessions"),
    ]);
}
function toolFromItem(item) {
    const durationMs = finiteNumber(item.duration_ms, item.durationMs);
    if (item.type === "function_call" || item.type === "custom_tool_call") {
        const toolName = firstString(item.name);
        if (toolName === undefined)
            return undefined;
        const rawInput = item.type === "function_call" ? decodeJson(item.arguments) : item.input;
        const namespace = firstString(item.namespace);
        const input = namespace === undefined ? (rawInput ?? {}) : { namespace, input: rawInput ?? {} };
        return makeTool(toolName, input, explicitStatus(item), durationMs);
    }
    if (item.type === "local_shell_call" && isPlainObject(item.action)) {
        return makeTool("local_shell", item.action, explicitStatus(item), durationMs);
    }
    if (item.type === "tool_search_call") {
        return makeTool("tool_search", { execution: item.execution, arguments: item.arguments }, explicitStatus(item), durationMs);
    }
    if (item.type === "web_search_call" && isPlainObject(item.action)) {
        return makeTool("web_search", item.action, explicitStatus(item), durationMs);
    }
    if (item.type === "image_generation_call") {
        const tool = makeTool("image_generation", firstString(item.revised_prompt) === undefined ? {} : { revisedPrompt: firstString(item.revised_prompt) }, explicitStatus(item), durationMs);
        if (Object.hasOwn(item, "result"))
            tool.output = item.result;
        return tool;
    }
    return undefined;
}
function makeTool(toolName, input, status, durationMs) {
    const tool = {
        kind: "tool",
        toolName,
        input,
        ...(status !== undefined ? { status } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        reasoningStep: {
            reasoning: `Codex exposed ${toolName} from the session transcript.`,
            actionTaken: `Ran ${toolName}`,
            ...(status !== undefined ? { result: `Codex transcript recorded status: ${status}.` } : {}),
        },
    };
    return tool;
}
function applyStatus(tool, status) {
    tool.status = status;
    tool.reasoningStep.result = `Codex transcript recorded status: ${status}.`;
}
function explicitStatus(item) {
    const status = firstString(item.status);
    if (status !== undefined)
        return status;
    if (isPlainObject(item.output) && typeof item.output.success === "boolean")
        return item.output.success ? "success" : "error";
    return undefined;
}
function responseItem(raw) {
    if (raw.type === "response_item") {
        if (isPlainObject(raw.item))
            return raw.item;
        if (isPlainObject(raw.payload))
            return raw.payload;
    }
    if (isPlainObject(raw.item) && raw.item.type === "response_item") {
        if (isPlainObject(raw.item.item))
            return raw.item.item;
        if (isPlainObject(raw.item.payload))
            return raw.item.payload;
    }
    return undefined;
}
function visibleText(value, role) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value))
        return "";
    const visibleTypes = role === "user" ? new Set(["input_text", "text"]) : new Set(["output_text", "text"]);
    return value
        .filter(isPlainObject)
        .filter((part) => visibleTypes.has(String(part.type)))
        .map((part) => typeof part.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n");
}
function decodeJson(value) {
    if (typeof value !== "string")
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function isPairableCall(type) {
    return type === "function_call" || type === "custom_tool_call" || type === "tool_search_call";
}
function isOutputItem(type) {
    return type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_search_output";
}
function isCompaction(raw, item) {
    return raw.type === "compact" || raw.type === "compacted" || raw.type === "compacted_summary" || raw.type === "conversation_summary" || item.type === "compaction" || item.type === "compaction_summary" || item.type === "context_compaction";
}
function finiteNumber(...values) {
    return values.find((value) => typeof value === "number" && Number.isFinite(value));
}
