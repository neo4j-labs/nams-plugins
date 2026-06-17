import { createHash } from "node:crypto";
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function stableJsonHash(value) {
    return sha256(JSON.stringify(sortJson(value)));
}
function sortJson(value) {
    if (Array.isArray(value)) {
        return value.map(sortJson);
    }
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => compareCodeUnits(left, right))
            .map(([key, nestedValue]) => [key, sortJson(nestedValue)]));
    }
    return value;
}
function compareCodeUnits(left, right) {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}
